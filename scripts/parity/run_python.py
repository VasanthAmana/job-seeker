#!/usr/bin/env python3
"""Run the Python side of the port parity check (execution plan section 4.1).

Reads a JSON object of cases on stdin and prints the predecessor's results
as JSON, for test/parity/parity.test.ts to compare with the TypeScript
port: url_canon, job_key, posting_guard and rank_state's score arithmetic.
Pure functions only; nothing here reads or writes state.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))

import job_key  # noqa: E402
import posting_guard  # noqa: E402
import rank_state  # noqa: E402
from url_canon import canonicalize_url  # noqa: E402


def score(case):
    try:
        value = rank_state.overall_score(case["scores"], case["weights"])
        return {"score": value, "band": rank_state.band(value), "score_10": rank_state.score_10(value)}
    except ValueError as exc:
        return {"error": str(exc)}


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    cases = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    out = {
        "url_canon": [canonicalize_url(u) for u in cases["url_canon"]],
        "job_key": [job_key.make_key(c, t, u) for c, t, u in cases["job_key"]],
        "guard": [],
        "score": [score(c) for c in cases["score"]],
    }
    for raw, mode in cases["guard"]:
        text, findings = posting_guard.guard(raw, mode)
        out["guard"].append({"text": text, "findings": findings})
    print(json.dumps(out, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
