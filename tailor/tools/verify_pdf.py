#!/usr/bin/env python3
"""Verify a compiled resume PDF: page count and an extractable ATS text
layer.

Reimplemented from ai-job-search's verify_pdf.py (MIT, see jobseek/NOTICE).
Part of the compile-and-inspect loop: a PDF that fails this check is not
shipped - tailor.md Step 6 treats a non-zero exit as "cut content and
re-render", exactly like the existing markdown/.docx page-budget check in
export_resume.py.

Checks:
  1. Page count via pdftotext form feeds, against --max-pages.
  2. ATS text layer: pdftotext must extract non-trivial text (an
     image-only/scanned PDF has none), and every string in --expect must
     appear in it verbatim - the candidate's own name/email are the
     cheapest proxy for "this PDF is not a blank page or garbled text".

Exit codes: 0 = pass; 1 = fail (reasons on stderr); 2 = skipped (pdftotext
not on PATH - install poppler-utils, or a TeX distribution normally
provides it).
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

MIN_TEXT_LAYER_CHARS = 40


def run_pdftotext(pdf: Path) -> str | None:
    """Extracted plain text, or None when pdftotext is unavailable or
    fails outright."""
    if not shutil.which("pdftotext"):
        return None
    proc = subprocess.run(
        ["pdftotext", "-enc", "UTF-8", str(pdf), "-"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout


def page_count(text: str) -> int:
    return text.count("\f") or (1 if text.strip() else 0)


def verify(pdf: Path, max_pages: int | None, expect: list[str]) -> tuple[int, list[str]]:
    """Returns (exit_code, problems). problems is empty on a pass."""
    text = run_pdftotext(pdf)
    if text is None:
        return 2, ["pdftotext not found on PATH (install poppler-utils)"]

    problems: list[str] = []

    pages = page_count(text)
    if max_pages is not None and pages > max_pages:
        problems.append(
            f"page count {pages} exceeds the {max_pages}-page budget"
        )

    stripped = text.replace("\f", "").strip()
    if len(stripped) < MIN_TEXT_LAYER_CHARS:
        problems.append(
            "no extractable ATS text layer (PDF may be image-only or "
            "the compile produced a near-empty page)"
        )
    else:
        for needle in expect:
            if needle and needle not in text:
                problems.append(f"expected text not found in PDF: {needle!r}")

    return (1 if problems else 0), problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--max-pages", type=int)
    ap.add_argument("--expect", action="append", default=[],
                    help="a string that must appear in the extracted text "
                         "(repeatable) - e.g. the candidate's name and email")
    args = ap.parse_args(argv)

    pdf = Path(args.pdf)
    if not pdf.is_file():
        print(f"verify_pdf: error: no such file: {pdf}", file=sys.stderr)
        return 2

    rc, problems = verify(pdf, args.max_pages, args.expect)
    if rc == 2:
        print(f"skipped: {problems[0]}", file=sys.stderr)
    elif rc == 1:
        print("verify_pdf: FAIL", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
    else:
        print("verify_pdf: PASS")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
