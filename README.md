# Owner reports demo

Portfolio dashboard and AI-drafted owner updates for multifamily property managers,
built on made-up data. Vanilla HTML/CSS/JS plus a small FastAPI app.

See [PLAN.md](PLAN.md) for architecture, design system, and the 90-second demo script.

## Run locally

```bash
# Optional: regenerate demo data (seeded, repeatable)
python scripts/generate_data.py

cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # optional: set LLM_API_KEY for real AI drafts

uvicorn main:app --host 127.0.0.1 --port 8010
```

Open [http://127.0.0.1:8010](http://127.0.0.1:8010). The API serves the frontend and `/api/*`
from one process. Leave `LLM_API_KEY` empty to use template drafts only.

## Deploy

On a server with DNS pointed at the host:

```bash
sudo ./deploy/deploy.sh owner-reports.mhuzaifa.com
sudo certbot --nginx -d owner-reports.mhuzaifa.com
# put the model key in /opt/owner-reports/backend/.env
sudo systemctl restart owner-reports
```
