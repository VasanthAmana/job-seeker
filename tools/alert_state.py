#!/usr/bin/env python3
"""Seen-jobs store for `run-alerts`: dedupe alert links, keep history out of
the agent context.

Adapted from ai-job-search's tools/scrape_state.py (MIT, see jobseek/NOTICE).
The upstream tool dedupes portal-CLI search hits; this one dedupes posting
links extracted from Gmail alert emails. The differences that matter:

  * Candidates need only a valid URL. Title and company are often unknown
    until the posting is fetched (an alert email's anchor text is a hint, not
    an identity), so they are required at `store` time, not at `candidates`.
  * Dedupe is by canonical URL and by company+title pair against both the
    seen-jobs store and the tracker, plus repeats inside the batch itself.
  * `store` writes state/seen_jobs.json atomically and refuses a canonical
    key that already belongs to another posting.

Usage:
  python3 jobseek/tools/alert_state.py candidates --results links.json
  python3 jobseek/tools/alert_state.py store --results enriched.json

Both read a JSON array. candidates prints {"selected": [...], counts...};
store prints {"added": [keys...], counts...} and persists. Exit 0 on success,
1 on a usage or validation error.
"""

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

import config as jobseek_config
from job_key import make_key
from rank_state import STATE, TRACKER, load_state, norm, save_state, tracker_pairs
from url_canon import canonicalize_url

JOBSEEK_ROOT = Path(__file__).resolve().parent.parent
if str(JOBSEEK_ROOT) not in sys.path:
    sys.path.insert(0, str(JOBSEEK_ROOT))
from sources.registry import SOURCE_IDS  # noqa: E402

# Fields `store` requires. `source` is the alert channel - see the source
# registry (jobseek/sources/registry.py) for the registered set.
REQUIRED_STORE_FIELDS = ("title", "company", "url", "source", "first_seen", "status")
STORE_STATUSES = ("new", "skipped", "expired")
SOURCES = SOURCE_IDS


def read_jobs(path: Path) -> list:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read {path}: {exc}") from exc
    if isinstance(data, dict):
        data = data.get("results")
    if not isinstance(data, list):
        raise ValueError("results must be a JSON array of jobs")
    return data


def candidate_url(job: dict) -> str:
    """A candidate's identity at ingest time is its canonicalised posting URL."""
    url = job.get("url")
    if not isinstance(url, str) or not url.strip():
        raise ValueError("job needs a non-empty url")
    url = url.strip()
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(f"job has an invalid posting URL: {url}")
    return canonicalize_url(url)


def validate_stored(job: dict) -> None:
    for field in REQUIRED_STORE_FIELDS:
        value = job.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"job needs a non-empty {field} before storage")
    candidate_url(job)
    if job["status"] not in STORE_STATUSES:
        raise ValueError(f"job has an invalid status {job['status']!r}; expected one of {', '.join(STORE_STATUSES)}")
    if job["source"] not in SOURCES:
        raise ValueError(f"job has an invalid source {job['source']!r}; expected one of {', '.join(SOURCES)}")


def select(jobs: list, seen: dict, tracker: set) -> tuple[list[dict], dict]:
    urls, pairs = set(), set()
    for entry in seen.values():
        if not isinstance(entry, dict):
            raise ValueError("state/seen_jobs.json contains a non-object entry")
        if isinstance(entry.get("url"), str):
            # Canonicalise on read too: existing entries were stored under the
            # old raw-URL identity, so this matches them against a fresh
            # canonical URL without migrating state/seen_jobs.json.
            urls.add(canonicalize_url(entry["url"]))
        pairs.add((norm(entry.get("company")), norm(entry.get("title"))))

    selected = []
    counts = {"already_seen": 0, "already_applied": 0, "repeated_in_batch": 0, "invalid": []}
    batch_urls, batch_pairs = set(), set()
    for index, job in enumerate(jobs):
        try:
            if not isinstance(job, dict):
                raise ValueError("job is not an object")
            url = candidate_url(job)
        except ValueError as exc:
            counts["invalid"].append({"index": index, "error": str(exc)})
            continue
        # Company+title may be empty pre-fetch; only pair-dedupe when both exist.
        pair = (norm(job.get("company")), norm(job.get("title")))
        has_pair = all(pair)
        if url in urls or (has_pair and pair in pairs):
            counts["already_seen"] += 1
        elif has_pair and pair in tracker:
            counts["already_applied"] += 1
        elif url in batch_urls or (has_pair and pair in batch_pairs):
            counts["repeated_in_batch"] += 1
        else:
            selected.append(job)
            batch_urls.add(url)
            if has_pair:
                batch_pairs.add(pair)
    return selected, counts


def run(args) -> int:
    with jobseek_config.state_lock(args.state):
        if args.state.exists():
            doc, seen = load_state(args.state)
        else:
            doc = {"seen": {}}
            seen = doc["seen"]
        jobs = read_jobs(args.results)
        selected, counts = select(jobs, seen, tracker_pairs(args.tracker))
        if args.command == "candidates":
            print(json.dumps({"selected": selected, **counts}, ensure_ascii=False))
            return 0

        for job in selected:
            try:
                validate_stored(job)
            except ValueError as exc:
                raise ValueError(f"{job.get('url', '?')}: {exc}") from exc
            key = make_key(job["company"], job["title"], job["url"])
            if key in seen:
                raise ValueError(f"canonical key already exists for another posting: {key}")
            seen[key] = job
        if selected:
            args.state.parent.mkdir(parents=True, exist_ok=True)
            save_state(args.state, doc)
        print(json.dumps({"added": [make_key(j["company"], j["title"], j["url"]) for j in selected], **counts}, ensure_ascii=False))
        return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="alert_state.py", description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=("candidates", "store"))
    parser.add_argument("--results", type=Path, required=True, help="JSON array of jobs")
    parser.add_argument("--state", type=Path, default=STATE)
    parser.add_argument("--tracker", type=Path, default=TRACKER)
    args = parser.parse_args(argv)
    try:
        return run(args)
    except ValueError as exc:
        print(f"alert_state: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
