"""Generate the demo portfolio (fictional properties, AppFolio-style monthly figures).

Usage: python scripts/generate_data.py  ->  writes frontend/data/portfolio.json

Every name and figure is made up. Three problems are planted on purpose so the
dashboard has something to flag in the report month (October 2026):
  - Juniper Court: occupancy drops about 5.5 points
  - Bluebird Terrace: delinquency climbs past 5% of billed rent
  - Cottonwood Homes: unit turns take longer every month
"""

import json
import random
from pathlib import Path

SEED = 7
MONTHS = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]

PROPERTIES = [
    {
        "id": "aspen-ridge",
        "name": "Aspen Ridge Flats",
        "city": "Denver",
        "type": "Multifamily",
        "units": 48,
        "rent": 1850,
        "owner": {"name": "Meridian Holdings LLC", "contact": "Dana Price"},
        "occupied": [45, 46, 46, 47, 47, 47],
        "delinquency": [0.018, 0.016, 0.019, 0.015, 0.017, 0.014],
        "turn_days": [8, 7, 8, 7, 8, 7],
    },
    {
        "id": "juniper-court",
        "name": "Juniper Court",
        "city": "Lakewood",
        "type": "Multifamily",
        "units": 36,
        "rent": 1625,
        "owner": {"name": "Clearwater Partners", "contact": "Marcus Lee"},
        "occupied": [35, 35, 34, 35, 34, 32],
        "delinquency": [0.021, 0.019, 0.022, 0.020, 0.023, 0.025],
        "turn_days": [9, 8, 9, 10, 9, 11],
    },
    {
        "id": "bluebird-terrace",
        "name": "Bluebird Terrace",
        "city": "Colorado Springs",
        "type": "Multifamily",
        "units": 24,
        "rent": 1390,
        "owner": {"name": "Pikeview Residential", "contact": "Elena Ruiz"},
        "occupied": [23, 23, 23, 22, 23, 23],
        "delinquency": [0.018, 0.021, 0.029, 0.038, 0.051, 0.067],
        "turn_days": [7, 8, 7, 9, 8, 8],
    },
    {
        "id": "cottonwood-homes",
        "name": "Cottonwood Homes",
        "city": "Aurora",
        "type": "Build-to-rent",
        "units": 42,
        "rent": 2275,
        "owner": {"name": "Eastline BTR Fund I", "contact": "Priya Nair"},
        "occupied": [38, 39, 40, 41, 41, 42],
        "delinquency": [0.012, 0.014, 0.011, 0.013, 0.012, 0.015],
        "turn_days": [7, 8, 9, 11, 13, 15],
    },
]


def money(x: float) -> float:
    return round(x, 2)


def build() -> dict:
    rng = random.Random(SEED)
    out = []
    for p in PROPERTIES:
        monthly = []
        for i, month in enumerate(MONTHS):
            occupied = p["occupied"][i]
            billed = occupied * p["rent"]
            delinquent = billed * p["delinquency"][i]
            collected = billed - delinquent
            other_income = billed * rng.uniform(0.025, 0.035)
            potential = p["units"] * p["rent"]
            expenses = potential * rng.uniform(0.41, 0.46)
            turns = rng.randint(1, 3)
            monthly.append(
                {
                    "month": month,
                    "occupied": occupied,
                    "rent_billed": money(billed),
                    "collected": money(collected),
                    "delinquent": money(delinquent),
                    "other_income": money(other_income),
                    "expenses": money(expenses),
                    "noi": money(collected + other_income - expenses),
                    "turns_completed": turns,
                    "avg_turn_days": p["turn_days"][i],
                    "work_orders_opened": rng.randint(4, 14),
                    "work_orders_closed": rng.randint(4, 13),
                }
            )

        # Delinquency by how late it is, for the report month only.
        last = monthly[-1]["delinquent"]
        if p["id"] == "bluebird-terrace":
            split = [0.38, 0.31, 0.19, 0.12]
        else:
            split = [0.72, 0.18, 0.07, 0.03]
        aging = [
            {"bucket": label, "amount": money(last * share)}
            for label, share in zip(["0–30 days", "31–60 days", "61–90 days", "90+ days"], split)
        ]

        out.append(
            {
                "id": p["id"],
                "name": p["name"],
                "city": p["city"],
                "type": p["type"],
                "units": p["units"],
                "avg_rent": p["rent"],
                "owner": p["owner"],
                "monthly": monthly,
                "aging": aging,
            }
        )

    return {
        "portfolio": {
            "name": "Front Range demo portfolio",
            "report_month": MONTHS[-1],
            "months": MONTHS,
            "is_demo": True,
        },
        "properties": out,
    }


if __name__ == "__main__":
    path = Path(__file__).resolve().parent.parent / "frontend" / "data" / "portfolio.json"
    path.write_text(json.dumps(build(), indent=2))
    print(f"Wrote {path}")
