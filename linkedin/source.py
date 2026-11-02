#!/usr/bin/env python3
"""LinkedIn saved-search source for `/run-alerts`.

Runs the owner's configured LinkedIn saved searches (query, locations,
experience levels, remote) through the vendored `jobseek/linkedin/app`
Electron app's signed-in session, via `jobseek/linkedin/client.py`, and
emits candidate links in the exact shape `tools/alert_state.py` already
consumes. This is a new *source* feeding the SAME dedupe store the
Gmail-alert path writes to - same job_key scheme, same seen_jobs.json, same
downstream fetch/guard/rank/tailor/notion_sync stages - never a parallel
pipeline.

Saved searches come from `jobseek/config.json`'s `linkedin.saved_searches`
(see `tools/config.py:linkedin_saved_searches` and
`config.example.json`) - the same config file the Gmail path already reads,
never a separate one.

Usage:
  python3 jobseek/linkedin/source.py candidates [--jobseek-config PATH]

Prints one JSON object:
  {"searches": N, "jobs": M, "links": [...], "errors": [...]}`
where each link is `{"url", "source": "linkedin", "anchor_title", "title",
"company", "location", "message_id", "alert_date"}` - ready to concatenate
with Gmail-derived links (`tools/gmail_alerts.py`) into one array before
`tools/alert_state.py candidates`.

A saved search that cannot reach the LinkedIn app (not running, not signed
in, pace-capped) is reported in `errors` with the exact "LinkedIn needs
you"-style message; it is NOT a fatal error for the whole run, since a
Gmail-only run must still work when the LinkedIn app is closed. Exit 1 only
on a config error (unreadable/malformed `config.json`); exit 0 otherwise,
even when every search errored - callers decide whether an empty
LinkedIn source should stop the run.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import client as linkedin_client  # noqa: E402
import config as jobseek_config  # noqa: E402


def _job_url(job: dict) -> str | None:
    url = job.get("url")
    if isinstance(url, str) and url.strip():
        return url.strip()
    job_id = job.get("jobId") or job.get("job_id")
    if job_id:
        return f"https://www.linkedin.com/jobs/view/{job_id}/"
    return None


def _to_candidate(job: dict, search: dict, today: str) -> dict | None:
    url = _job_url(job)
    if not url:
        return None
    title = job.get("title") or ""
    company = job.get("company") or ""
    job_id = job.get("jobId") or job.get("job_id") or ""
    candidate = {
        "url": url,
        "source": "linkedin",
        "anchor_title": title,
        "message_id": f"linkedin:{job_id}" if job_id else f"linkedin:{url}",
        "alert_date": today,
    }
    if title:
        candidate["title"] = title
    if company:
        candidate["company"] = company
    location = job.get("location")
    if location:
        candidate["location"] = location
    candidate["saved_search"] = search.get("name") or search.get("query", "")[:40]
    return candidate


def run_search(search: dict, *, endpoint: str | None = None) -> tuple[list[dict], str | None]:
    """One configured saved search -> (candidates, error). `error` is a
    one-line "LinkedIn needs you"-style message when the search could not
    run at all; candidates is always a list (possibly empty)."""
    query = search.get("query")
    if not query:
        return [], f"saved search {search.get('name', '?')!r} has no query"
    locations = search.get("locations") or [None]
    today = date.today().isoformat()
    candidates: list[dict] = []
    for location in locations:
        try:
            result = linkedin_client.search_jobs(
                query,
                location=location,
                remote=search.get("remote"),
                experience_levels=search.get("experience_levels"),
                date_posted=search.get("date_posted"),
                job_type=search.get("job_type"),
                limit=search.get("limit"),
                endpoint=endpoint,
            )
        except linkedin_client.LinkedInError as exc:
            return candidates, str(exc)
        for job in result.get("jobs") or []:
            candidate = _to_candidate(job, search, today)
            if candidate:
                candidates.append(candidate)
    return candidates, None


def candidates(cfg: dict, *, endpoint: str | None = None) -> dict:
    searches = jobseek_config.linkedin_saved_searches(cfg)
    links: list[dict] = []
    errors: list[dict] = []
    for search in searches:
        found, error = run_search(search, endpoint=endpoint)
        links.extend(found)
        if error:
            errors.append({"saved_search": search.get("name", "?"), "error": error})
    return {"searches": len(searches), "jobs": len(links), "links": links, "errors": errors}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="source.py", description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=("candidates",))
    parser.add_argument("--jobseek-config", type=Path, default=None)
    parser.add_argument("--endpoint", default=None, help="override the LinkedIn app's MCP endpoint (tests)")
    args = parser.parse_args(argv)
    try:
        cfg = jobseek_config.load_config(args.jobseek_config)
    except jobseek_config.ConfigError as exc:
        print(f"source: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(candidates(cfg, endpoint=args.endpoint), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
