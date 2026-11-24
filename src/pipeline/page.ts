/**
 * The pipeline page (design 10.3): `reports/pipeline.html`, a read-only,
 * self-contained page with no server, no network references and no write
 * actions. It shows applications by state, the current top matches with
 * their score method and sources, follow-ups that are due, "Waiting for
 * you" and pending approvals.
 *
 * Reshaped from dashboard/build.py (ported from ai-job-search's
 * /html-report, MIT, see NOTICE): the stage buckets, stats, SVG charts,
 * filterable table and escaping rules come from there; the rows now come
 * from the database instead of tracker.csv and seen_jobs.json. Every
 * string from a posting or the user is escaped.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { APPLICATION_STATES } from "../core/applications.js";
import type { CoreContext } from "../core/context.js";
import { listJobs, type JobSummary } from "../core/jobs.js";
import { LEGACY_DATE_NOTE } from "../legacy/import.js";
import { addDays, isoDate } from "../util/clock.js";
import { escapeHtml as esc } from "../util/text.js";

/** Days after applying before a follow-up is due. */
export const FOLLOWUP_DAYS = 7;
/** A due date within this many days counts as "due soon". */
export const SOON_DAYS = 7;

export const STATE_LABELS: Record<string, string> = {
  found: "Found",
  shortlisted: "Shortlisted",
  resume_prepared: "Resume prepared",
  applied: "Applied",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
};

const COLORS: Record<string, string> = {
  match: "#0ea5e9",
  found: "#94a3b8",
  shortlisted: "#64748b",
  resume_prepared: "#6366f1",
  applied: "#3b82f6",
  interview: "#f59e0b",
  offer: "#22c55e",
  rejected: "#ef4444",
};

/** States that mean the application was sent; the others never count in the stats. */
const SENT = new Set(["applied", "interview", "offer", "rejected"]);
const REACHED: Record<string, number> = { applied: 1, interview: 2, offer: 3 };

export interface PipelineRow {
  origin: "application" | "match";
  job_id: string;
  date: string;
  company: string;
  role: string;
  location: string;
  sources: string[];
  stage: string;
  score: number | null;
  score_method: string | null;
  flags: string[];
  notes: string;
  url: string;
  due_kind: string;
  due_state: "" | "overdue" | "soon" | "later";
  due: string;
}

export interface PipelineData {
  today: string;
  generated_at: string;
  rows: PipelineRow[];
  waiting: Array<{ id: string; service: string | null; reason: string; detail: string | null; open_what: string; opened_at: string }>;
  approvals: Array<{ id: string; subject_kind: string; summary: string; requested_by: string; requested_at: string }>;
  stats: PipelineStats;
}

export interface PipelineStats {
  stage_counts: Record<string, number>;
  sent: number;
  sources: Record<string, number>;
  funnel: { Applied: number; Interview: number; Offer: number };
  rejection_rate: number | null;
  top_matches: number;
  due_count: number;
  overdue_count: number;
}

function parseDay(value: unknown): string | null {
  const text = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || isoDate(parsed) !== text ? null : text;
}

/** The next date that needs attention: (kind, state, date). */
export function dueInfo(deadline: string | null, followup: string | null, today: string): [string, PipelineRow["due_state"], string | null] {
  const candidates = ([[followup, "follow-up"], [deadline, "deadline"]] as Array<[string | null, string]>).filter(
    (c): c is [string, string] => c[0] !== null,
  );
  if (!candidates.length) return ["", "", null];
  candidates.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const [day, kind] = candidates[0] as [string, string];
  const state = day < today ? "overdue" : day <= addDays(today, SOON_DAYS) ? "soon" : "later";
  return [kind, state, day];
}

interface ApplicationJoin {
  job_id: string;
  state: string;
  created_at: string;
  title: string;
  company: string;
  location: string | null;
  url: string | null;
  deadline: string | null;
}

function applicationRows(ctx: CoreContext, today: string): PipelineRow[] {
  const apps = ctx.db
    .prepare(
      `SELECT a.job_id, a.state, a.created_at, j.title, j.company, j.location, j.canonical_url AS url, j.deadline
       FROM applications a JOIN jobs j ON j.id = a.job_id`,
    )
    .all() as unknown as ApplicationJoin[];
  return apps.map((app) => {
    const events = ctx.db
      .prepare("SELECT to_state, at, channel, note FROM application_events WHERE job_id = ? ORDER BY id")
      .all(app.job_id) as Array<{ to_state: string; at: string; channel: string; note: string | null }>;
    const appliedEvent = events.find((e) => e.to_state === "applied");
    const last = events[events.length - 1];
    const dateText = appliedEvent?.at ?? last?.at ?? app.created_at;
    // An import with no full tracker date stamps the import time; that is not when the user applied.
    const undated = appliedEvent?.channel === "import" && Boolean(appliedEvent.note?.includes(LEGACY_DATE_NOTE));
    const applied = undated ? null : parseDay(appliedEvent?.at);
    // A follow-up only for submitted-and-silent applications with a full date.
    const followup = app.state === "applied" && applied ? addDays(applied, FOLLOWUP_DAYS) : null;
    const deadline = ["found", "shortlisted", "resume_prepared", "applied"].includes(app.state) ? parseDay(app.deadline) : null;
    const [kind, state, when] = dueInfo(deadline, followup, today);
    const sources = (
      ctx.db.prepare("SELECT connector FROM job_sightings WHERE job_id = ? GROUP BY connector ORDER BY MIN(id)").all(app.job_id) as Array<{
        connector: string;
      }>
    ).map((r) => r.connector);
    return {
      origin: "application" as const,
      job_id: app.job_id,
      date: String(dateText).slice(0, 10),
      company: app.company,
      role: app.title,
      location: app.location ?? "",
      sources,
      stage: app.state,
      score: null,
      score_method: null,
      flags: [],
      notes: events.map((e) => e.note).filter((n): n is string => Boolean(n)).pop() ?? "",
      url: app.url ?? "",
      due_kind: kind,
      due_state: state,
      due: when ?? "",
    };
  });
}

function matchRow(job: JobSummary, today: string): PipelineRow {
  const [kind, state, when] = dueInfo(parseDay(job.deadline), null, today);
  return {
    origin: "match",
    job_id: job.job_id,
    date: "",
    company: job.company,
    role: job.title,
    location: job.location ?? "",
    sources: job.sources,
    stage: "match",
    score: job.score_10,
    score_method: job.score_method,
    flags: job.flags,
    notes: job.reason ?? "",
    url: job.url ?? "",
    due_kind: kind,
    due_state: state,
    due: when ?? "",
  };
}

export function computeStats(rows: PipelineRow[]): PipelineStats {
  const apps = rows.filter((r) => r.origin === "application");
  const stageCounts: Record<string, number> = Object.fromEntries(APPLICATION_STATES.map((s) => [s, 0]));
  for (const row of apps) stageCounts[row.stage] = (stageCounts[row.stage] ?? 0) + 1;
  const sent = apps.filter((r) => SENT.has(r.stage));
  const sources: Record<string, number> = {};
  for (const row of rows) for (const source of row.sources.length ? row.sources : ["\u2014"]) sources[source] = (sources[source] ?? 0) + 1;
  const reached = sent.map((r) => REACHED[r.stage] ?? 0);
  const rejected = stageCounts.rejected ?? 0;
  const resolved = rejected + (stageCounts.offer ?? 0);
  const due = rows.filter((r) => r.due_state === "overdue" || r.due_state === "soon");
  return {
    stage_counts: stageCounts,
    sent: sent.length,
    sources,
    funnel: { Applied: sent.length, Interview: reached.filter((x) => x >= 2).length, Offer: reached.filter((x) => x >= 3).length },
    rejection_rate: resolved ? Math.round((100 * rejected) / resolved) : null,
    top_matches: rows.filter((r) => r.origin === "match").length,
    due_count: due.length,
    overdue_count: due.filter((r) => r.due_state === "overdue").length,
  };
}

/** Read everything the page shows. No writes. */
export function collect(ctx: CoreContext): PipelineData {
  const now = ctx.clock.now();
  const today = isoDate(now);
  const rows = applicationRows(ctx, today);
  const matches = listJobs(ctx).results.map((job) => matchRow(job, today));
  rows.push(...matches);
  const waiting = ctx.db
    .prepare(
      "SELECT id, COALESCE(compartment, binding_id) AS service, reason, detail, open_what, opened_at FROM human_steps WHERE resolved_at IS NULL ORDER BY opened_at",
    )
    .all() as PipelineData["waiting"];
  const approvals = ctx.db
    .prepare("SELECT id, subject_kind, summary, requested_by, requested_at FROM approvals WHERE status = 'pending' ORDER BY requested_at")
    .all() as PipelineData["approvals"];
  return { today, generated_at: now.toISOString(), rows, waiting: waiting.map((w) => ({ ...w })), approvals: approvals.map((a) => ({ ...a })), stats: computeStats(rows) };
}

// ---------------------------------------------------------------- charts

function card(title: string, body: string): string {
  return `<div class="chart-card"><h3>${esc(title)}</h3>${body}</div>`;
}

function barChart(title: string, data: Record<string, number>, color: string, label: string): string {
  const items = Object.entries(data).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!items.length) return card(title, '<p class="empty">No data</p>');
  const top = Math.max(...items.map(([, v]) => v)) || 1;
  const h = 26 * items.length + 8;
  const parts = [`<svg viewBox="0 0 420 ${h}" role="img" aria-label="${esc(`${label}: ${items.map(([k, v]) => `${v} ${k}`).join(", ")}`)}">`];
  items.forEach(([k, v], i) => {
    const y = 4 + 26 * i;
    const w = Math.max(2, Math.round((220 * v) / top));
    parts.push(
      `<text x="0" y="${y + 15}" class="lbl">${esc(k.slice(0, 22))}</text>` +
        `<rect x="150" y="${y + 2}" width="${w}" height="18" rx="3" fill="${color}"><title>${esc(k)}: ${v}</title></rect>` +
        `<text x="${156 + w}" y="${y + 15}" class="lbl">${v}</text>`,
    );
  });
  parts.push("</svg>");
  return card(title, parts.join(""));
}

function doughnut(title: string, data: Record<string, number>): string {
  const items = Object.entries(data).filter(([, v]) => v);
  const total = items.reduce((sum, [, v]) => sum + v, 0);
  if (!total) return card(title, '<p class="empty">No data</p>');
  const cx = 80;
  const cy = 80;
  const r = 70;
  const ri = 42;
  const label = (k: string) => STATE_LABELS[k] ?? k;
  const parts = [`<svg viewBox="0 0 320 ${Math.max(160, 20 * items.length + 20)}" role="img" aria-label="${esc(`${title}: ${items.map(([k, v]) => `${v} ${label(k)}`).join(", ")}`)}">`];
  let angle = -Math.PI / 2;
  const p = (rr: number, a: number) => `${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`;
  for (const [k, v] of items) {
    const color = COLORS[k] ?? "#94a3b8";
    if (items.length === 1) {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${(r + ri) / 2}" fill="none" stroke="${color}" stroke-width="${r - ri}"><title>${esc(label(k))}: ${v}</title></circle>`);
    } else {
      const a2 = angle + (2 * Math.PI * v) / total;
      const big = a2 - angle > Math.PI ? 1 : 0;
      parts.push(
        `<path d="M ${p(r, angle)} A ${r} ${r} 0 ${big} 1 ${p(r, a2)} L ${p(ri, a2)} A ${ri} ${ri} 0 ${big} 0 ${p(ri, angle)} Z" fill="${color}"><title>${esc(label(k))}: ${v}</title></path>`,
      );
      angle = a2;
    }
  }
  items.forEach(([k, v], i) => {
    const y = 20 + 20 * i;
    parts.push(`<rect x="170" y="${y - 10}" width="12" height="12" fill="${COLORS[k] ?? "#94a3b8"}"/><text x="188" y="${y}" class="lbl">${esc(label(k))} ${v}</text>`);
  });
  parts.push("</svg>");
  return card(title, parts.join(""));
}

// ---------------------------------------------------------------- page

const CSS = `
:root{--bg:#f1f5f9;--fg:#0f172a;--card:#fff;--mut:#64748b;--line:#e2e8f0;--alt:#f8fafc}
@media (prefers-color-scheme:dark){:root{--bg:#0f172a;--fg:#e2e8f0;--card:#1e293b;--mut:#94a3b8;--line:#334155;--alt:#172033}}
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:baseline}h1{margin:0;font-size:24px}h2{margin:22px 0 8px;font-size:18px}.mut{color:var(--mut);font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:18px 0}
.stat{background:var(--card);border-left:5px solid var(--c);border-radius:6px;padding:12px 14px;box-shadow:0 1px 3px #0002}.stat b{display:block;font-size:28px}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:14px;margin-bottom:18px}
.chart-card,.panel{background:var(--card);border-radius:6px;padding:12px 14px;box-shadow:0 1px 3px #0002}.chart-card h3{margin:0 0 8px;font-size:15px}
.panel ul{margin:0;padding-left:18px}.panel li{margin:4px 0}
.lbl{font-size:12px;fill:var(--fg)}.empty{color:var(--mut)}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}select,input{padding:6px 8px;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--fg);font:inherit}
.tablewrap{overflow-x:auto;background:var(--card);border-radius:6px;box-shadow:0 1px 3px #0002}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:7px 9px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
th{cursor:pointer;white-space:nowrap}tbody tr:nth-child(even){background:var(--alt)}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;color:#fff;font-size:12px;white-space:nowrap}
.flag{display:inline-block;margin:0 2px 2px 0;padding:0 6px;border-radius:3px;background:#fef3c7;color:#92400e;font-size:11px}
.overdue{color:#dc2626;font-weight:600}.soon{color:#d97706;font-weight:600}
a{color:#2563eb}footer{margin-top:18px}
`;

const JS = `
(function(){
var q=document.getElementById('q'),fs=document.getElementById('f-stage'),fo=document.getElementById('f-source'),fd=document.getElementById('f-due');
var rows=[].slice.call(document.querySelectorAll('#tbl tbody tr')),n=document.getElementById('shown');
function apply(){var t=q.value.toLowerCase(),c=0;rows.forEach(function(r){
var ok=(!t||r.getAttribute('data-q').indexOf(t)>-1)&&(!fs.value||r.getAttribute('data-stage')===fs.value)&&(!fo.value||(' '+r.getAttribute('data-source')+' ').indexOf(' '+fo.value+' ')>-1)&&(!fd.checked||r.getAttribute('data-due')==='1');
r.style.display=ok?'':'none';if(ok)c++;});n.textContent=c;}
[q,fs,fo,fd].forEach(function(e){e.addEventListener('input',apply);});
[].slice.call(document.querySelectorAll('#tbl th')).forEach(function(th,i){th.addEventListener('click',function(){
var tb=document.querySelector('#tbl tbody'),dir=th.getAttribute('data-dir')==='asc'?-1:1;th.setAttribute('data-dir',dir===1?'asc':'desc');
rows.sort(function(a,b){var x=a.children[i].getAttribute('data-v')||a.children[i].textContent,y=b.children[i].getAttribute('data-v')||b.children[i].textContent,nx=parseFloat(x),ny=parseFloat(y);
if(!isNaN(nx)&&!isNaN(ny))return(nx-ny)*dir;return x.localeCompare(y)*dir;});rows.forEach(function(r){tb.appendChild(r);});});});
})();
`;

function truncate(text: string, n = 80): string {
  const chars = Array.from(text);
  return chars.length <= n ? text : `${chars.slice(0, n - 1).join("")}\u2026`;
}

function stageLabel(row: PipelineRow): string {
  return row.origin === "match" ? "Top match" : (STATE_LABELS[row.stage] ?? row.stage);
}

function rowHtml(row: PipelineRow): string {
  const color = COLORS[row.stage] ?? "#94a3b8";
  const link = /^https?:\/\//i.test(row.url) ? `<a href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">link</a>` : "\u2014";
  const flags = row.flags.map((f) => `<span class="flag">${esc(f)}</span>`).join("") || "\u2014";
  const due = row.due ? `<span class="${row.due_state}" title="${esc(row.due_kind)}">${esc(row.due)} (${esc(row.due_kind)})</span>` : "\u2014";
  const score = row.score === null ? "\u2014" : `${row.score} <span class="mut">${esc(row.score_method ?? "")}</span>`;
  const haystack = [row.company, row.role, row.location, ...row.sources].join(" ").toLowerCase();
  const cells: Array<[string, string]> = [
    [esc(row.date) || "\u2014", ""],
    [due, row.due],
    [esc(row.company) || "\u2014", ""],
    [esc(row.role) || "\u2014", ""],
    [esc(row.location) || "\u2014", ""],
    [`<span class="pill" style="background:${color}">${esc(stageLabel(row))}</span>`, ""],
    [score, row.score === null ? "" : String(row.score)],
    [esc(row.sources.join(", ")) || "\u2014", ""],
    [flags, ""],
    [`<span title="${esc(row.notes)}">${esc(truncate(row.notes)) || "\u2014"}</span>`, ""],
    [link, ""],
  ];
  const tds = cells.map(([c, v]) => (v ? `<td data-v="${esc(v)}">${c}</td>` : `<td>${c}</td>`)).join("");
  return (
    `<tr data-q="${esc(haystack)}" data-stage="${esc(row.stage)}" data-source="${esc(row.sources.join(" "))}" ` +
    `data-due="${row.due_state === "overdue" || row.due_state === "soon" ? 1 : 0}">${tds}</tr>`
  );
}

function listPanel(title: string, items: string[], empty: string): string {
  return `<div class="panel"><h3>${esc(title)}</h3>${items.length ? `<ul>${items.join("")}</ul>` : `<p class="empty">${esc(empty)}</p>`}</div>`;
}

export function renderHtml(data: PipelineData): string {
  const s = data.stats;
  const cards =
    APPLICATION_STATES.map((k) => `<div class="stat" style="--c:${COLORS[k]}"><b>${s.stage_counts[k] ?? 0}</b>${esc(STATE_LABELS[k])}</div>`).join("") +
    `<div class="stat" style="--c:${COLORS.match}"><b>${s.top_matches}</b>Top matches</div>` +
    `<div class="stat" style="--c:#dc2626"><b>${s.due_count}</b>Due / overdue (${s.overdue_count} overdue)</div>` +
    `<div class="stat" style="--c:#a855f7"><b>${data.waiting.length}</b>Waiting for you</div>` +
    `<div class="stat" style="--c:#14b8a6"><b>${data.approvals.length}</b>Pending approvals</div>`;
  const charts =
    doughnut("Applications by state", s.stage_counts) +
    barChart("By source (all rows)", s.sources, "#0ea5e9", "By source") +
    barChart("Application funnel", s.funnel, "#8b5cf6", "Funnel");
  const waiting = listPanel(
    "Waiting for you",
    data.waiting.map(
      (w) => `<li><b>${esc(w.service ?? "job-seeker")}</b>: ${esc(w.reason)}${w.detail ? ` - ${esc(w.detail)}` : ""}. ${esc(w.open_what)} <span class="mut">(since ${esc(w.opened_at)})</span></li>`,
    ),
    "Nothing is waiting for you.",
  );
  const approvals = listPanel(
    "Pending approvals",
    data.approvals.map((a) => `<li><b>${esc(a.id)}</b> (${esc(a.subject_kind)}): ${esc(a.summary)} <span class="mut">requested by ${esc(a.requested_by)}</span></li>`),
    "No approvals are pending.",
  );
  const rows = [...data.rows].sort(
    (a, b) => Number(a.origin === "match") - Number(b.origin === "match") || b.date.localeCompare(a.date) || a.company.toLowerCase().localeCompare(b.company.toLowerCase()),
  );
  const sources = [...new Set(rows.flatMap((r) => r.sources))].sort();
  const stages = [...APPLICATION_STATES, "match"];
  const opt = (values: string[], label: (v: string) => string = (v) => v) =>
    values.map((v) => `<option value="${esc(v)}">${esc(label(v))}</option>`).join("");
  const head = ["Date", "Due", "Company", "Role", "Location", "Stage", "Score", "Sources", "Flags", "Notes", "Link"].map((h) => `<th>${h}</th>`).join("");
  const rate = s.rejection_rate === null ? "n/a" : `${s.rejection_rate}%`;
  const progressed = s.funnel.Applied ? `${Math.round((100 * s.funnel.Interview) / s.funnel.Applied)}%` : "n/a";
  const body = `<header><h1>Job search pipeline</h1><span class="mut">Generated ${esc(data.generated_at)}</span></header>
<div class="cards">${cards}</div>
<p class="mut">Applications sent: ${s.sent} \u00b7 reached interview: ${progressed} \u00b7 rejections among decided applications: ${rate}. Found, shortlisted and resume-prepared applications are not counted as sent. Top matches show the shown score (rule, assistant or AI review) on a 1-10 scale.</p>
<div class="charts">${waiting}${approvals}</div>
<div class="charts">${charts}</div>
<h2>Pipeline</h2>
<div class="filters"><input id="q" type="search" placeholder="Search company, role, location, source" aria-label="Search">
<select id="f-stage" aria-label="Stage"><option value="">All stages</option>${opt(stages, (v) => (v === "match" ? "Top match" : (STATE_LABELS[v] ?? v)))}</select>
<select id="f-source" aria-label="Source"><option value="">All sources</option>${opt(sources)}</select>
<label><input id="f-due" type="checkbox"> Due or overdue only</label>
<span class="mut">Showing <span id="shown">${rows.length}</span> of ${rows.length}</span></div>
<div class="tablewrap"><table id="tbl"><thead><tr>${head}</tr></thead><tbody>${rows.map(rowHtml).join("")}</tbody></table></div>
<footer class="mut">Generated by job-seeker \u00b7 read-only \u00b7 the dashboard is ported from ai-job-search /html-report (MIT) \u00b7 ${esc(data.today)}</footer>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">` +
    `<title>Job search pipeline</title><style>${CSS}</style></head><body>${body}<script>${JS}</script></body></html>\n`
  );
}

export const PIPELINE_PATH = join("reports", "pipeline.html");

export function writePipelinePage(ctx: CoreContext) {
  const data = collect(ctx);
  const dir = join(ctx.dataDir, "reports");
  mkdirSync(dir, { recursive: true });
  const path = join(ctx.dataDir, PIPELINE_PATH);
  writeFileSync(path, renderHtml(data), { encoding: "utf8" });
  return {
    path,
    generated_at: data.generated_at,
    summary: {
      applications: data.stats.stage_counts,
      top_matches: data.stats.top_matches,
      follow_ups_due: data.stats.due_count,
      waiting_for_you: data.waiting.length,
      pending_approvals: data.approvals.length,
    },
  };
}
