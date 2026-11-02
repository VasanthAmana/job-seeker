#!/usr/bin/env python3
"""State helper for `run-alerts` ranking: select candidates and write results
back.

Adapted from ai-job-search's tools/rank_state.py (MIT, see jobseek/NOTICE).
The state machine is the same - candidate selection, result apply, deadline
sweep, unreachable-retry, atomic writes - rebased onto the jobseek layout
(state/seen_jobs.json, tracker.csv) and the Director/VP rubric in
profile/job-evaluation.md:

  * scoring dimensions are the jobseek rubric's: domain 30%, leadership 25%,
    behavioral 15%, career 30% (location unweighted);
  * two extra gates: `seniority_gate` (PASS/FAIL/FLAG - the Director/VP
    seniority check) and `engineering_role` (bool - the boolean-query NOT
    list: engineer/developer/scientist/architect IC roles);
  * a seniority FAIL or engineering_role=true vetoes the shortlist exactly
    like a location FAIL; a seniority FLAG keeps the job ranked with a marker;
  * each scored row carries the guide's 1-10 score (`score_10`, derived from
    the weighted 0-100) and a one-line `reason`.

Nothing here fetches a posting or judges a fit. Scoring stays with the model;
this only removes the state file from the conversation.

Usage:
  python3 jobseek/tools/rank_state.py candidates [--all] [--focus TEXT] [--limit N]
  python3 jobseek/tools/rank_state.py sweep [--write] [--exclude KEY,KEY]
  python3 jobseek/tools/rank_state.py apply --results results.json [--dry-run] [--now ISO-DATETIME]

All subcommands print JSON on stdout. Exit 0 on success, 1 on a usage or
state error, or on `apply` when any result could not be written.
"""

import argparse
import json
import os
import re
import sys
import tempfile
import unicodedata
from datetime import date, datetime, timedelta, timezone
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "state" / "seen_jobs.json"
TRACKER = ROOT / "tracker.csv"

# profile/job-evaluation.md
WEIGHTS = {"domain": 0.30, "leadership": 0.25, "behavioral": 0.15, "career": 0.30}
BANDS = ((75, "Strong Fit"), (60, "Good Fit"), (45, "Moderate Fit"), (30, "Weak Fit"), (0, "Poor Fit"))

DEFAULT_LIMIT = 10
URGENT_DAYS = 7
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# The statuses a scoring agent may return (run-alerts Step 5). This module
# owns the set; tests assert the command's JSON contract names exactly these.
AGENT_STATUSES = ("scored", "expired", "unreachable")

# The values the veto gates may take. The veto is an exact match on "FAIL", so
# any other spelling would shortlist a deal-breaker.
GATE_VERDICTS = ("PASS", "FAIL", "FLAG")

# A posting that could not be fetched is `unreachable`, not `expired`, and is
# retried on later runs. It gives up to `expired` only after this many failed
# attempts with at least this long between the first and the last, so a
# scheduled run plus a manual one on the same day cannot burn every attempt
# on one outage.
UNREACHABLE_MAX_ATTEMPTS = 3
UNREACHABLE_MIN_SPAN = timedelta(hours=48)
FETCH_ERROR_MAX = 200
REASON_MAX = 200
RETRY_FIELDS = ("fetch_attempts", "first_unreachable", "last_fetch_error")
TIMESTAMP = "%Y-%m-%dT%H:%M:%SZ"


def load_state(path: Path) -> tuple[dict, dict]:
    """Return (document, seen-map). The map is mutated in place by callers."""
    if not path.is_file():
        sys.exit(f"{path} not found - run the run-alerts ingest first")
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        sys.exit(f"{path} is not valid JSON: {exc}")
    seen = doc.get("seen") if isinstance(doc, dict) and "seen" in doc else doc
    if not isinstance(seen, dict):
        sys.exit(f"{path}: expected an object of job entries")
    return doc, seen


def save_state(path: Path, doc: dict) -> None:
    """Atomic replace: a half-written seen_jobs.json loses the alert history."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".seen_jobs.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def parse_timestamp(value) -> datetime | None:
    """A stored UTC timestamp, or None for anything else (absent, malformed, a
    bare date) - the defensive-parse rule: never compared, never guessed."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.strptime(value.strip(), TIMESTAMP)
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc)


def parse_now(value: str) -> datetime:
    """--now: an ISO 8601 date-time; a naive value is taken as UTC."""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def parse_iso(value) -> date | None:
    """Anything that is not YYYY-MM-DD is treated exactly like an absent value:
    never compared, never guessed at."""
    if not isinstance(value, str) or not ISO.match(value.strip()):
        return None
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        return None


def norm(text) -> str:
    """Ignore case and separators without discarding non-Latin identity."""
    text = unicodedata.normalize("NFC", str(text or "").casefold())
    return "".join(
        char for char in text
        if char.isalnum() or unicodedata.category(char).startswith("M")
    )


def tracker_pairs(path: Path) -> set[tuple[str, str]]:
    """company+role pairs already in the tracker - out of scope for ranking."""
    if not path.is_file():
        return set()
    import csv

    pairs = set()
    try:
        with path.open(encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                company, role = norm(row.get("company")), norm(row.get("role"))
                if company:
                    pairs.add((company, role))
    except UnicodeDecodeError:
        sys.exit(f"{path} is not UTF-8 text - re-save it as CSV UTF-8")
    return pairs


def cmd_candidates(args) -> int:
    _, seen = load_state(args.state)
    excluded = tracker_pairs(args.tracker)

    selected, skipped_tracker = [], 0
    for key, entry in seen.items():
        status = entry.get("status")
        if args.all:
            if status == "skipped":
                continue
        elif status not in ("new", "unreachable"):
            continue
        if (norm(entry.get("company")), norm(entry.get("title"))) in excluded:
            skipped_tracker += 1
            continue
        if args.focus:
            haystack = " ".join(
                [str(entry.get("title") or ""), str(entry.get("company") or "")]
                + [str(b) for b in entry.get("strengths") or []]
                + [str(b) for b in entry.get("gaps") or []]
            ).lower()
            if args.focus.lower() not in haystack:
                continue
        selected.append(
            {
                "key": key,
                "title": entry.get("title"),
                "company": entry.get("company"),
                "url": entry.get("url"),
                "source": entry.get("source"),
                "deadline": entry.get("deadline"),
                "posted_date": entry.get("posted_date"),
            }
        )

    eligible = len(selected)
    if args.limit > 0:
        selected = selected[: args.limit]
    print(
        json.dumps(
            {
                "eligible": eligible,
                "selected": selected,
                "deferred": max(0, eligible - len(selected)),
                "excluded_by_tracker": skipped_tracker,
                "total_entries": len(seen),
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0


def cmd_sweep(args) -> int:
    doc, seen = load_state(args.state)
    today = args.today
    exclude = {k.strip() for k in (args.exclude or "").split(",") if k.strip()}

    expired, closing, unparseable, checked = [], [], [], 0
    for key, entry in seen.items():
        if entry.get("status") != "ranked" or key in exclude:
            continue
        checked += 1
        raw = entry.get("deadline")
        if raw in (None, ""):
            continue
        parsed = parse_iso(raw)
        if parsed is None:
            unparseable.append({"key": key, "source": entry.get("source"), "deadline": raw})
            continue
        row = {
            "key": key,
            "title": entry.get("title"),
            "company": entry.get("company"),
            "url": entry.get("url"),
            "deadline": raw,
        }
        if parsed < today:
            expired.append(row)
        elif (parsed - today).days <= URGENT_DAYS:
            closing.append(row)

    if args.write and expired:
        for row in expired:
            seen[row["key"]]["status"] = "expired"
        save_state(args.state, doc)

    print(
        json.dumps(
            {
                "swept": checked,
                "newly_expired": expired,
                "closing_soon": sorted(closing, key=lambda r: r["deadline"]),
                "unparseable_deadlines": unparseable,
                "written": bool(args.write and expired),
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0


def overall_score(scores: dict) -> int:
    if not isinstance(scores, dict):
        raise ValueError("scores must be an object")
    total = Fraction(0)
    for dim, weight in WEIGHTS.items():
        value = scores.get(dim)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"missing or non-numeric score '{dim}'")
        if not 0 <= value <= 100:
            raise ValueError(f"score '{dim}' must be finite and between 0 and 100")
        # Scores and documented percentage weights are decimal quantities.
        # Binary float summation can turn 59.5 into 59.49999999999999 and drop
        # an otherwise valid result into the lower verdict band.
        total += Fraction(str(value)) * Fraction(str(weight))
    return int(total + Fraction(1, 2))


def band(score: int) -> str:
    for floor, name in BANDS:
        if score >= floor:
            return name
    return "Poor Fit"


def score_10(score: int) -> float:
    """The guide's 1-10 ranking scale, derived from the weighted 0-100."""
    return round(score / 10, 1)


def _is_veto(row: dict) -> bool:
    """The hard gates: relocation, seniority mismatch, engineering IC role."""
    return (
        row.get("location_verdict") == "FAIL"
        or row.get("seniority_gate") == "FAIL"
        or row.get("engineering_role") is True
    )


def cmd_apply(args) -> int:
    doc, seen = load_state(args.state)
    today = args.today
    now = args.now
    try:
        results = json.loads(Path(args.results).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        sys.exit(f"cannot read results file {args.results}: {exc}")
    if isinstance(results, dict):
        results = results.get("results", [])
    if not isinstance(results, list):
        sys.exit("results file must be a JSON array of scoring objects")

    rows, expired, unreachable, gave_up, errors = [], [], [], [], []
    for result in results:
        if not isinstance(result, dict):
            errors.append({"key": None, "error": "result is not an object"})
            continue
        key = result.get("key")
        entry = seen.get(key) if isinstance(key, str) else None
        if entry is None:
            errors.append({"key": key, "error": "no such key in seen_jobs.json"})
            continue

        # A missing status is a score, as it always was; a misspelt one is an
        # error rather than a fall-through that reports a "missing score".
        status = result.get("status", "scored")
        if status not in AGENT_STATUSES:
            errors.append(
                {"key": key, "error": f"unknown status {status!r}; expected one of {', '.join(AGENT_STATUSES)}"}
            )
            continue

        if status == "unreachable":
            # A stored deadline that has already passed is positive evidence the
            # posting is closed, whatever the fetch did: expire it instead of
            # retrying it and later listing it as possibly live.
            deadline = parse_iso(entry.get("deadline"))
            if deadline is not None and deadline < today:
                entry["status"] = "expired"
                for field in (*RETRY_FIELDS, "expired_reason"):
                    entry.pop(field, None)
                expired.append(
                    {"key": key, "title": entry.get("title"), "company": entry.get("company"), "url": entry.get("url")}
                )
                continue

            previous = entry.get("fetch_attempts")
            valid = isinstance(previous, int) and not isinstance(previous, bool)
            attempts = (previous if valid else 0) + 1
            first = parse_timestamp(entry.get("first_unreachable")) or now
            # Plain, bounded text: it is shown in the report, never acted on.
            error = " ".join(str(result.get("fetch_error") or "").split())[:FETCH_ERROR_MAX]
            entry["fetch_attempts"] = attempts
            entry["first_unreachable"] = first.strftime(TIMESTAMP)
            if error:
                entry["last_fetch_error"] = error
            row = {
                "key": key,
                "title": entry.get("title"),
                "company": entry.get("company"),
                "url": entry.get("url"),
                "fetch_attempts": attempts,
                "last_fetch_error": entry.get("last_fetch_error"),
            }
            if attempts >= UNREACHABLE_MAX_ATTEMPTS and now - first >= UNREACHABLE_MIN_SPAN:
                # The retry fields stay on the entry as its history; `--all`
                # can still revive it, like any other expired entry.
                entry["status"] = "expired"
                entry["expired_reason"] = "unreachable"
                gave_up.append(row)
            else:
                entry["status"] = "unreachable"
                unreachable.append(row)
            continue

        if status == "expired":
            entry["status"] = "expired"
            for field in (*RETRY_FIELDS, "expired_reason"):
                entry.pop(field, None)
            expired.append(
                {"key": key, "title": entry.get("title"), "company": entry.get("company"), "url": entry.get("url")}
            )
            continue

        try:
            score = overall_score(result.get("scores") or {})
        except ValueError as exc:
            errors.append({"key": key, "error": str(exc)})
            continue
        bad_gate = next(
            (f for f in ("location_verdict", "seniority_gate") if result.get(f) and result[f] not in GATE_VERDICTS),
            None,
        )
        if bad_gate:
            errors.append(
                {"key": key, "error": f"unknown {bad_gate} {result[bad_gate]!r}; expected one of {', '.join(GATE_VERDICTS)}"}
            )
            continue
        engineering_role = result.get("engineering_role")
        if engineering_role is not None and not isinstance(engineering_role, bool):
            errors.append({"key": key, "error": "engineering_role must be true or false"})
            continue

        # A missing deadline from the fresh fetch is not a correction to the
        # stored date. Scored keys are excluded from the later sweep, so apply
        # must retire a passed deadline before updating any ranking metadata.
        parsed = parse_iso(result.get("deadline") or entry.get("deadline"))
        if parsed is not None and parsed < today:
            entry["status"] = "expired"
            for field in (*RETRY_FIELDS, "expired_reason"):
                entry.pop(field, None)  # fetched after all: closed on its deadline
            if result.get("deadline"):
                entry["deadline"] = result["deadline"]
            expired.append(
                {"key": key, "title": entry.get("title"), "company": entry.get("company"), "url": entry.get("url")}
            )
            continue

        for field in (*RETRY_FIELDS, "expired_reason"):
            entry.pop(field, None)  # fetched after all: the retry history is moot
        entry["status"] = "ranked"
        entry["rank_score"] = score
        entry["rank_verdict"] = band(score)
        entry["rank_date"] = today.isoformat()
        entry["location_verdict"] = result.get("location_verdict") or "PASS"
        entry["seniority_gate"] = result.get("seniority_gate") or "PASS"
        entry["engineering_role"] = bool(engineering_role)
        # The one-line reason the shortlist shows. Plain text, bounded.
        reason = " ".join(str(result.get("reason") or "").split())[:REASON_MAX]
        entry["reason"] = reason
        # Absence is not a correction: a fetch that degraded to a listing page
        # returns no deadline, and blanking a stored one would erase a real
        # date and make the entry immortal to the sweep.
        if result.get("deadline"):
            entry["deadline"] = result["deadline"]
        for field in ("strengths", "gaps"):
            value = result.get(field)
            if isinstance(value, list):
                entry[field] = [str(b) for b in value][:3]
        # The scoring agent's posting_guard verdict line ("clean" or the ⚠ line).
        # Stored so a later reader can see why a row carried a marker without
        # re-fetching the posting. A rescoring result without a guard drops a
        # stale one - absence means "not run".
        guard = result.get("guard")
        if isinstance(guard, str) and guard.strip():
            text = guard.strip()
            if text.lower().startswith("posting_guard:"):
                text = text[len("posting_guard:"):].strip()
            entry["guard"] = "clean" if text.lower().startswith("clean") else text[:200]
        else:
            entry.pop("guard", None)

        rows.append(
            {
                "key": key,
                "title": entry.get("title"),
                "company": entry.get("company"),
                "location": entry.get("location"),
                "url": entry.get("url"),
                "source": entry.get("source"),
                "score": score,
                "score_10": score_10(score),
                "verdict": entry["rank_verdict"],
                "reason": entry["reason"],
                "location_verdict": entry["location_verdict"],
                "seniority_gate": entry["seniority_gate"],
                "engineering_role": entry["engineering_role"],
                "deadline": entry.get("deadline"),
                "posted_date": entry.get("posted_date"),
                "urgent": bool(parsed and today <= parsed <= today + timedelta(days=URGENT_DAYS)),
                "strengths": entry.get("strengths", []),
                "gaps": entry.get("gaps", []),
                "guard": entry.get("guard"),
            }
        )

    if not args.dry_run:
        save_state(args.state, doc)

    rows.sort(key=lambda r: (r["score"], r["urgent"]), reverse=True)
    vetoed = [r for r in rows if _is_veto(r)]
    ranked = [r for r in rows if not _is_veto(r)]
    print(
        json.dumps(
            {
                "ranked": ranked,
                "vetoed": vetoed,
                "expired": expired,
                "unreachable": unreachable,
                "gave_up": gave_up,
                "errors": errors,
                "written": not args.dry_run,
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 1 if errors else 0


def _force_utf8_output() -> None:
    """Write UTF-8 whatever the host's default encoding is."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)  # absent on a StringIO under test
        if reconfigure:
            reconfigure(encoding="utf-8")


def main(argv=None) -> int:
    _force_utf8_output()
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--state", type=Path, default=STATE)
    common.add_argument("--today", type=date.fromisoformat, default=date.today())
    common.add_argument(
        "--now", type=parse_now, default=datetime.now(timezone.utc),
        help="date-time for the unreachable retry floor (default: now, UTC)",
    )

    ap = argparse.ArgumentParser(prog="rank_state.py", description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="command", required=True)

    cand = sub.add_parser("candidates", parents=[common], help="select the entries to score")
    cand.add_argument("--tracker", type=Path, default=TRACKER)
    cand.add_argument("--all", action="store_true", help="include every non-skipped status")
    cand.add_argument("--focus", help="substring filter over title, company and stored fit notes")
    cand.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="0 for no cap")
    cand.set_defaults(func=cmd_candidates)

    sweep = sub.add_parser("sweep", parents=[common], help="expiry pass over stored deadlines, no fetch")
    sweep.add_argument("--write", action="store_true", help="persist the expiries")
    sweep.add_argument("--exclude", help="comma-separated keys re-scored this run")
    sweep.set_defaults(func=cmd_sweep)

    app = sub.add_parser("apply", parents=[common], help="write scoring results back and print the ranking")
    app.add_argument("--results", required=True, help="JSON array from the scoring agents")
    app.add_argument("--dry-run", action="store_true")
    app.set_defaults(func=cmd_apply)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
