# Owner reports demo: technical plan

A portfolio dashboard and AI-drafted owner updates for multifamily property managers, built on
made-up data. First target is hello management (Levi Weber, Denver); the demo is generic so it
also works for other property-management leads.

**What the viewer sees in 90 seconds:** four properties, three of them flagged, one click to draft
the owner's monthly update, every figure checked against the data, and nothing sent until a
person approves it.

---

## 1. Architecture

```
Browser ── https://owner-reports.mhuzaifa.com
   │
   ├── /              Nginx serves static files (index.html, styles.css, app.js)
   ├── /data/*.json   Nginx serves the demo portfolio (generated once)
   └── /api/*         Nginx proxies to FastAPI on 127.0.0.1:8010
                         │
                         ├── computes figures and flags (metrics.py)
                         ├── calls any OpenAI-compatible model (Groq, OpenAI, ...)
                         ├── checks every figure in the draft against the data
                         └── logs approvals to approvals.jsonl
```

- No build step, no framework, no database. Vanilla HTML/CSS/JS plus one small FastAPI app.
- The page works with no backend at all: if `/api/health` doesn't answer, drafts come from a local
  template and approvals stay in the browser. The demo never breaks on camera.
- The API key lives only in the server's `.env`.

## 2. Files

```
owner-reports-demo/
├── frontend/
│   ├── index.html          page structure, backdrop SVG, sheet, toast
│   ├── styles.css          design tokens, glass layers, responsive rules
│   ├── app.js              data load, metrics, flags, charts, draft + approve flow
│   └── data/portfolio.json generated demo data
├── backend/
│   ├── main.py             API routes, model call, rate limit, approval log
│   ├── metrics.py          figures, flags, figure check, template draft (mirrors app.js)
│   ├── requirements.txt
│   └── .env.example
├── scripts/generate_data.py   writes frontend/data/portfolio.json (seeded, repeatable)
└── deploy/
    ├── nginx.conf
    ├── owner-reports.service  systemd unit
    └── deploy.sh              one-shot server setup
```

## 3. Design system

**Direction:** Apple's Liquid Glass layering with Samsung One UI's layout habits, set against a
Front Range ridge at first light (the client's own landscape). The ridge is the one memorable
element; everything else stays quiet.

| Token | Value | Use |
|---|---|---|
| Sky | `#E9F1F9` | page top |
| Mist | `#F4F2EE` | page body |
| Ridge | `#8EA6BF` | backdrop mountains |
| Ink | `#132131` | text |
| Ink 2 | `#556373` | secondary text |
| Action | `#1F5FD1` | primary buttons, focus ring |
| Series | `#2A78D6` | occupancy line |
| Ordinal ramp | `#86B6EF` `#5598E7` `#2A78D6` `#184F95` | unpaid rent by lateness (validated: monotone, single hue, light end clears 2:1) |
| Status | serious `#C45A2F`, critical `#D03B3B`, warning `#B97800`, good `#0CA30C` | flags only, always with an icon and words |

**Type:** Manrope (400–800) with tabular numbers; falls back to SF Pro on Apple devices.
Large title 36–54px / 800; section titles 21px / 800; body 15px.

**Glass (Apple):**
- Translucent fill (white 72% → 46%), `backdrop-filter: blur(24px) saturate(170%)`.
- A bright 1px inner top edge and a soft-light sheen in the top third of each panel.
- Depth by hierarchy, not one shadow everywhere: slab > panel > row > pill, with radii
  30 / 26 / 16 / pill.
- Bottom sheet for the draft, with a grab handle and a dimmed scrim.
- Solid fallback where `backdrop-filter` isn't supported.

**One UI (Samsung):**
- Large title in the top third of the screen, collapsing into a compact glass pill on scroll.
- Grouped lists: property rows sit inside one panel with rounded selected states. On phones each
  row becomes a stacked item with four labelled figures.
- Thumb reach: on phones the main action ("Draft owner update") is pinned to the bottom.
- Pill controls for the month picker and buttons.

**Quality floor:** keyboard navigation (arrow keys through rows, Enter to select, Esc closes the
sheet, focus trapped in the sheet), visible focus rings, `prefers-reduced-motion` respected,
charts carry text labels so colour never stands alone, responsive from 360px up.

## 4. Screens and components

| Area | What it shows |
|---|---|
| Title area | "Owner reports", portfolio summary, month picker, demo-data note |
| Portfolio totals (one glass slab) | occupancy, unpaid rent %, average unit turn, NOI, each with change from last month |
| Properties | name, city, units, type; occupancy, delinquent %, average turn, NOI; flagged cells show an icon and colour |
| Property detail | flags with plain-language detail; occupancy line (6 months, crosshair tooltip); unpaid rent by lateness (bars, tooltips); six key figures; "Draft owner update" |
| Draft sheet | figure check chip, flag count, editable message, "Redraft", "Approve" (disabled while any figure doesn't match) |
| Approved updates | log of approved messages, newest first |
| Toast | "Approved. Queued for {owner}." |

**Flags (same thresholds in `app.js` and `metrics.py`):**
- Occupancy fell 3 or more points in a month (serious).
- Unpaid rent is 5% or more of billed rent (critical).
- Unit turns average 12 days or more (warning).

The demo data plants one of each: Juniper Court (occupancy), Bluebird Terrace (unpaid rent),
Cottonwood Homes (turn time).

## 5. Data model

`frontend/data/portfolio.json`, shaped like AppFolio's rent roll, delinquency, work order and
income statement reports rolled up by month:

```json
{
  "portfolio": { "name": "...", "report_month": "2026-10", "months": ["2026-05", "..."], "is_demo": true },
  "properties": [{
    "id": "juniper-court", "name": "Juniper Court", "city": "Lakewood", "type": "Multifamily",
    "units": 36, "avg_rent": 1625,
    "owner": { "name": "Clearwater Partners", "contact": "Marcus Lee" },
    "monthly": [{
      "month": "2026-10", "occupied": 32, "rent_billed": 52000, "collected": 50700,
      "delinquent": 1300, "other_income": 1429.18, "expenses": 24510.82, "noi": 27618.36,
      "turns_completed": 1, "avg_turn_days": 11, "work_orders_opened": 5, "work_orders_closed": 13
    }],
    "aging": [{ "bucket": "0–30 days", "amount": 936 }]
  }]
}
```

Regenerate with `python scripts/generate_data.py` (seeded, so the output is the same each time).

## 6. API

All routes are under `/api`. JSON in and out.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness. The page calls this once to decide whether to use the API. |
| GET | `/api/portfolio` | Portfolio data. The demo page reads the static JSON instead; this route is where real AppFolio data plugs in later. |
| POST | `/api/drafts` | Draft an owner update for one property and month. |
| POST | `/api/drafts/{draft_id}/approve` | Approve the (possibly edited) text. Re-checks figures, logs it. |

**GET /api/health**
```json
{ "status": "ok", "llm_configured": true, "model": "openai/gpt-oss-120b" }
```

**POST /api/drafts**
```json
// request
{ "property_id": "juniper-court", "month": "2026-10" }
// response 200
{
  "draft_id": "a1b2c3d4e5f6",
  "text": "Hi Marcus,\n\nHere is the October 2026 update...",
  "source": "ai",                       // "ai" or "fallback" (template)
  "model": "openai/gpt-oss-120b",
  "checks": { "total": 18, "matched": 18, "unmatched": [] },
  "flags": [{ "kind": "occupancy", "tone": "serious", "title": "...", "detail": "..." }],
  "created_at": "2026-11-13T15:09:08Z"
}
```
Errors: `404` unknown property or month, `422` bad input, `429` hourly limit reached.

**POST /api/drafts/{draft_id}/approve**
```json
// request
{ "text": "Hi Marcus, ... (edited text)" }
// response 200
{ "draft_id": "a1b2c3d4e5f6", "status": "queued", "approved_at": "2026-11-13T15:10:02Z" }
```
Errors: `404` draft expired, `422` with `{"unmatched": ["77.7%"]}` if a figure doesn't match the data.
Nothing is emailed in the demo; "queued" means logged to `approvals.jsonl`.

**Model call:** any OpenAI-compatible `POST {LLM_BASE_URL}/chat/completions`. Groq is the default
because it is already set up for the Octane demo; switch provider with three env vars
(`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`).

## 7. How the AI is kept honest

1. Code computes every figure and formats it (`$27,618`, `88.9%`). The model never does arithmetic.
2. The prompt passes those figures as a FACTS object and tells the model to copy them exactly and
   add no numbers, dates or promised actions.
3. After drafting, every number in the text is matched against the allowed set (years ignored).
   One mismatch triggers one retry; a second mismatch falls back to the template draft.
4. The page re-runs the same check live while the user edits. Approve stays disabled until every
   figure matches. The server checks again on approve.
5. Nothing goes to an owner without a person clicking Approve.

This matches the job post's ask for "AI-enabled features with permissions, oversight, error
handling, and human approvals."

## 8. Deployment (about an hour)

1. DNS: add an A record for `owner-reports` pointing at your server's IP.
2. Copy the project to the server and run `sudo ./deploy/deploy.sh owner-reports.mhuzaifa.com`.
3. HTTPS: `sudo certbot --nginx -d owner-reports.mhuzaifa.com`.
4. Put your model key in `/opt/owner-reports/backend/.env`, then `sudo systemctl restart owner-reports`.
5. Check: open the site, draft an update, approve it, and confirm a line lands in `approvals.jsonl`.

## 9. Security and cost guardrails

- API key only in `.env` on the server; never in the page.
- Two rate limits on drafts: Nginx (6 per minute per IP, burst 3) and the app (10 per hour per IP).
- `max_tokens` 600 per draft and a 20-second timeout.
- Set a monthly spending cap in your model provider's dashboard.
- Request bodies capped at 16 KB; input validated by Pydantic; output escaped in the page.
- A "Demo data" note on the page; every name and figure is made up.
- No AppFolio logo or interface copied; the page says "AppFolio-style report exports".

## 10. Build status and remaining time

| Step | Status | Time |
|---|---|---|
| Demo data generator | Done | |
| Frontend (desktop + phone, charts, sheet, checks) | Done, tested in Chrome at 1360px and 390px | |
| Backend (drafts, figure check, retry, fallback, approve, rate limit) | Done, tested without a model key | |
| Deploy files | Done | |
| Deploy to your server | To do | ~1 hour |
| Add model key and test a real AI draft | To do | ~15 min |
| Record the 90-second video | To do | ~45 min |

## 11. Video script (90 seconds)

| Time | Show | Say |
|---|---|---|
| 0–15s | Title area and totals | "Owner reports usually take hours to pull together by hand. Here's a portfolio on made-up data." |
| 15–40s | Properties list, click Juniper Court | "Three properties are flagged this month. Juniper Court lost 5.6 points of occupancy." |
| 40–70s | Draft owner update, then type a wrong number | "One click drafts the owner's update. Every figure is checked against the data; if I type a wrong number, it won't let me approve." |
| 70–85s | Fix it, approve, show the log | "Nothing goes out until someone on your team approves it." |
| 85–90s | Back to the dashboard | "This runs on your AppFolio report exports or API. Want to see it on your real data?" |

## 12. From demo to a paid build

- **Data source:** AppFolio's API is read-only on the Plus plan and read/write on Max; otherwise
  schedule AppFolio's report exports (rent roll, delinquency, work orders, income statement) and
  load them nightly. Ask Levi which plan they're on.
- **New routes:** `POST /api/sync` (pull or import reports), `GET /api/owners/{id}/updates`
  (history), and sending approved updates by email from their domain.
- **Access:** staff login (magic link or Google), roles for who can approve.
- **Storage:** Postgres (or Supabase, which their job post lists) for snapshots, drafts and
  approvals, replacing the JSON file and in-memory drafts.
- **Fixed-scope offer:** $2,500 for this on their real data, about two weeks.
