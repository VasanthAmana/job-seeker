"""Read-only tool implementations behind the jobseek MCP server.

Kept separate from server.py (the stdio/JSON-RPC transport) so the tool
logic - and its input/output shapes - can be unit tested without speaking
the MCP wire protocol or touching stdin/stdout.

Every tool here only reads jobseek's own state: `run_alerts` is the one
exception that talks to the network (Gmail, read-only, GET-only - see
tools/gmail_alerts.py), everything else reads state/seen_jobs.json,
state/last_run.json or the config. Nothing here writes to the repo, to
Gmail, or sends anything.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

JOBSEEK_ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = JOBSEEK_ROOT / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import config as jobseek_config  # noqa: E402
import gmail_alerts  # noqa: E402
from rank_state import load_state  # noqa: E402


class ToolError(Exception):
    """A tool-level error (bad input, no such job): reported to the MCP
    client as a tool result with isError=True, not a transport failure."""


def _config():
    return jobseek_config.load_config()


def _seen(cfg: dict | None = None) -> dict:
    cfg = cfg or _config()
    state_path = jobseek_config.resolve_path(cfg, "seen_jobs")
    if not state_path.is_file():
        return {}
    _, seen = load_state(state_path)
    return seen


def _posting_summary(key: str, entry: dict) -> dict:
    return {
        "key": key,
        "title": entry.get("title"),
        "company": entry.get("company"),
        "location": entry.get("location"),
        "url": entry.get("url"),
        "source": entry.get("source"),
        "status": entry.get("status"),
        "rank_score": entry.get("rank_score"),
        "rank_verdict": entry.get("rank_verdict"),
        "score_10": round(entry["rank_score"] / 10, 1) if isinstance(entry.get("rank_score"), (int, float)) else None,
        "deadline": entry.get("deadline"),
        "reason": entry.get("reason"),
    }


def run_alerts(account: str | None = None, days: int | None = None) -> dict:
    """List job-alert email for one Gmail account and extract posting links.

    Read-only against Gmail (GET only, via tools/gmail_alerts.py) and does
    not write to jobseek's state - it is the "what's new" query, not the
    ingest step (which still runs through `/run-alerts` so a human/agent
    reviews and fetches each posting before anything is stored).
    """
    cfg = _config()
    account_entry = jobseek_config.resolve_account(cfg, account)
    account_dir = jobseek_config.account_dir(account_entry)
    alert_sources_path = jobseek_config.resolve_alert_sources(cfg)
    source_config = gmail_alerts.load_config(alert_sources_path)
    window = days if days is not None else cfg.get("days", 7)
    limit = cfg.get("limit", 50)
    query = gmail_alerts.build_query(source_config, window)
    result = gmail_alerts.fetch_alerts(account_dir, source_config, query, limit)
    result["account"] = account_entry.get("name")
    return result


def rank(top_n: int | None = None) -> dict:
    """The top N ranked postings currently in state/seen_jobs.json, highest
    score first. Vetoed/expired/unreachable entries are excluded."""
    cfg = _config()
    n = top_n if top_n is not None else jobseek_config.top_n(cfg)
    if n <= 0:
        raise ToolError("top_n must be a positive integer")
    seen = _seen(cfg)
    ranked = [
        (key, entry) for key, entry in seen.items()
        if entry.get("status") == "ranked"
        and entry.get("location_verdict") != "FAIL"
        and entry.get("seniority_gate") != "FAIL"
        and entry.get("engineering_role") is not True
    ]
    ranked.sort(key=lambda kv: kv[1].get("rank_score", 0), reverse=True)
    top = ranked[:n]
    return {"top_n": n, "count": len(top), "results": [_posting_summary(k, e) for k, e in top]}


def list_shortlist() -> dict:
    """The shortlist from the most recent `/run-alerts` run
    (state/last_run.json), or a freshly computed one when no run has
    happened yet."""
    cfg = _config()
    last_run_path = jobseek_config.resolve_path(cfg, "last_run")
    if last_run_path.is_file():
        try:
            data = json.loads(last_run_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ToolError(f"cannot read {last_run_path}: {exc}") from exc
        n = jobseek_config.top_n(cfg)
        ranked = data.get("ranked") if isinstance(data, dict) else None
        if isinstance(ranked, list):
            return {"source": "last_run", "top_n": n, "count": min(n, len(ranked)), "results": ranked[:n]}
    fallback = rank()
    return {"source": "seen_jobs", **fallback}


def get_posting(id: str) -> dict:
    """One posting's full stored record by its seen_jobs.json key."""
    if not id or not isinstance(id, str):
        raise ToolError("id must be a non-empty string")
    seen = _seen()
    entry = seen.get(id)
    if entry is None:
        raise ToolError(f"no posting with key {id!r}")
    return {"key": id, **entry}


def search_seen(query: str) -> dict:
    """Postings whose title, company or ranking reason contains `query`
    (case-insensitive substring match)."""
    if not query or not isinstance(query, str):
        raise ToolError("query must be a non-empty string")
    needle = query.lower()
    seen = _seen()
    matches = []
    for key, entry in seen.items():
        haystack = " ".join(
            str(entry.get(field) or "") for field in ("title", "company", "reason", "location")
        ).lower()
        if needle in haystack:
            matches.append(_posting_summary(key, entry))
    matches.sort(key=lambda r: r.get("rank_score") or 0, reverse=True)
    return {"query": query, "count": len(matches), "results": matches}


def tailor(job_id: str) -> dict:
    """Ground `jobseek/tailor`'s drafter-reviewer workflow on one stored
    posting.

    jobseek/tailor/tailor.md is a Claude Code slash-command workflow (a
    drafter-reviewer loop over the resume, not a deterministic script), so
    this tool is read-only prep: it looks up the posting and returns the
    paths and the `/tailor` invocation to run in a Claude Code session,
    rather than performing the tailoring itself.
    """
    entry = get_posting(job_id)
    tailor_root = JOBSEEK_ROOT / "tailor"
    return {
        "job": entry,
        "tailor_command_file": str(tailor_root / "tailor.md"),
        "candidate_profile": str(JOBSEEK_ROOT / "profile" / "candidate-profile.md"),
        "writing_style": str(JOBSEEK_ROOT / "profile" / "writing-style.md"),
        "invoke": f"/tailor {entry.get('url', '')}",
        "note": (
            "jobseek/tailor is an interactive drafter-reviewer workflow "
            "(tailor.md), not a deterministic script - run the `invoke` "
            "command in a Claude Code session to actually draft anything."
        ),
    }


# name -> (callable, JSON Schema for its arguments)
TOOLS = {
    "run_alerts": (
        run_alerts,
        {
            "type": "object",
            "properties": {
                "account": {"type": "string", "description": "named account from jobseek/config.json (default: config's default_account)"},
                "days": {"type": "integer", "minimum": 1, "description": "look-back window in days (default: from config)"},
            },
            "additionalProperties": False,
        },
    ),
    "rank": (
        rank,
        {
            "type": "object",
            "properties": {
                "top_n": {"type": "integer", "minimum": 1, "description": "how many ranked postings to return (default: from config)"},
            },
            "additionalProperties": False,
        },
    ),
    "list_shortlist": (
        list_shortlist,
        {"type": "object", "properties": {}, "additionalProperties": False},
    ),
    "get_posting": (
        get_posting,
        {
            "type": "object",
            "properties": {"id": {"type": "string", "description": "the posting's seen_jobs.json key"}},
            "required": ["id"],
            "additionalProperties": False,
        },
    ),
    "search_seen": (
        search_seen,
        {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "substring to match against title/company/reason/location"}},
            "required": ["query"],
            "additionalProperties": False,
        },
    ),
    "tailor": (
        tailor,
        {
            "type": "object",
            "properties": {"job_id": {"type": "string", "description": "the posting's seen_jobs.json key"}},
            "required": ["job_id"],
            "additionalProperties": False,
        },
    ),
}


TOOL_DESCRIPTIONS = {
    "run_alerts": "List recent job-alert email for one Gmail account and extract posting links (read-only, does not change stored state).",
    "rank": "Return the top-N ranked postings from stored state, highest score first.",
    "list_shortlist": "Return the shortlist from the most recent /run-alerts run.",
    "get_posting": "Look up one stored posting by its key.",
    "search_seen": "Search stored postings by title/company/reason/location substring.",
    "tailor": "Ground the jobseek/tailor workflow on one stored posting (read-only prep; drafting itself runs as a Claude Code /tailor session).",
}


def call_tool(name: str, arguments: dict | None) -> dict:
    """Validate `name` and dispatch with `arguments` as keyword args.
    Raises ToolError or TypeError on bad input; callers map that to an
    MCP error result."""
    if name not in TOOLS:
        raise ToolError(f"unknown tool {name!r}")
    func, _schema = TOOLS[name]
    arguments = arguments or {}
    if not isinstance(arguments, dict):
        raise ToolError("arguments must be an object")
    return func(**arguments)
