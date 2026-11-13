"""Figures, flags and figure-checking. Mirrors frontend/app.js so both sides agree."""

import math
import re

THRESHOLDS = {"occupancy_drop_pts": 3, "delinquency_rate": 0.05, "turn_days": 12}
MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]


def month_long(key: str) -> str:
    y, m = key.split("-")
    return f"{MONTHS[int(m) - 1]} {y}"


def month_name(key: str) -> str:
    return MONTHS[int(key.split("-")[1]) - 1]


def pct(x: float, d: int = 1) -> str:
    return f"{x * 100:.{d}f}%"


def money(x: float) -> str:
    # Match Math.round in frontend/app.js (round half toward +Infinity).
    return f"${int(math.floor(x + 0.5)):,}"


def pts(x: float) -> str:
    return f"{abs(x * 100):.1f}"


def days(x: float) -> str:
    return f"{int(x)} days" if float(x).is_integer() else f"{x:.1f} days"


def property_metrics(p: dict, i: int) -> dict:
    m = p["monthly"][i]
    prev = p["monthly"][i - 1] if i > 0 else None
    return {
        "m": m,
        "occ": m["occupied"] / p["units"],
        "prev_occ": prev["occupied"] / p["units"] if prev else None,
        "delinquency_rate": m["delinquent"] / m["rent_billed"],
        "vacant": p["units"] - m["occupied"],
        "turn": m["avg_turn_days"],
        "prev_turn": prev["avg_turn_days"] if prev else None,
        "noi": m["noi"],
        "prev_noi": prev["noi"] if prev else None,
    }


def flags_for(p: dict, i: int) -> list[dict]:
    k = property_metrics(p, i)
    flags = []
    if k["prev_occ"] is not None and k["prev_occ"] - k["occ"] >= THRESHOLDS["occupancy_drop_pts"] / 100:
        flags.append({
            "kind": "occupancy", "tone": "serious",
            "title": f"Occupancy fell {pts(k['prev_occ'] - k['occ'])} points",
            "detail": f"{pct(k['prev_occ'])} to {pct(k['occ'])}, with {k['vacant']} of {p['units']} units vacant.",
        })
    if k["delinquency_rate"] >= THRESHOLDS["delinquency_rate"]:
        is_latest = i == len(p["monthly"]) - 1
        if is_latest:
            over30 = sum(a["amount"] for a in p["aging"][1:]) / k["m"]["delinquent"]
            detail = f"{money(k['m']['delinquent'])} outstanding, {pct(over30, 0)} of it more than 30 days late."
        else:
            detail = f"{money(k['m']['delinquent'])} outstanding this month."
        flags.append({
            "kind": "delinquency", "tone": "critical",
            "title": f"Unpaid rent is {pct(k['delinquency_rate'])} of billed rent",
            "detail": detail,
        })
    if k["turn"] >= THRESHOLDS["turn_days"]:
        flags.append({
            "kind": "turn", "tone": "warning",
            "title": f"Unit turns are taking {days(k['turn'])}",
            "detail": f"Up from {days(k['prev_turn'])} last month." if k["prev_turn"] is not None else "Above the 12-day target.",
        })
    return flags


def draft_facts(data: dict, p: dict, i: int) -> dict:
    k = property_metrics(p, i)
    months = data["portfolio"]["months"]
    prev_key = months[i - 1] if i > 0 else None
    return {
        "owner_first_name": p["owner"]["contact"].split(" ")[0],
        "owner_company": p["owner"]["name"],
        "property": p["name"],
        "month": month_long(months[i]),
        "prev_month": month_name(prev_key) if prev_key else None,
        "occupancy": pct(k["occ"]),
        "prev_occupancy": pct(k["prev_occ"]) if k["prev_occ"] is not None else None,
        "units_leased": str(k["m"]["occupied"]),
        "units_total": str(p["units"]),
        "units_vacant": str(k["vacant"]),
        "rent_billed": money(k["m"]["rent_billed"]),
        "collected": money(k["m"]["collected"]),
        "unpaid": money(k["m"]["delinquent"]),
        "unpaid_rate": pct(k["delinquency_rate"]),
        "noi": money(k["noi"]),
        "prev_noi": money(k["prev_noi"]) if k["prev_noi"] is not None else None,
        "avg_turn_days": str(k["turn"]),
        "work_orders_opened": str(k["m"]["work_orders_opened"]),
        "work_orders_closed": str(k["m"]["work_orders_closed"]),
        "flags": flags_for(p, i),
    }


FIGURE_RE = re.compile(r"\$?\d[\d,]*(?:\.\d+)?%?")


def normalize(s: str) -> str:
    s = re.sub(r"[$,%]", "", s)
    return re.sub(r"\.0+$", "", s)


def allowed_figures(facts: dict) -> set[str]:
    out = set()
    for key, v in facts.items():
        if key != "flags" and v is not None:
            out.add(normalize(str(v)))
    for f in facts["flags"]:
        out.update(normalize(x) for x in FIGURE_RE.findall(f"{f['title']} {f['detail']}"))
    return out


def check_figures(text: str, allowed: set[str]) -> dict:
    found = [s for s in FIGURE_RE.findall(text) if not re.fullmatch(r"20\d\d", normalize(s))]
    unmatched = [s for s in found if normalize(s) not in allowed]
    return {"total": len(found), "matched": len(found) - len(unmatched), "unmatched": unmatched}


def fallback_draft(facts: dict) -> str:
    """Template draft used when the model is unavailable or fails the figure check."""
    f = facts
    lines = [f"Hi {f['owner_first_name']},", "", f"Here is the {f['month']} update for {f['property']}.", ""]
    occ = f"Occupancy finished the month at {f['occupancy']}, with {f['units_leased']} of {f['units_total']} units leased"
    occ += f" ({f['prev_occupancy']} in {f['prev_month']})." if f["prev_occupancy"] else "."
    lines.append(f"{occ} We billed {f['rent_billed']} in rent and collected {f['collected']}, "
                 f"leaving {f['unpaid']} unpaid ({f['unpaid_rate']} of billed rent).")
    lines.append("")
    noi = f"Net operating income came in at {f['noi']}"
    noi += f", compared with {f['prev_noi']} in {f['prev_month']}." if f["prev_noi"] else "."
    lines.append(f"{noi} Unit turns averaged {f['avg_turn_days']} days, and the team opened "
                 f"{f['work_orders_opened']} work orders and closed {f['work_orders_closed']}.")
    if f["flags"]:
        watch = "; ".join(
            f"{fl['title'][0].lower()}{fl['title'][1:]} ({fl['detail'].rstrip('.')})" for fl in f["flags"])
        lead = "One thing we are watching" if len(f["flags"]) == 1 else "A few things we are watching"
        pron = "it" if len(f["flags"]) == 1 else "them"
        lines += ["", f"{lead}: {watch}. We will share what we are doing about {pron} in next month's update, "
                      "or sooner if anything changes."]
    else:
        lines += ["", "Nothing needs a decision from you this month."]
    lines += ["", "Best regards,", "Your property management team"]
    return "\n".join(lines)
