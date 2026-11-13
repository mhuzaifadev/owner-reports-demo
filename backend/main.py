"""Owner reports demo API.

Endpoints
  GET  /api/health                  liveness + whether a model is configured
  GET  /api/portfolio               the portfolio data (static JSON for the demo)
  POST /api/drafts                  draft an owner update for one property and month
  POST /api/drafts/{draft_id}/approve   approve (optionally edited) text; logs it

Locally also serves the frontend from ../frontend so one uvicorn process is enough:
  uvicorn main:app --host 127.0.0.1 --port 8010
"""

import json
import os
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware

import metrics as mx

BASE = Path(__file__).resolve().parent
load_dotenv(BASE / ".env")

FRONTEND_DIR = Path(os.getenv("FRONTEND_DIR", BASE.parent / "frontend"))
DATA_PATH = Path(os.getenv("DATA_PATH", FRONTEND_DIR / "data" / "portfolio.json"))
APPROVALS_LOG = Path(os.getenv("APPROVALS_LOG", BASE / "approvals.jsonl"))

# Any OpenAI-compatible chat completions API works: Groq, OpenAI, Together, OpenRouter, a local vLLM...
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.groq.com/openai/v1")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "openai/gpt-oss-120b")
LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "20"))

RATE_LIMIT_PER_HOUR = int(os.getenv("RATE_LIMIT_PER_HOUR", "10"))
MAX_DRAFTS_IN_MEMORY = 500
MAX_BODY_BYTES = 16 * 1024

app = FastAPI(title="Owner reports demo API", docs_url=None, redoc_url=None)

DATA = json.loads(DATA_PATH.read_text())
DRAFTS: dict[str, dict] = {}
HITS: dict[str, deque] = defaultdict(deque)

SYSTEM_PROMPT = """You write monthly owner updates for a multifamily property management company.
Write to the owner by first name. Plain text, no markdown, 120 to 180 words, short paragraphs.
Use ONLY the figures in the FACTS JSON and copy each one exactly as written (same $ sign, commas, decimals and %).
Do not calculate, round or invent any number, date or plan. If a fact is null, leave it out.
Cover occupancy, rent billed and collected, unpaid rent, net operating income, unit turns and work orders.
If there are flags, explain each one plainly and say the team will follow up; do not promise specific actions.
End with: "Best regards," on one line and "Your property management team" on the next."""


class DraftRequest(BaseModel):
    property_id: str = Field(max_length=64)
    month: str = Field(pattern=r"^\d{4}-\d{2}$")


class ApproveRequest(BaseModel):
    text: str = Field(min_length=20, max_length=5000)


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > MAX_BODY_BYTES:
                    return JSONResponse({"detail": "Request body too large."}, status_code=413)
            except ValueError:
                return JSONResponse({"detail": "Invalid Content-Length."}, status_code=400)

        if request.method in ("POST", "PUT", "PATCH"):
            body = await request.body()
            if len(body) > MAX_BODY_BYTES:
                return JSONResponse({"detail": "Request body too large."}, status_code=413)

            async def receive():
                return {"type": "http.request", "body": body, "more_body": False}

            request = Request(request.scope, receive)

        return await call_next(request)


app.add_middleware(BodySizeLimitMiddleware)


def client_ip(request: Request) -> str:
    # Nginx sets X-Real-IP; fall back to the socket address.
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "unknown")


def prune_hits(ip: str) -> deque:
    now = time.time()
    q = HITS[ip]
    while q and now - q[0] > 3600:
        q.popleft()
    return q


def rate_limited(ip: str) -> bool:
    return len(prune_hits(ip)) >= RATE_LIMIT_PER_HOUR


def record_hit(ip: str) -> None:
    prune_hits(ip).append(time.time())


def find(property_id: str, month: str) -> tuple[dict, int]:
    p = next((x for x in DATA["properties"] if x["id"] == property_id), None)
    if not p:
        raise HTTPException(404, "Unknown property")
    try:
        i = DATA["portfolio"]["months"].index(month)
    except ValueError:
        raise HTTPException(404, "Unknown month")
    return p, i


async def call_model(facts: dict) -> str:
    payload = {
        "model": LLM_MODEL,
        "temperature": 0.2,
        "max_tokens": 600,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": "FACTS:\n" + json.dumps(facts, indent=2)},
        ],
    }
    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        r = await client.post(
            f"{LLM_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {LLM_API_KEY}"},
            json=payload,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()


@app.get("/api/health")
def health():
    return {"status": "ok", "llm_configured": bool(LLM_API_KEY), "model": LLM_MODEL if LLM_API_KEY else None}


@app.get("/api/portfolio")
def portfolio():
    return DATA


@app.post("/api/drafts")
async def create_draft(body: DraftRequest, request: Request):
    ip = client_ip(request)
    if rate_limited(ip):
        raise HTTPException(429, "Draft limit reached for this hour. Try again later.")

    p, i = find(body.property_id, body.month)
    facts = mx.draft_facts(DATA, p, i)
    allowed = mx.allowed_figures(facts)

    text, source, checks = None, "fallback", None
    if LLM_API_KEY:
        for _ in range(2):  # one retry if the model invents or alters a figure
            try:
                candidate = await call_model(facts)
            except Exception:
                break
            checks = mx.check_figures(candidate, allowed)
            if not checks["unmatched"]:
                text, source = candidate, "ai"
                break
    if text is None:
        text = mx.fallback_draft(facts)
        checks = mx.check_figures(text, allowed)

    draft_id = uuid.uuid4().hex[:12]
    if len(DRAFTS) >= MAX_DRAFTS_IN_MEMORY:
        DRAFTS.pop(next(iter(DRAFTS)))
    DRAFTS[draft_id] = {"property_id": p["id"], "month": body.month, "text": text, "source": source}
    record_hit(ip)

    return {
        "draft_id": draft_id,
        "text": text,
        "source": source,
        "model": LLM_MODEL if source == "ai" else None,
        "checks": checks,
        "flags": facts["flags"],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/api/drafts/{draft_id}/approve")
def approve(draft_id: str, body: ApproveRequest):
    d = DRAFTS.get(draft_id)
    if not d:
        raise HTTPException(404, "Draft not found or expired. Draft it again.")
    p, i = find(d["property_id"], d["month"])
    facts = mx.draft_facts(DATA, p, i)
    checks = mx.check_figures(body.text, mx.allowed_figures(facts))
    if checks["unmatched"]:
        return JSONResponse(
            {"message": "Some figures don't match the data.", "unmatched": checks["unmatched"]},
            status_code=422,
        )

    approved_at = datetime.now(timezone.utc).isoformat()
    record = {
        "draft_id": draft_id, "property_id": p["id"], "month": d["month"], "owner": p["owner"]["name"],
        "source": d["source"], "edited": body.text.strip() != d["text"].strip(),
        "approved_at": approved_at, "text": body.text,
    }
    with APPROVALS_LOG.open("a") as f:
        f.write(json.dumps(record) + "\n")
    return {"draft_id": draft_id, "status": "queued", "approved_at": approved_at}


# Serve the vanilla frontend for local runs (nginx serves these in production).
# Registered last so /api/* routes keep precedence.
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
