#!/usr/bin/env python3
"""Aggregation for `/upskill`: merge tracker rows with ranked postings into
the weighted job list the skill-gap heatmap is built from.

Adapted from the deterministic parts of ai-job-search's
`.claude/skills/upskill/SKILL.md` Steps 2-3 (MIT, see jobseek/NOTICE). The
markdown spec at `jobseek/upskill/upskill.md` remains the implementation of
the analysis itself (skill extraction, profile diff, synthesis, learning
plan); this tool owns the merge so the conversation never hand-reads state
files - the same "state moves through tools" rule `rank_state.py` follows:

  * ranked pool: `status == "ranked"` and `rank_score >= 45` (the Moderate
    Fit floor from profile/job-evaluation.md; below it the heatmap would
    drown in jobs the owner should not chase);
  * dedupe: tracker rows match ranked entries on case-insensitive
    company + title (the tracker's `role` column against the entry's
    `title` field) via rank_state.norm - the same join
    `rank_state.py candidates` uses for tracker exclusion;
  * one weight per job, both 0-100 on the same scale: tracker rows use
    `(100 - fit_rating) / 100`, ranked-only entries `(100 - rank_score) /
    100`, and a job in both prefers the tracker's numeric `fit_rating`;
  * a blank or non-numeric `fit_rating` falls back to the matched ranked
    entry's `rank_score`, otherwise the row is skipped and counted - never
    treated as 0, which would read as weight 1.0 (the maximum) and let the
    one job the framework knows nothing about dominate the heatmap;
  * recorded `gaps` bullets beat inference: an entry with no `gaps` field
    (ranked before gap persistence) is skipped and counted, never
    back-filled from its title.

Stored gap bullets are untrusted third-party posting text (see
jobseek/CLAUDE.md trust rule 1): this tool carries them, never acts on them.

Usage:
  python3 jobseek/tools/upskill_state.py aggregate [--state PATH] [--tracker PATH]
      [--reports-dir DIR] [--today YYYY-MM-DD] [--floor N]

Prints JSON on stdout. Exit 0 on success, 1 on a usage or state-format error.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as jobseek_config  # noqa: E402
from rank_state import norm  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

_JOBSEEK_CONFIG = jobseek_config.load_config()
STATE = jobseek_config.resolve_path(_JOBSEEK_CONFIG, "seen_jobs")
TRACKER = jobseek_config.resolve_path(_JOBSEEK_CONFIG, "tracker")

REPORTS_DIR = jobseek_config.resolve_path(_JOBSEEK_CONFIG, "upskill_reports")
PROFILE = ROOT / "profile" / "candidate-profile.md"

# The Moderate Fit floor from profile/job-evaluation.md's verdict bands.
DEFAULT_FLOOR = 45

REPORT_NAME = re.compile(r"^report-(\d{4}-\d{2}-\d{2})\.md$")


class UpskillStateError(ValueError):
    """A state file that exists but cannot be read as its expected format."""


def load_seen(path: Path) -> dict:
    """The seen-map from seen_jobs.json, or {} when the file does not exist
    yet (a fresh search has no ranked postings; that is data, not an error).
    A present-but-malformed file is an error - silently treating it as empty
    would report a heatmap of nothing over a real store."""
    if not path.is_file():
        return {}
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise UpskillStateError(f"{path} is not valid JSON: {exc}") from exc
    seen = doc.get("seen") if isinstance(doc, dict) and "seen" in doc else doc
    if not isinstance(seen, dict):
        raise UpskillStateError(f"{path}: expected an object of job entries")
    return seen


def load_tracker(path: Path) -> list[dict]:
    """Tracker rows as dicts (header from tracker.schema.csv), or [] when the
    tracker does not exist yet. UTF-8 only, like rank_state.tracker_pairs."""
    if not path.is_file():
        return []
    try:
        with path.open(encoding="utf-8-sig", newline="") as fh:
            return [row for row in csv.DictReader(fh)]
    except UnicodeDecodeError as exc:
        raise UpskillStateError(f"{path} is not UTF-8 text - re-save it as CSV UTF-8") from exc


def parse_fit_rating(value) -> float | None:
    """A 0-100 numeric fit rating, or None for anything else: blank,
    non-numeric, out of range. None means 'contributes no weight' - never 0,
    which would read as the maximum weight 1.0."""
    try:
        rating = float(str(value or "").strip())
    except ValueError:
        return None
    return rating if 0 <= rating <= 100 else None


def weight(score_100: float) -> float:
    return round((100 - score_100) / 100, 3)


def ranked_pool(seen: dict, floor: int) -> tuple[dict, list[dict], int]:
    """Split stored entries into (pool, skipped_no_gaps, below_floor_count).

    The pool holds ranked entries at or above the floor that carry a recorded
    `gaps` field; entries without one were scored before gap persistence and
    are skipped and counted, never back-filled. An empty gaps list is a real
    record (the scorer found no gaps), not a missing field.
    """
    pool: dict[tuple[str, str], tuple[str, dict]] = {}
    skipped_no_gaps: list[dict] = []
    below_floor = 0
    for key, entry in seen.items():
        if entry.get("status") != "ranked":
            continue
        score = entry.get("rank_score")
        if not isinstance(score, (int, float)) or isinstance(score, bool) or score < floor:
            below_floor += 1
            continue
        if "gaps" not in entry or not isinstance(entry.get("gaps"), list):
            skipped_no_gaps.append(
                {"key": key, "title": entry.get("title"), "company": entry.get("company")}
            )
            continue
        pair = (norm(entry.get("company")), norm(entry.get("title")))
        pool.setdefault(pair, (key, entry))
    return pool, skipped_no_gaps, below_floor


def aggregate(seen: dict, tracker_rows: list[dict], floor: int = DEFAULT_FLOOR) -> dict:
    """Merge tracker rows and ranked pool entries into one weighted job list.

    A job present in both counts once. Recorded gap bullets (from the ranked
    entry) are the job's skill list when present; otherwise the row is
    flagged `needs_inference` and the `/upskill` workflow infers likely
    competency requirements from role/sector/notes.
    """
    pool, skipped_no_gaps, below_floor = ranked_pool(seen, floor)

    jobs: list[dict] = []
    matched_pairs: set[tuple[str, str]] = set()
    skipped_blank_fit = 0

    for row in tracker_rows:
        company = (row.get("company") or "").strip()
        role = (row.get("role") or "").strip()
        if not company and not role:
            continue
        pair = (norm(company), norm(role))
        match = pool.get(pair)
        rating = parse_fit_rating(row.get("fit_rating"))
        if rating is None and match is None:
            # /outcome-style rows never got a fit evaluation, and there is no
            # ranked score to fall back on: skip + count, never guess.
            skipped_blank_fit += 1
            continue
        job = {
            "key": match[0] if match else None,
            "title": role or (match[1].get("title") if match else None),
            "company": company or (match[1].get("company") if match else None),
            "sources": "both" if match else "tracker",
            "weight": weight(rating) if rating is not None else weight(match[1]["rank_score"]),
            "weight_basis": "fit_rating" if rating is not None else "rank_score",
            "recorded_gaps": [str(b) for b in match[1]["gaps"]] if match else [],
            "needs_inference": match is None,
            "tracker": {
                "sector": row.get("sector") or None,
                "role_type": row.get("role_type") or None,
                "status": row.get("status") or None,
                "fit_rating": row.get("fit_rating") or None,
                "notes": row.get("notes") or None,
                "source": row.get("source") or None,
            },
            "ranked": _ranked_info(match[1]) if match else None,
        }
        if match:
            matched_pairs.add(pair)
        jobs.append(job)

    for pair, (key, entry) in pool.items():
        if pair in matched_pairs:
            continue
        jobs.append(
            {
                "key": key,
                "title": entry.get("title"),
                "company": entry.get("company"),
                "sources": "ranked",
                "weight": weight(entry["rank_score"]),
                "weight_basis": "rank_score",
                "recorded_gaps": [str(b) for b in entry["gaps"]],
                "needs_inference": False,
                "tracker": None,
                "ranked": _ranked_info(entry),
            }
        )

    jobs.sort(key=lambda j: (-j["weight"], str(j["company"] or ""), str(j["title"] or "")))
    return {
        "analysed": {
            "tracked": sum(1 for j in jobs if j["sources"] in ("tracker", "both")),
            "ranked": sum(1 for j in jobs if j["sources"] in ("ranked", "both")),
            "merged_total": len(jobs),
        },
        "skipped": {
            "ranked_below_floor": below_floor,
            "ranked_without_gaps": len(skipped_no_gaps),
            "ranked_without_gaps_entries": skipped_no_gaps,
            "tracker_blank_fit_rating": skipped_blank_fit,
        },
        "floor": floor,
        "jobs": jobs,
    }


def _ranked_info(entry: dict) -> dict:
    return {
        "rank_score": entry.get("rank_score"),
        "rank_verdict": entry.get("rank_verdict"),
        "url": entry.get("url"),
        "source": entry.get("source"),
        "reason": entry.get("reason"),
        "strengths": entry.get("strengths") or [],
    }


def find_previous_report(reports_dir: Path) -> Path | None:
    """The most recent aggregate report (`report-YYYY-MM-DD.md`) in
    reports_dir, or None. Targeted reports carry a slug suffix and never
    count - the diff in `/upskill` Step 8 is aggregate-to-aggregate only."""
    if not reports_dir.is_dir():
        return None
    dated = []
    for path in reports_dir.iterdir():
        match = REPORT_NAME.match(path.name)
        if match and path.is_file():
            dated.append((match.group(1), path))
    return max(dated)[1] if dated else None


def build_payload(
    cfg: dict | None = None,
    *,
    state_path: Path | None = None,
    tracker_path: Path | None = None,
    reports_dir: Path | None = None,
    profile_path: Path | None = None,
    floor: int = DEFAULT_FLOOR,
    today: date | None = None,
) -> dict:
    """The full `/upskill` aggregate payload: merged jobs, skip counts, and
    the profile/report paths the workflow reads and writes."""
    cfg = cfg or jobseek_config.load_config()
    state_path = state_path or jobseek_config.resolve_path(cfg, "seen_jobs")
    tracker_path = tracker_path or jobseek_config.resolve_path(cfg, "tracker")
    reports_dir = reports_dir or jobseek_config.resolve_path(cfg, "upskill_reports")
    profile_path = profile_path or PROFILE
    today = today or date.today()
    seen = load_seen(state_path)
    tracker_rows = load_tracker(tracker_path)
    payload = aggregate(seen, tracker_rows, floor=floor)
    previous = find_previous_report(reports_dir)
    payload.update(
        {
            "state_file": str(state_path),
            "tracker_file": str(tracker_path),
            "profile": str(profile_path),
            "previous_report": str(previous) if previous else None,
            "report_path": str(reports_dir / f"report-{today.isoformat()}.md"),
        }
    )
    return payload


def _force_utf8_output() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8")


def main(argv=None) -> int:
    _force_utf8_output()
    ap = argparse.ArgumentParser(prog="upskill_state.py", description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="command", required=True)

    agg = sub.add_parser("aggregate", help="merge tracker rows and ranked postings for /upskill")
    agg.add_argument("--state", type=Path, default=STATE)
    agg.add_argument("--tracker", type=Path, default=TRACKER)
    agg.add_argument("--reports-dir", type=Path, default=REPORTS_DIR)
    agg.add_argument("--profile", type=Path, default=PROFILE)
    agg.add_argument("--floor", type=int, default=DEFAULT_FLOOR,
                     help="minimum rank_score for ranked postings (default: %(default)s, the Moderate Fit floor)")
    agg.add_argument("--today", type=date.fromisoformat, default=date.today())

    args = ap.parse_args(argv)
    try:
        payload = build_payload(
            state_path=args.state,
            tracker_path=args.tracker,
            reports_dir=args.reports_dir,
            profile_path=args.profile,
            floor=args.floor,
            today=args.today,
        )
    except UpskillStateError as exc:
        sys.exit(str(exc))
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
