"""Collect the tracker and ranked postings and render one self-contained
HTML dashboard (inline CSS/JS/SVG, no network fetches).

Ported from ai-job-search's /html-report command (MIT, see NOTICE):
status buckets, stats, SVG charts, filterable table and escaping rules come
from there. Adapted: it reads jobseek's tracker.csv, state/seen_jobs.json and
state/last_run.json through jobseek's config; adds ranked-posting rows
(score, flags, source, deadline) and follow-up due dates; no outcome.md merge.

Read-only with respect to the tracker and state; the only file written is
the dashboard itself.
"""

from __future__ import annotations

import csv
import html
import json
import sys
import webbrowser
from datetime import date, timedelta
from pathlib import Path

_TOOLS = Path(__file__).resolve().parent.parent / "tools"
if str(_TOOLS) not in sys.path:
    sys.path.insert(0, str(_TOOLS))

import config as jobseek_config  # noqa: E402

# Days after applying (status `applied`, full ISO date) before a follow-up is due.
FOLLOWUP_DAYS = 7
# A deadline within this many days counts as "due soon".
SOON_DAYS = 7

BUCKETS = ("Drafted", "Active", "Interview", "Offer", "Hired", "Rejected/Closed")
COLORS = {
    "Ranked": "#0ea5e9",
    "Drafted": "#64748b",
    "Active": "#3b82f6",
    "Interview": "#f59e0b",
    "Offer": "#8b5cf6",
    "Hired": "#22c55e",
    "Rejected/Closed": "#ef4444",
}
STATUS_MAP = {
    "drafted": "Drafted",
    "applied": "Active",
    "interview": "Interview",
    "offer": "Offer",
    "hired": "Hired",
}
# Rank of the furthest stage a status implies, for the funnel.
_REACHED = {"Active": 1, "Interview": 2, "Offer": 3, "Hired": 4}
TRUE_REJECTIONS = {"rejected", "no_response", "no response"}
CLOSED_STATUSES = TRUE_REJECTIONS | {"offer_declined", "offer declined", "withdrawn"}


def bucket(status: str) -> tuple[str, bool]:
    """(canonical bucket, recognised). Unknown values fall into Rejected/Closed."""
    s = (status or "").strip().lower()
    if s in STATUS_MAP:
        return STATUS_MAP[s], True
    return "Rejected/Closed", s in CLOSED_STATUSES


def parse_date(value) -> date | None:
    try:
        return date.fromisoformat(str(value).strip()[:10])
    except ValueError:
        return None


def esc(value) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def default_output_path(cfg: dict | None = None) -> Path:
    """`paths.dashboard` when configured, else <state_dir>/dashboard.html
    (state/ is gitignored). Relative paths resolve against the repository root."""
    cfg = cfg or jobseek_config.load_config()
    if cfg.get("paths", {}).get("dashboard"):
        return jobseek_config.resolve_path(cfg, "dashboard")
    return jobseek_config.resolve_path(cfg, "state_dir") / "dashboard.html"


def read_tracker(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    with path.open(encoding="utf-8-sig", newline="") as fh:
        # Rows written before `deadline` existed are short: DictReader yields None; treat as empty.
        return [{k: (v or "") for k, v in row.items() if k} for row in csv.DictReader(fh)]


def read_seen(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    seen = doc.get("seen") if isinstance(doc, dict) and "seen" in doc else doc
    return seen if isinstance(seen, dict) else {}


def read_shortlist_keys(path: Path) -> list[str]:
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    ranked = data.get("ranked") if isinstance(data, dict) else None
    return [r.get("key") for r in ranked if isinstance(r, dict) and r.get("key")] if isinstance(ranked, list) else []


def due_info(deadline: date | None, followup: date | None, today: date) -> tuple[str, str, date | None]:
    """(kind, state, date): the next date that needs attention.

    state is "overdue" (before today), "soon" (within SOON_DAYS) or "later"."""
    candidates = [(d, k) for d, k in ((followup, "follow-up"), (deadline, "deadline")) if d]
    if not candidates:
        return "", "", None
    d, kind = min(candidates)
    state = "overdue" if d < today else "soon" if d <= today + timedelta(days=SOON_DAYS) else "later"
    return kind, state, d


def tracker_row(raw: dict, today: date) -> dict:
    b, _known = bucket(raw.get("status", ""))
    applied = parse_date(raw.get("date"))
    # Follow-up only for submitted-and-silent rows with a full date; a bare year proves nothing.
    follow = applied + timedelta(days=FOLLOWUP_DAYS) if b == "Active" and applied else None
    deadline = parse_date(raw.get("deadline")) if b in ("Drafted", "Active") else None
    kind, state, when = due_info(deadline, follow, today)
    return {
        "origin": "tracker", "date": raw.get("date", ""), "company": raw.get("company", ""),
        "sector": raw.get("sector", ""), "role": raw.get("role", ""),
        "channel": raw.get("channel", ""), "source": raw.get("source", ""),
        "stage": b, "raw_status": raw.get("status", ""), "score": None, "flags": [],
        "notes": raw.get("notes", ""), "due_kind": kind, "due_state": state,
        "due": when.isoformat() if when else "",
    }


def posting_flags(entry: dict) -> list[str]:
    flags = []
    if entry.get("engineering_role") is True:
        flags.append("engineering role")
    if entry.get("location_verdict") in ("FAIL", "FLAG"):
        flags.append(f"location {entry['location_verdict']}")
    if entry.get("seniority_gate") in ("FAIL", "FLAG"):
        flags.append(f"seniority {entry['seniority_gate']}")
    guard = entry.get("guard")
    if guard and guard != "clean":
        flags.append("guard warning")
    return flags


def posting_row(key: str, entry: dict, shortlisted: bool, today: date) -> dict:
    score = entry.get("rank_score")
    deadline = parse_date(entry.get("deadline"))
    kind, state, when = due_info(deadline, None, today)
    notes = entry.get("reason") or ""
    return {
        "origin": "shortlist" if shortlisted else "ranked",
        "date": entry.get("rank_date") or entry.get("first_seen") or "",
        "company": entry.get("company") or "", "sector": "", "role": entry.get("title") or "",
        "channel": "alert", "source": entry.get("source") or "", "url": entry.get("url") or "",
        "stage": "Ranked", "raw_status": entry.get("rank_verdict") or "ranked",
        "score": round(score / 10, 1) if isinstance(score, (int, float)) else None,
        "flags": posting_flags(entry), "notes": notes,
        "due_kind": kind, "due_state": state, "due": when.isoformat() if when else "",
    }


def collect(cfg: dict | None = None, today: date | None = None) -> dict:
    """Read tracker + ranked postings through jobseek's config and shape the
    data the page renders. No writes."""
    cfg = cfg or jobseek_config.load_config()
    today = today or date.today()
    tracker = read_tracker(jobseek_config.resolve_path(cfg, "tracker"))
    seen = read_seen(jobseek_config.resolve_path(cfg, "seen_jobs"))
    short_keys = read_shortlist_keys(jobseek_config.resolve_path(cfg, "last_run"))
    rows = [tracker_row(r, today) for r in tracker]
    unknown = sorted({r["raw_status"] for r in rows
                      if r["raw_status"].strip().lower() not in set(STATUS_MAP) | CLOSED_STATUSES})
    ranked = [(k, e) for k, e in seen.items() if isinstance(e, dict) and e.get("status") == "ranked"]
    ranked.sort(key=lambda kv: kv[1].get("rank_score") or 0, reverse=True)
    rows += [posting_row(k, e, k in short_keys, today) for k, e in ranked]
    return {"today": today.isoformat(), "rows": rows, "unknown_statuses": unknown,
            "stats": compute_stats(rows, tracker)}


def compute_stats(rows: list[dict], tracker: list[dict]) -> dict:
    tr = [r for r in rows if r["origin"] == "tracker"]
    counts = {b: sum(1 for r in tr if r["stage"] == b) for b in BUCKETS}
    sent = [r for r in tr if r["stage"] != "Drafted"]  # Drafted never submitted: excluded from stats
    sectors, channels, sources = {}, {}, {}
    for r in sent:
        sectors[r["sector"] or "—"] = sectors.get(r["sector"] or "—", 0) + 1
        channels[r["channel"] or "—"] = channels.get(r["channel"] or "—", 0) + 1
    for r in rows:
        sources[r["source"] or "—"] = sources.get(r["source"] or "—", 0) + 1
    reached = [_REACHED.get(r["stage"], 0) for r in sent]
    # Current status only (no outcome.md merge): a closed row has no recorded stage.
    funnel = {"Applied": len(sent),
              "Interview": sum(1 for x in reached if x >= 2),
              "Offer": sum(1 for x in reached if x >= 3),
              "Hired": sum(1 for x in reached if x >= 4)}
    final = [r for r in sent if r["stage"] == "Rejected/Closed"]
    rejections = sum(1 for r in final if r["raw_status"].strip().lower() in TRUE_REJECTIONS)
    resolved = len(final) + counts["Hired"]  # rows with a final outcome
    shortlisted = [r for r in rows if r["origin"] == "shortlist"]
    due = [r for r in rows if r["due_state"] in ("overdue", "soon")]
    return {
        "stage_counts": {**counts, "Ranked": sum(1 for r in rows if r["origin"] != "tracker")},
        "sent": len(sent), "sectors": sectors, "channels": channels, "sources": sources,
        "funnel": funnel,
        "rejection_rate": round(100 * rejections / resolved) if resolved else None,
        "shortlist": len(shortlisted),
        "due_count": len(due), "overdue_count": sum(1 for r in due if r["due_state"] == "overdue"),
    }


# ---------------------------------------------------------------- charts


def _bar_chart(title: str, data: dict, color: str, label: str) -> str:
    items = sorted(data.items(), key=lambda kv: (-kv[1], kv[0]))
    if not items:
        return _card(title, f'<p class="empty">No data</p>')
    top = max(v for _, v in items) or 1
    h = 26 * len(items) + 8
    parts = [f'<svg viewBox="0 0 420 {h}" role="img" aria-label="{esc(label + ": " + ", ".join(f"{v} {k}" for k, v in items))}">']
    for i, (k, v) in enumerate(items):
        y = 4 + 26 * i
        w = max(2, round(220 * v / top))
        parts.append(f'<text x="0" y="{y + 15}" class="lbl">{esc(k[:22])}</text>'
                     f'<rect x="150" y="{y + 2}" width="{w}" height="18" rx="3" fill="{color}"><title>{esc(k)}: {v}</title></rect>'
                     f'<text x="{156 + w}" y="{y + 15}" class="lbl">{v}</text>')
    parts.append("</svg>")
    return _card(title, "".join(parts))


def _doughnut(title: str, data: dict) -> str:
    import math
    items = [(k, v) for k, v in data.items() if v]
    total = sum(v for _, v in items)
    if not total:
        return _card(title, '<p class="empty">No data</p>')
    cx = cy = 80
    r, ri = 70, 42
    parts = [f'<svg viewBox="0 0 300 160" role="img" aria-label="{esc(title + ": " + ", ".join(f"{v} {k}" for k, v in items))}">']
    ang = -math.pi / 2
    for k, v in items:
        color = COLORS.get(k, "#94a3b8")
        if len(items) == 1:
            parts.append(f'<circle cx="{cx}" cy="{cy}" r="{(r + ri) / 2}" fill="none" stroke="{color}" stroke-width="{r - ri}"><title>{esc(k)}: {v}</title></circle>')
        else:
            a2 = ang + 2 * math.pi * v / total
            big = 1 if a2 - ang > math.pi else 0
            p = lambda rr, a: f"{cx + rr * math.cos(a):.2f} {cy + rr * math.sin(a):.2f}"  # noqa: E731
            parts.append(f'<path d="M {p(r, ang)} A {r} {r} 0 {big} 1 {p(r, a2)} L {p(ri, a2)} A {ri} {ri} 0 {big} 0 {p(ri, ang)} Z" fill="{color}"><title>{esc(k)}: {v}</title></path>')
            ang = a2
    for i, (k, v) in enumerate(items):
        y = 20 + 20 * i
        parts.append(f'<rect x="170" y="{y - 10}" width="12" height="12" fill="{COLORS.get(k, "#94a3b8")}"/><text x="188" y="{y}" class="lbl">{esc(k)} {v}</text>')
    parts.append("</svg>")
    return _card(title, "".join(parts))


def _card(title: str, body: str) -> str:
    return f'<div class="chart-card"><h3>{esc(title)}</h3>{body}</div>'


# ---------------------------------------------------------------- page

CSS = """
:root{--bg:#f1f5f9;--fg:#0f172a;--card:#fff;--mut:#64748b;--line:#e2e8f0;--alt:#f8fafc}
@media (prefers-color-scheme:dark){:root{--bg:#0f172a;--fg:#e2e8f0;--card:#1e293b;--mut:#94a3b8;--line:#334155;--alt:#172033}}
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:baseline}h1{margin:0;font-size:24px}.mut{color:var(--mut);font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:18px 0}
.stat{background:var(--card);border-left:5px solid var(--c);border-radius:6px;padding:12px 14px;box-shadow:0 1px 3px #0002}.stat b{display:block;font-size:28px}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:14px;margin-bottom:18px}
.chart-card{background:var(--card);border-radius:6px;padding:12px 14px;box-shadow:0 1px 3px #0002}.chart-card h3{margin:0 0 8px;font-size:15px}
.lbl{font-size:12px;fill:var(--fg)}.empty{color:var(--mut)}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}select,input{padding:6px 8px;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--fg);font:inherit}
.tablewrap{overflow-x:auto;background:var(--card);border-radius:6px;box-shadow:0 1px 3px #0002}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:7px 9px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
th{cursor:pointer;white-space:nowrap}tbody tr:nth-child(even){background:var(--alt)}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;color:#fff;font-size:12px;white-space:nowrap}
.flag{display:inline-block;margin:0 2px 2px 0;padding:0 6px;border-radius:3px;background:#fef3c7;color:#92400e;font-size:11px}
.overdue{color:#dc2626;font-weight:600}.soon{color:#d97706;font-weight:600}
a{color:#2563eb}footer{margin-top:18px}
"""

JS = """
(function(){
var q=document.getElementById('q'),fs=document.getElementById('f-stage'),fo=document.getElementById('f-source'),fd=document.getElementById('f-due');
var rows=[].slice.call(document.querySelectorAll('#tbl tbody tr')),n=document.getElementById('shown');
function apply(){var t=q.value.toLowerCase(),c=0;rows.forEach(function(r){
var ok=(!t||r.getAttribute('data-q').indexOf(t)>-1)&&(!fs.value||r.getAttribute('data-stage')===fs.value)&&(!fo.value||r.getAttribute('data-source')===fo.value)&&(!fd.checked||r.getAttribute('data-due')==='1');
r.style.display=ok?'':'none';if(ok)c++;});n.textContent=c;}
[q,fs,fo,fd].forEach(function(e){e.addEventListener('input',apply);});
[].slice.call(document.querySelectorAll('#tbl th')).forEach(function(th,i){th.addEventListener('click',function(){
var tb=document.querySelector('#tbl tbody'),dir=th.getAttribute('data-dir')==='asc'?-1:1;th.setAttribute('data-dir',dir===1?'asc':'desc');
rows.sort(function(a,b){var x=a.children[i].getAttribute('data-v')||a.children[i].textContent,y=b.children[i].getAttribute('data-v')||b.children[i].textContent,nx=parseFloat(x),ny=parseFloat(y);
if(!isNaN(nx)&&!isNaN(ny))return(nx-ny)*dir;return x.localeCompare(y)*dir;});rows.forEach(function(r){tb.appendChild(r);});});});
})();
"""


def _truncate(text: str, n: int = 80) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"


def _row_html(r: dict) -> str:
    color = COLORS.get(r["stage"], "#94a3b8")
    src = r["source"]
    link = r.get("url") or (src if src.lower().startswith("http") else "")
    if link.lower().startswith(("http://", "https://")):
        label = r["source"] if r.get("url") and r["source"] else "link"
        src_cell = f'<a href="{esc(link)}" target="_blank" rel="noopener noreferrer">{esc(label if not src.lower().startswith("http") else "link")}</a>'
    else:
        src_cell = esc(src) or "—"
    flags = "".join(f'<span class="flag">{esc(f)}</span>' for f in r["flags"]) or "—"
    due = f'<span class="{r["due_state"]}" title="{esc(r["due_kind"])}">{esc(r["due"])} ({esc(r["due_kind"])})</span>' if r["due"] else "—"
    score = "—" if r["score"] is None else f'{r["score"]}'
    stage_label = r["stage"] + ("" if r["origin"] != "shortlist" else " ★")
    haystack = " ".join([r["company"], r["role"], r["sector"], r["source"]]).lower()
    cells = [
        (esc(r["date"]) or "—", ""), (due, r["due"]), (esc(r["company"]) or "—", ""), (esc(r["role"]) or "—", ""),
        (esc(r["sector"]) or "—", ""), (esc(r["channel"]) or "—", ""),
        (f'<span class="pill" style="background:{color}">{esc(stage_label)}</span>', ""),
        (score, "" if r["score"] is None else str(r["score"])), (flags, ""),
        (f'<span title="{esc(r["notes"])}">{esc(_truncate(r["notes"])) or "—"}</span>', ""), (src_cell, ""),
    ]
    tds = "".join(f'<td data-v="{esc(v)}">{c}</td>' if v else f"<td>{c}</td>" for c, v in cells)
    return (f'<tr data-q="{esc(haystack)}" data-stage="{esc(r["stage"])}" data-source="{esc(r["source"])}" '
            f'data-due="{1 if r["due_state"] in ("overdue", "soon") else 0}">{tds}</tr>')


def render_html(data: dict) -> str:
    s = data["stats"]
    cards = "".join(
        f'<div class="stat" style="--c:{COLORS[k]}"><b>{s["stage_counts"][k]}</b>{esc(k)}</div>'
        for k in ("Ranked", "Drafted", "Active", "Interview", "Offer", "Hired", "Rejected/Closed"))
    cards += (f'<div class="stat" style="--c:#dc2626"><b>{s["due_count"]}</b>Due / overdue ({s["overdue_count"]} overdue)</div>'
              f'<div class="stat" style="--c:#0ea5e9"><b>{s["shortlist"]}</b>On shortlist</div>')
    charts = (_doughnut("Pipeline by stage", {k: v for k, v in s["stage_counts"].items()})
              + _bar_chart("By sector (applied)", s["sectors"], "#3b82f6", "By sector")
              + _bar_chart("By source (all rows)", s["sources"], "#0ea5e9", "By source")
              + _bar_chart("Application funnel", s["funnel"], "#8b5cf6", "Funnel"))
    rows = sorted(data["rows"], key=lambda r: (r["date"], r["company"].lower()), reverse=True)
    sources = sorted({r["source"] for r in rows if r["source"]})
    stages = ["Ranked", *BUCKETS]
    opt = lambda vals: "".join(f'<option value="{esc(v)}">{esc(v)}</option>' for v in vals)  # noqa: E731
    head = "".join(f"<th>{h}</th>" for h in ("Date", "Due", "Company", "Role", "Sector", "Channel", "Stage", "Score", "Flags", "Notes", "Source"))
    unknown = (f'<p class="mut">Unrecognised statuses counted as Rejected/Closed: {esc(", ".join(data["unknown_statuses"]))}</p>'
               if data["unknown_statuses"] else "")
    rate = "n/a" if s["rejection_rate"] is None else f'{s["rejection_rate"]}%'
    funnel = s["funnel"]
    prog = "n/a" if not funnel["Applied"] else f'{round(100 * funnel["Interview"] / funnel["Applied"])}%'
    body = f"""<header><h1>Job Search Dashboard</h1><span class="mut">Generated: {esc(data["today"])}</span></header>
<div class="cards">{cards}</div>
<p class="mut">Applications sent: {s["sent"]} · progressed past resume screen: {prog} · rejection rate: {rate}. Drafted rows are excluded from statistics.</p>{unknown}
<div class="charts">{charts}</div>
<h2>Pipeline</h2>
<div class="filters"><input id="q" type="search" placeholder="Search company, role, sector, source" aria-label="Search">
<select id="f-stage" aria-label="Stage"><option value="">All stages</option>{opt(stages)}</select>
<select id="f-source" aria-label="Source"><option value="">All sources</option>{opt(sources)}</select>
<label><input id="f-due" type="checkbox"> Due or overdue only</label>
<span class="mut">Showing <span id="shown">{len(rows)}</span> of {len(rows)}</span></div>
<div class="tablewrap"><table id="tbl"><thead><tr>{head}</tr></thead><tbody>{"".join(_row_html(r) for r in rows)}</tbody></table></div>
<footer class="mut">Generated by jobseek · ported from ai-job-search /html-report (MIT) · {esc(data["today"])}</footer>"""
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>Job Search Dashboard</title><style>{CSS}</style></head><body>{body}<script>{JS}</script></body></html>\n')


def write_dashboard(data: dict, path: Path | str) -> Path:
    out = Path(path).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_html(data), encoding="utf-8", newline="\n")
    return out


def build_dashboard(open_browser: bool = False, output: Path | str | None = None,
                    cfg: dict | None = None, today: date | None = None) -> Path:
    """Regenerate the dashboard and return its path; optionally open it with
    the platform default handler."""
    cfg = cfg or jobseek_config.load_config()
    out = write_dashboard(collect(cfg, today), output or default_output_path(cfg))
    if open_browser:
        webbrowser.open(out.resolve().as_uri())
    return out
