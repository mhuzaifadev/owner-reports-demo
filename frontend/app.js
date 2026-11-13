/* Owner reports demo: vanilla JS, no build step.
   Data: data/portfolio.json (static). AI drafts: POST /api/drafts.
   If the API is unreachable, the page falls back to a local sample draft
   so the demo never breaks. */

"use strict";

const API_BASE = "/api";
const LOG_STORAGE_KEY = "owner-reports-approvals";
const THRESHOLDS = {
  occupancyDropPts: 3,     // flag if occupancy falls this many points in a month
  delinquencyRate: 0.05,   // flag if unpaid rent is at least this share of billed rent
  turnDays: 12,            // flag if unit turns average this many days or more
};

const state = {
  data: null,
  monthIndex: 0,
  selectedId: null,
  apiAvailable: false,
  draft: null,         // { id, text, model, figures, source }
  lastTrigger: null,
};

class ApiError extends Error {
  constructor(status, body) {
    super(String(status));
    this.status = status;
    this.body = body || {};
  }
}

/* ---------- Formatting ---------- */

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = MONTHS_LONG.map((m) => m.slice(0, 3));

function monthParts(key) {
  const [y, m] = key.split("-").map(Number);
  return { y, m: m - 1 };
}
const monthLong = (key) => { const { y, m } = monthParts(key); return `${MONTHS_LONG[m]} ${y}`; };
const monthName = (key) => MONTHS_LONG[monthParts(key).m];
const monthShort = (key) => MONTHS_SHORT[monthParts(key).m];

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
// Keep in sync with backend/metrics.py money() (round half toward +Infinity).
const money = (x) => `$${Math.round(x).toLocaleString("en-US")}`;
const pts = (x) => `${Math.abs(x * 100).toFixed(1)}`;
const days = (x) => `${Number.isInteger(x) ? x : x.toFixed(1)} days`;

/* ---------- Metrics ---------- */

function propertyMetrics(p, i) {
  const m = p.monthly[i];
  const prev = i > 0 ? p.monthly[i - 1] : null;
  const occ = m.occupied / p.units;
  const prevOcc = prev ? prev.occupied / p.units : null;
  const delinquencyRate = m.delinquent / m.rent_billed;
  const prevDelinquencyRate = prev ? prev.delinquent / prev.rent_billed : null;
  return {
    m, prev, occ, prevOcc, delinquencyRate, prevDelinquencyRate,
    vacant: p.units - m.occupied,
    turn: m.avg_turn_days,
    prevTurn: prev ? prev.avg_turn_days : null,
    noi: m.noi,
    prevNoi: prev ? prev.noi : null,
  };
}

function portfolioMetrics(props, i) {
  const sum = (fn) => props.reduce((a, p) => a + fn(p), 0);
  const at = (j) => {
    const units = sum((p) => p.units);
    const occupied = sum((p) => p.monthly[j].occupied);
    const billed = sum((p) => p.monthly[j].rent_billed);
    const delinquent = sum((p) => p.monthly[j].delinquent);
    const turns = sum((p) => p.monthly[j].turns_completed);
    const turnWeighted = sum((p) => p.monthly[j].turns_completed * p.monthly[j].avg_turn_days);
    return {
      units, occupied,
      occ: occupied / units,
      delinquencyRate: delinquent / billed,
      delinquent,
      turn: turns ? turnWeighted / turns : 0,
      noi: sum((p) => p.monthly[j].noi),
    };
  };
  return { now: at(i), prev: i > 0 ? at(i - 1) : null };
}

function flagsFor(p, i) {
  const k = propertyMetrics(p, i);
  const flags = [];
  if (k.prevOcc !== null && k.prevOcc - k.occ >= THRESHOLDS.occupancyDropPts / 100) {
    flags.push({
      kind: "occupancy", tone: "serious",
      title: `Occupancy fell ${pts(k.prevOcc - k.occ)} points`,
      detail: `${pct(k.prevOcc)} to ${pct(k.occ)}, with ${k.vacant} of ${p.units} units vacant.`,
    });
  }
  if (k.delinquencyRate >= THRESHOLDS.delinquencyRate) {
    const isLatest = i === p.monthly.length - 1;
    const over30 = isLatest ? p.aging.slice(1).reduce((a, b) => a + b.amount, 0) / k.m.delinquent : null;
    flags.push({
      kind: "delinquency", tone: "critical",
      title: `Unpaid rent is ${pct(k.delinquencyRate)} of billed rent`,
      detail: over30 !== null
        ? `${money(k.m.delinquent)} outstanding, ${pct(over30, 0)} of it more than 30 days late.`
        : `${money(k.m.delinquent)} outstanding this month.`,
    });
  }
  if (k.turn >= THRESHOLDS.turnDays) {
    flags.push({
      kind: "turn", tone: "warning",
      title: `Unit turns are taking ${days(k.turn)}`,
      detail: k.prevTurn !== null ? `Up from ${days(k.prevTurn)} last month.` : "Above the 12-day target.",
    });
  }
  return flags;
}

/* ---------- Icons ---------- */

const ICONS = {
  serious: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10 6v7M6.8 10.2 10 13.4l3.2-3.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  critical: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 2.5h6L17.5 7v6L13 17.5H7L2.5 13V7Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10 6.3v4.6M10 13.6v.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  warning: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.8 18 16.6H2Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10 7.8v4M10 14.3v.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  good: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m6.5 10.3 2.4 2.4 4.6-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  up: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  down: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v8M2.5 6.5 6 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/* ---------- DOM helpers ---------- */

const $ = (sel) => document.querySelector(sel);
const bind = (key, text) => document.querySelectorAll(`[data-bind="${key}"]`).forEach((el) => { el.textContent = text; });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- Render: header & KPIs ---------- */

function renderHeader() {
  const { portfolio, properties } = state.data;
  const units = properties.reduce((a, p) => a + p.units, 0);
  const cities = [...new Set(properties.map((p) => p.city))];
  bind("portfolioSummary", `${properties.length} properties and ${units} units in ${cities.slice(0, -1).join(", ")} and ${cities.at(-1)}`);
  bind("monthLabel", monthLong(portfolio.months[state.monthIndex]));
}

function deltaHtml(now, prev, { kind, betterWhen }) {
  if (prev === null || prev === undefined) return `<span class="kpi-delta">First month in this view</span>`;
  const diff = now - prev;
  if (Math.abs(diff) < 1e-9) return `<span class="kpi-delta">No change from last month</span>`;
  const better = betterWhen === "up" ? diff > 0 : diff < 0;
  const arrow = diff > 0 ? ICONS.up : ICONS.down;
  let text;
  if (kind === "pct") text = `${pts(diff)} pts ${diff > 0 ? "up" : "down"}`;
  else if (kind === "days") text = `${Math.abs(diff).toFixed(1)} days ${diff > 0 ? "longer" : "shorter"}`;
  else text = `${money(Math.abs(diff))} ${diff > 0 ? "up" : "down"}`;
  const tone = better ? "tone-good" : "tone-serious";
  return `<span class="kpi-delta"><span class="${tone}">${arrow}</span>${text}<span class="vs">from last month</span></span>`;
}

function renderKpis() {
  const { now, prev } = portfolioMetrics(state.data.properties, state.monthIndex);
  const items = [
    { label: "Occupancy", value: pct(now.occ), delta: deltaHtml(now.occ, prev?.occ, { kind: "pct", betterWhen: "up" }) },
    { label: "Unpaid rent", value: pct(now.delinquencyRate), delta: deltaHtml(now.delinquencyRate, prev?.delinquencyRate, { kind: "pct", betterWhen: "down" }) },
    { label: "Average unit turn", value: days(Math.round(now.turn * 10) / 10), delta: deltaHtml(now.turn, prev?.turn, { kind: "days", betterWhen: "down" }) },
    { label: "Net operating income", value: money(now.noi), delta: deltaHtml(now.noi, prev?.noi, { kind: "money", betterWhen: "up" }) },
  ];
  $("#kpis").innerHTML = items.map((k) => `
    <div class="kpi">
      <span class="kpi-label">${k.label}</span>
      <span class="kpi-value">${k.value}</span>
      ${k.delta}
    </div>`).join("");
}

/* ---------- Render: property list ---------- */

function cellWithFlag(text, flag) {
  if (!flag) return esc(text);
  return `<span class="cell-flag tone-${flag.tone}" title="${esc(flag.title)}">${ICONS[flag.tone]}<span>${esc(text)}</span><span class="sr-only">, flagged: ${esc(flag.title)}</span></span>`;
}

function renderProperties() {
  const i = state.monthIndex;
  let flagged = 0;
  $("#propertyRows").innerHTML = state.data.properties.map((p) => {
    const k = propertyMetrics(p, i);
    const flags = flagsFor(p, i);
    if (flags.length) flagged += 1;
    const f = (kind) => flags.find((x) => x.kind === kind);
    return `
      <tr tabindex="0" data-id="${p.id}" aria-selected="${p.id === state.selectedId}">
        <td><span class="prop-name">${esc(p.name)}</span><span class="prop-meta">${esc(p.city)}, ${p.units} units, ${esc(p.type.toLowerCase())}</span></td>
        <td class="num" data-label="Occupancy">${cellWithFlag(pct(k.occ), f("occupancy"))}</td>
        <td class="num" data-label="Delinquent">${cellWithFlag(pct(k.delinquencyRate), f("delinquency"))}</td>
        <td class="num" data-label="Avg turn">${cellWithFlag(days(k.turn), f("turn"))}</td>
        <td class="num" data-label="NOI">${money(k.noi)}</td>
      </tr>`;
  }).join("");

  const month = monthName(state.data.portfolio.months[i]);
  bind("flagSummary", flagged === 0
    ? `Everything is on track in ${month}`
    : `${flagged} ${flagged === 1 ? "property needs" : "properties need"} attention in ${month}`);

  document.querySelectorAll("#propertyRows tr").forEach((row) => {
    row.addEventListener("click", () => selectProperty(row.dataset.id));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectProperty(row.dataset.id); }
      if (e.key === "ArrowDown") row.nextElementSibling?.focus();
      if (e.key === "ArrowUp") row.previousElementSibling?.focus();
    });
  });
}

function selectProperty(id) {
  state.selectedId = id;
  document.querySelectorAll("#propertyRows tr").forEach((row) => {
    row.setAttribute("aria-selected", String(row.dataset.id === id));
  });
  renderDetail();
}

/* ---------- Render: detail ---------- */

function currentProperty() {
  return state.data.properties.find((p) => p.id === state.selectedId);
}

function renderDetail() {
  const p = currentProperty();
  const i = state.monthIndex;
  const k = propertyMetrics(p, i);
  const flags = flagsFor(p, i);

  $("#detailName").textContent = p.name;
  bind("detailMeta", `${p.city}, ${p.units} units. Owner: ${p.owner.name}`);

  $("#flagList").innerHTML = flags.length
    ? flags.map((f) => `<li class="flag tone-${f.tone}">${ICONS[f.tone]}<div>${esc(f.title)}<small>${esc(f.detail)}</small></div></li>`).join("")
    : `<li class="flag flag--clear"><span class="tone-good">${ICONS.good}</span><div>Nothing flagged in ${monthName(state.data.portfolio.months[i])}</div></li>`;

  renderOccupancyChart(p, i);
  renderAgingChart(p, i);

  $("#facts").innerHTML = [
    ["Units leased", `${k.m.occupied} of ${p.units}`],
    ["Rent billed", money(k.m.rent_billed)],
    ["Collected", money(k.m.collected)],
    ["Net operating income", money(k.noi)],
    ["Work orders", `${k.m.work_orders_opened} opened, ${k.m.work_orders_closed} closed`],
    ["Average rent", money(p.avg_rent)],
  ].map(([dt, dd]) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`).join("");
}

/* ---------- Charts (hand-built SVG) ---------- */

const tooltip = () => $("#tooltip");

function showTooltip(x, y, html) {
  const t = tooltip();
  t.innerHTML = html;
  t.hidden = false;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
function hideTooltip() { tooltip().hidden = true; }

function renderOccupancyChart(p, i) {
  const host = $("#occupancyChart");
  const months = state.data.portfolio.months;
  const series = p.monthly.map((m) => m.occupied / p.units);
  const W = 440, H = 190, L = 38, R = 48, T = 12, B = 28;
  const minVal = Math.min(...series);
  const lo = Math.min(0.8, Math.floor(minVal * 20) / 20);
  const hi = 1;
  const x = (j) => L + (j * (W - L - R)) / (series.length - 1);
  const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);

  const ticks = [];
  for (let v = lo; v <= hi + 1e-9; v += 0.05) ticks.push(v);

  const grid = ticks.map((v) => `
    <line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>
    <text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`).join("");

  const path = series.map((v, j) => `${j ? "L" : "M"}${x(j).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const xLabels = months.map((mk, j) => `<text x="${x(j)}" y="${H - 8}" text-anchor="middle" class="${j === i ? "label-strong" : ""}">${monthShort(mk)}</text>`).join("");
  const dots = series.map((v, j) => `
    <circle cx="${x(j)}" cy="${y(v)}" r="${j === i ? 5.5 : 4}" fill="var(--series-1)" stroke="#fff" stroke-width="2"/>`).join("");
  const last = series.length - 1;

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Occupancy for ${esc(p.name)} from ${monthLong(months[0])} to ${monthLong(months[last])}: ${series.map((v) => pct(v)).join(", ")}.">
      ${grid}
      <line class="crosshair" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="rgba(19,33,49,.25)" stroke-width="1" visibility="hidden"/>
      <path d="${path}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      <text x="${x(last) + 10}" y="${y(series[last]) + 4}" class="label-strong">${pct(series[last])}</text>
      ${xLabels}
      <rect class="hit" x="${L - 10}" y="0" width="${W - L - R + 20}" height="${H - B}" fill="transparent"/>
    </svg>`;

  const svg = host.querySelector("svg");
  const hit = svg.querySelector(".hit");
  const cross = svg.querySelector(".crosshair");
  const move = (e) => {
    const box = svg.getBoundingClientRect();
    const scale = box.width / W;
    const localX = (e.clientX - box.left) / scale;
    let j = Math.round(((localX - L) / (W - L - R)) * (series.length - 1));
    j = Math.max(0, Math.min(series.length - 1, j));
    cross.setAttribute("x1", x(j)); cross.setAttribute("x2", x(j));
    cross.setAttribute("visibility", "visible");
    const units = p.monthly[j].occupied;
    showTooltip(box.left + x(j) * scale, box.top + y(series[j]) * scale,
      `${pct(series[j])}<span>${monthLong(months[j])}, ${units} of ${p.units} units</span>`);
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTooltip(); });
}

function renderAgingChart(p, i) {
  const host = $("#agingChart");
  const isLatest = i === p.monthly.length - 1;
  if (!isLatest) {
    bind("agingTotal", "");
    host.innerHTML = `<p class="panel-hint">Aging detail is available for the latest month only.</p>`;
    return;
  }
  const rows = p.aging;
  const total = rows.reduce((a, r) => a + r.amount, 0);
  bind("agingTotal", `${money(total)} total`);
  const colors = ["var(--ramp-1)", "var(--ramp-2)", "var(--ramp-3)", "var(--ramp-4)"];
  const W = 440, rowH = 24, gap = 10, L = 84, R = 62;
  const H = rows.length * (rowH + gap) - gap;
  const max = Math.max(...rows.map((r) => r.amount)) || 1;
  const w = (v) => Math.max(2, ((W - L - R) * v) / max);

  const bars = rows.map((r, j) => {
    const top = j * (rowH + gap);
    const bw = w(r.amount);
    const rr = Math.min(4, bw / 2);
    // square at the baseline, 4px rounded at the data end
    const d = `M${L} ${top} H${L + bw - rr} Q${L + bw} ${top} ${L + bw} ${top + rr} V${top + rowH - rr} Q${L + bw} ${top + rowH} ${L + bw - rr} ${top + rowH} H${L} Z`;
    return `
      <g class="bar" data-j="${j}">
        <text x="0" y="${top + rowH / 2 + 4}">${esc(r.bucket)}</text>
        <path d="${d}" fill="${colors[j]}"/>
        <text x="${L + bw + 8}" y="${top + rowH / 2 + 4}" class="label-strong">${money(r.amount)}</text>
        <rect x="0" y="${top - gap / 2}" width="${W}" height="${rowH + gap}" fill="transparent"/>
      </g>`;
  }).join("");

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Unpaid rent by days late: ${rows.map((r) => `${r.bucket} ${money(r.amount)}`).join(", ")}.">
      <line x1="${L}" x2="${L}" y1="-4" y2="${H + 4}" stroke="var(--grid)" stroke-width="1"/>
      ${bars}
    </svg>`;

  host.querySelectorAll(".bar").forEach((g) => {
    const r = rows[Number(g.dataset.j)];
    const hover = (e) => showTooltip(e.clientX, e.clientY, `${money(r.amount)}<span>${esc(r.bucket)} late, ${pct(r.amount / total, 0)} of unpaid rent</span>`);
    g.addEventListener("pointermove", hover);
    g.addEventListener("pointerdown", hover);
    g.addEventListener("pointerleave", hideTooltip);
  });
}

/* ---------- Draft: figures, local fallback, checks ---------- */

function draftFacts(p, i) {
  const k = propertyMetrics(p, i);
  const monthKey = state.data.portfolio.months[i];
  const prevKey = i > 0 ? state.data.portfolio.months[i - 1] : null;
  return {
    owner_first_name: p.owner.contact.split(" ")[0],
    owner_company: p.owner.name,
    property: p.name,
    month: monthLong(monthKey),
    prev_month: prevKey ? monthName(prevKey) : null,
    occupancy: pct(k.occ),
    prev_occupancy: k.prevOcc !== null ? pct(k.prevOcc) : null,
    units_leased: String(k.m.occupied),
    units_total: String(p.units),
    units_vacant: String(k.vacant),
    rent_billed: money(k.m.rent_billed),
    collected: money(k.m.collected),
    unpaid: money(k.m.delinquent),
    unpaid_rate: pct(k.delinquencyRate),
    noi: money(k.noi),
    prev_noi: k.prevNoi !== null ? money(k.prevNoi) : null,
    avg_turn_days: String(k.turn),
    work_orders_opened: String(k.m.work_orders_opened),
    work_orders_closed: String(k.m.work_orders_closed),
    flags: flagsFor(p, i),
  };
}

function figureSet(facts) {
  const set = new Set();
  const add = (v) => { if (v !== null && v !== undefined) set.add(normalizeFigure(String(v))); };
  Object.entries(facts).forEach(([key, v]) => { if (key !== "flags") add(v); });
  facts.flags.forEach((f) => (`${f.title} ${f.detail}`.match(FIGURE_RE) || []).forEach(add));
  return set;
}

const FIGURE_RE = /\$?\d[\d,]*(?:\.\d+)?%?/g;
const normalizeFigure = (s) => s.replace(/[$,%]/g, "").replace(/\.0+$/, "");

function checkFigures(text, allowed) {
  const found = (text.match(FIGURE_RE) || [])
    .map((s) => ({ raw: s, norm: normalizeFigure(s) }))
    .filter(({ norm }) => !/^20\d\d$/.test(norm)); // ignore years
  const unmatched = found.filter(({ norm }) => !allowed.has(norm)).map(({ raw }) => raw);
  return { total: found.length, matched: found.length - unmatched.length, unmatched };
}

function localDraft(facts) {
  const lines = [];
  lines.push(`Hi ${facts.owner_first_name},`, "");
  lines.push(`Here is the ${facts.month} update for ${facts.property}.`, "");

  let occ = `Occupancy finished the month at ${facts.occupancy}, with ${facts.units_leased} of ${facts.units_total} units leased`;
  occ += facts.prev_occupancy ? ` (${facts.prev_occupancy} in ${facts.prev_month}).` : ".";
  lines.push(`${occ} We billed ${facts.rent_billed} in rent and collected ${facts.collected}, leaving ${facts.unpaid} unpaid (${facts.unpaid_rate} of billed rent).`);
  lines.push("");

  let noi = `Net operating income came in at ${facts.noi}`;
  noi += facts.prev_noi ? `, compared with ${facts.prev_noi} in ${facts.prev_month}.` : ".";
  lines.push(`${noi} Unit turns averaged ${facts.avg_turn_days} days, and the team opened ${facts.work_orders_opened} work orders and closed ${facts.work_orders_closed}.`);

  if (facts.flags.length) {
    lines.push("");
    const watch = facts.flags.map((f) => `${f.title.charAt(0).toLowerCase()}${f.title.slice(1)} (${f.detail.replace(/\.$/, "")})`);
    lines.push(`${facts.flags.length === 1 ? "One thing we are watching" : "A few things we are watching"}: ${watch.join("; ")}. We will share what we are doing about ${facts.flags.length === 1 ? "it" : "them"} in next month's update, or sooner if anything changes.`);
  } else {
    lines.push("", "Nothing needs a decision from you this month.");
  }
  lines.push("", "Best regards,", "Your property management team");
  return lines.join("\n");
}

async function apiFetch(path, body, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let payload = null;
    const raw = await res.text();
    if (raw) {
      try { payload = JSON.parse(raw); } catch { payload = { detail: raw }; }
    }
    if (!res.ok) throw new ApiError(res.status, payload || {});
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function detectApi() {
  if (location.protocol === "file:") return false;
  try {
    const h = await apiFetch("/health", null, 4000);
    return h && h.status === "ok";
  } catch { return false; }
}

/* ---------- Draft sheet ---------- */

function sheetFocusables() {
  return [...$("#sheet").querySelectorAll("button:not([disabled]), textarea:not([disabled])")];
}

function setChecks(extraUnmatched = null) {
  const p = currentProperty();
  const facts = draftFacts(p, state.monthIndex);
  const allowed = figureSet(facts);
  const text = $("#draftText").value;
  const c = checkFigures(text, allowed);
  const unmatched = extraUnmatched && extraUnmatched.length
    ? [...new Set([...c.unmatched, ...extraUnmatched])]
    : c.unmatched;
  const ok = unmatched.length === 0;
  const figChip = ok
    ? `<span class="chip tone-good">${ICONS.good}<span>All ${c.total} figures match the data</span></span>`
    : `<span class="chip tone-critical">${ICONS.critical}<span>${unmatched.length} ${unmatched.length === 1 ? "figure doesn’t" : "figures don’t"} match the data: ${esc(unmatched.slice(0, 3).join(", "))}</span></span>`;
  const flagChip = facts.flags.length
    ? `<span class="chip">${ICONS.warning}<span>Covers ${facts.flags.length} ${facts.flags.length === 1 ? "flag" : "flags"}</span></span>`
    : "";
  $("#checkRow").innerHTML = figChip + flagChip;
  $("#approveBtn").disabled = !ok || !text.trim();
}

function openSheet(trigger) {
  state.lastTrigger = trigger;
  const p = currentProperty();
  bind("sheetMeta", `${p.name}, ${monthLong(state.data.portfolio.months[state.monthIndex])}`);
  bind("ownerName", p.owner.name);
  $("#scrim").hidden = false;
  $("#sheet").hidden = false;
  requestAnimationFrame(() => {
    $("#scrim").classList.add("is-open");
    $("#sheet").classList.add("is-open");
    $("#sheetClose").focus({ preventScroll: true });
  });
  document.body.style.overflow = "hidden";
  generateDraft();
}

function closeSheet() {
  $("#scrim").classList.remove("is-open");
  $("#sheet").classList.remove("is-open");
  document.body.style.overflow = "";
  setTimeout(() => { $("#scrim").hidden = true; $("#sheet").hidden = true; }, 320);
  state.lastTrigger?.focus();
}

async function generateDraft() {
  const p = currentProperty();
  const monthKey = state.data.portfolio.months[state.monthIndex];
  $("#draftLoading").hidden = false;
  $("#draftReady").hidden = true;
  $("#approveBtn").disabled = true;
  $("#regenBtn").disabled = true;

  let draft;
  if (state.apiAvailable) {
    try {
      const res = await apiFetch("/drafts", { property_id: p.id, month: monthKey });
      draft = { id: res.draft_id, text: res.text, source: res.source === "fallback" ? "sample" : "ai", model: res.model };
    } catch { /* fall through to local sample */ }
  }
  if (!draft) {
    await new Promise((r) => setTimeout(r, 650)); // let the loading state read as a moment, not a flash
    draft = { id: `local-${Date.now()}`, text: localDraft(draftFacts(p, state.monthIndex)), source: "sample", model: null };
  }
  state.draft = draft;

  $("#draftText").value = draft.text;
  $("#draftSource").textContent = draft.source === "ai"
    ? `Drafted by AI${draft.model ? ` (${draft.model})` : ""} from this month’s figures. Edit anything before you approve.`
    : "Sample draft built from this month’s figures. Edit anything before you approve.";
  $("#draftLoading").hidden = true;
  $("#draftReady").hidden = false;
  $("#regenBtn").disabled = false;
  setChecks();
  $("#draftText").focus({ preventScroll: true });
  $("#draftText").setSelectionRange(0, 0);
  $("#draftText").scrollTop = 0;
}

async function approveDraft() {
  const p = currentProperty();
  const text = $("#draftText").value.trim();
  const monthKey = state.data.portfolio.months[state.monthIndex];
  const localChecks = checkFigures(text, figureSet(draftFacts(p, state.monthIndex)));
  if (localChecks.unmatched.length) {
    setChecks(localChecks.unmatched);
    return;
  }

  $("#approveBtn").disabled = true;

  let approvedAt = new Date();
  if (state.apiAvailable && !String(state.draft.id).startsWith("local-")) {
    try {
      const res = await apiFetch(`/drafts/${encodeURIComponent(state.draft.id)}/approve`, { text });
      if (res.approved_at) approvedAt = new Date(res.approved_at);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const unmatched = err.body.unmatched || err.body.detail?.unmatched || [];
        setChecks(unmatched);
        toast("Some figures don’t match the data. Fix them before approving.");
        return;
      }
      // Network / expired draft: still keep a local approval so the demo never stalls.
    }
  }

  addLogEntry({ p, monthKey, text, approvedAt });
  closeSheet();
  toast(`Approved. Queued for ${p.owner.name}.`);
}

function loadStoredApprovals() {
  try {
    const raw = localStorage.getItem(LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveStoredApprovals(entries) {
  try {
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(entries.slice(0, 40)));
  } catch { /* private mode / quota — log still shows for this session */ }
}

function renderLogEntry(entry) {
  const list = $("#logList");
  list.querySelector(".log-empty")?.remove();
  const approvedAt = new Date(entry.approvedAt);
  const time = approvedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const li = document.createElement("li");
  li.className = "log-item";
  li.innerHTML = `
    <strong>${esc(entry.propertyName)}, ${esc(monthLong(entry.monthKey))}</strong>
    <span class="log-meta">Approved by you at ${esc(time)}. Queued for ${esc(entry.ownerName)}.</span>
    <span class="log-text">${esc(entry.preview)}</span>`;
  list.prepend(li);
}

function restoreApprovals() {
  const entries = loadStoredApprovals();
  // Stored newest-first; prepend in reverse so newest ends on top.
  entries.slice().reverse().forEach(renderLogEntry);
}

function addLogEntry({ p, monthKey, text, approvedAt }) {
  const entry = {
    propertyName: p.name,
    ownerName: p.owner.name,
    monthKey,
    approvedAt: approvedAt.toISOString(),
    preview: text.split("\n").slice(2).join(" "),
  };
  const entries = loadStoredApprovals();
  entries.unshift(entry);
  saveStoredApprovals(entries);
  renderLogEntry(entry);
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ---------- Wiring ---------- */

function renderAll() {
  renderHeader();
  renderKpis();
  renderProperties();
  renderDetail();
}

function setupMonthSelect() {
  const sel = $("#monthSelect");
  const months = state.data.portfolio.months;
  sel.innerHTML = months.map((m, j) => `<option value="${j}">${monthLong(m)}</option>`).join("");
  sel.value = String(state.monthIndex);
  sel.addEventListener("change", () => {
    state.monthIndex = Number(sel.value);
    renderAll();
  });
}

function setupCompactBar() {
  const bar = $("#compactBar");
  const io = new IntersectionObserver(([entry]) => {
    const show = !entry.isIntersecting;
    bar.classList.toggle("is-visible", show);
    bar.setAttribute("aria-hidden", String(!show));
  }, { rootMargin: "-40px 0px 0px 0px" });
  io.observe($(".large-title"));
}

function setupSheet() {
  $("#draftBtn").addEventListener("click", (e) => openSheet(e.currentTarget));
  $("#draftBtnMobile").addEventListener("click", (e) => openSheet(e.currentTarget));
  $("#sheetClose").addEventListener("click", closeSheet);
  $("#scrim").addEventListener("click", closeSheet);
  $("#regenBtn").addEventListener("click", generateDraft);
  $("#approveBtn").addEventListener("click", approveDraft);
  $("#draftText").addEventListener("input", () => setChecks());
  document.addEventListener("keydown", (e) => {
    if ($("#sheet").hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeSheet();
      return;
    }
    if (e.key === "Tab") {
      const focusables = sheetFocusables();
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}

async function init() {
  try {
    const res = await fetch("data/portfolio.json", { cache: "no-store" });
    state.data = await res.json();
  } catch {
    bind("portfolioSummary", "Couldn’t load the portfolio data. Check that data/portfolio.json is being served.");
    return;
  }
  state.monthIndex = state.data.portfolio.months.length - 1;
  const firstFlagged = state.data.properties.find((p) => flagsFor(p, state.monthIndex).length);
  state.selectedId = (firstFlagged || state.data.properties[0]).id;

  setupMonthSelect();
  setupCompactBar();
  setupSheet();
  restoreApprovals();
  renderAll();
  window.addEventListener("scroll", hideTooltip, { passive: true });

  state.apiAvailable = await detectApi();
}

init();
