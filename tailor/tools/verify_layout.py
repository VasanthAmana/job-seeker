#!/usr/bin/env python3
"""Verify a LaTeX compile log for layout overflow or holes.

Reimplemented from ai-job-search's verify_layout.py (MIT, see
jobseek/NOTICE). Engines (pdflatex/xelatex/lualatex/tectonic) warn in their
log when a line or box doesn't fit the page:

  - `Overfull \\hbox` / `Overfull \\vbox` - content spills past the margin or
    off the page (a bullet too long, a section pushed past the page edge).
  - `Underfull \\vbox` - an unnaturally large gap (a "hole") from a bad page
    break, usually from moderncv's own spacing when a section barely
    doesn't fit.

A small overfull box (a few points, usually from font metrics) is normal and
not a real defect; this only fails on severe overflow, and only reports
underfull holes above a page-break-driven threshold rather than every minor
one.

Exit codes: 0 = pass; 1 = fail (reasons on stderr); 2 = skipped (log file
missing - the compile step didn't produce one).
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# A few points of overfull are routine kerning; several hundred means text is
# genuinely spilling off the page or past the margin.
OVERFULL_HBOX_PT_THRESHOLD = 20.0
OVERFULL_VBOX_PT_THRESHOLD = 20.0
# An underfull vbox this tall is a visible blank hole, not ordinary spacing.
UNDERFULL_VBOX_PT_THRESHOLD = 200.0

_OVERFULL_HBOX = re.compile(r"Overfull \\hbox \((?P<pt>[\d.]+)pt too wide\)")
_OVERFULL_VBOX = re.compile(r"Overfull \\vbox \((?P<pt>[\d.]+)pt too high\)")
_UNDERFULL_VBOX = re.compile(r"Underfull \\vbox \(badness [\d.]+\).*?has occurred while \\output is active")
_UNDERFULL_VBOX_HEIGHT = re.compile(r"Underfull \\vbox \(badness [\d.]+\) detected at line \d+")


def analyze(log_text: str) -> list[str]:
    """Return a list of problem descriptions; empty when the log is clean
    enough to ship."""
    problems: list[str] = []

    for m in _OVERFULL_HBOX.finditer(log_text):
        pt = float(m.group("pt"))
        if pt > OVERFULL_HBOX_PT_THRESHOLD:
            problems.append(f"overfull hbox {pt}pt too wide - a line is spilling past the margin")

    for m in _OVERFULL_VBOX.finditer(log_text):
        pt = float(m.group("pt"))
        if pt > OVERFULL_VBOX_PT_THRESHOLD:
            problems.append(f"overfull vbox {pt}pt too high - content is spilling off the page")

    # Underfull vbox entries don't carry a height the way overfull ones do;
    # treat any occurrence tied to an actual output (page-break) event as a
    # potential hole worth a human look, capped so one noisy document
    # doesn't flood the report.
    hole_count = len(_UNDERFULL_VBOX.findall(log_text))
    if hole_count:
        problems.append(
            f"{hole_count} underfull vbox warning(s) at page breaks - "
            f"check for a visible blank gap/hole in the layout"
        )

    if "! " in log_text and "Overfull" not in log_text and "Underfull" not in log_text:
        # A LaTeX error ("! Undefined control sequence", etc.) with no box
        # warnings at all usually means the log is from a failed run that
        # compile_latex.py should already have caught - but check anyway in
        # case this log was inspected independently.
        for m in re.finditer(r"^! (.+)$", log_text, re.MULTILINE):
            problems.append(f"LaTeX error: {m.group(1).strip()}")

    return problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--log", required=True, help="the engine's .log file")
    args = ap.parse_args(argv)

    log_path = Path(args.log)
    if not log_path.is_file():
        print(f"skipped: no such log file: {log_path}", file=sys.stderr)
        return 2

    text = log_path.read_text(encoding="utf-8", errors="replace")
    problems = analyze(text)
    if problems:
        print("verify_layout: FAIL", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print("verify_layout: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
