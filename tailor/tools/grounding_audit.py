#!/usr/bin/env python3
"""Deterministic grounding audit for a tailored resume (the never-invent rule).

The tailor workflow's core discipline is "never invent experience, titles,
metrics or tools". The reviewer agent judges claims semantically; this tool is
the mechanical half: it extracts the checkable facts from the tailored resume
and verifies each one appears in the grounding sources (the master resume plus
the candidate profile). Anything not found is flagged - the workflow must
either ground it in the sources (write the confirmed fact back to the profile)
or cut it. A requirement the JD asks for but the sources do not contain is a
gap, never an addition.

What is checked:

  * metrics   - every numeric claim (counts, percentages, currencies,
                "12 years", "3x") must appear in the sources with the same
                digits. Comma/space grouping is folded ("2,400" == "2400").
  * dates     - every 4-digit year (1900-2099) must appear in the sources.
  * titles    - markdown headings (role/degree lines) must be fully supported:
                every significant word of a heading must appear in the sources.
                Titles are never reworded by tailoring, so an unsupported
                heading word means a new or altered title.
  * tools     - technology-shaped tokens (CamelCase words, dotted/suffixed
                names like "Node.js" or "GPT-4", ALL-CAPS acronyms) must
                appear in the sources. A small stoplist filters common
                non-tool acronyms.

A claim is grounded if ANY source supports it (same union rule as the
reviewer agent). Markdown formatting characters are stripped before both
extraction and matching. Fenced code blocks in the resume are ignored.

Exit codes: 0 = all extracted facts grounded; 1 = ungrounded facts found
(listed); 2 = usage/IO error.

Usage:
    grounding_audit.py --resume tailored.md --source master.md [--source profile.md ...] [--json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

# --- text folding -----------------------------------------------------------

_MD_INLINE = re.compile(r"[`*_~#>\[\]|]")
_FENCE = re.compile(r"^\s*(```|~~~)")

# Common acronyms that are not tools/technologies (keep small: false
# positives cost a human glance, false negatives cost the never-invent rule).
_ACRONYM_STOPLIST = {
    "OK", "US", "USA", "UK", "EU", "AM", "PM", "PH", "RE", "VS",
    "NC", "NY", "CA", "TX", "WA", "DC",  # US state abbreviations in locations
    "HR", "IT", "PR", "QA", "R", "D",  # generic functions (R&D is caught as R/D)
    "AND", "THE", "FOR", "WITH", "OR", "OF", "IN", "TO", "A", "I",
}

_MONTHS = {
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT",
    "NOV", "DEC", "JANUARY", "FEBRUARY", "MARCH", "APRIL", "JUNE", "JULY",
    "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
}


def fold(text: str) -> str:
    """Normalize text for comparison: NFC, strip markdown, lowercase,
    collapse whitespace, drop comma/space digit grouping."""
    text = unicodedata.normalize("NFC", text)
    text = _MD_INLINE.sub(" ", text)
    text = text.lower()
    # fold digit grouping: "2,400" and "2 400" both become "2400"
    text = re.sub(r"(?<=\d)[,\u00a0 ](?=\d{3}\b)", "", text)
    text = re.sub(r"\s+", " ", text)
    return text


def strip_fences(text: str) -> str:
    """Drop fenced code blocks (never resume content, often examples)."""
    out, in_fence = [], False
    for line in text.splitlines():
        if _FENCE.match(line):
            in_fence = not in_fence
            continue
        if not in_fence:
            out.append(line)
    return "\n".join(out)


# --- extraction -------------------------------------------------------------

# Numeric claims: optional currency, digits with grouping/decimal, optional
# magnitude or percent/x suffix. Years are extracted separately.
_NUMBER = re.compile(
    r"(?<![\w$€£])"
    r"[$€£]?\d[\d,]*(?:\.\d+)?"
    r"(?:\s*(?:%|percent|x|k|m|bn|b|million|billion|thousand|\+|years?|yrs?))?"
    r"(?![\w%])",
    re.IGNORECASE,
)
_YEAR = re.compile(r"\b(19|20)\d{2}\b")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.*\S)\s*$")
_CAMEL = re.compile(r"\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b")  # CamelCase
_DOTTED = re.compile(r"\b[A-Za-z][\w]*(?:[./][\w]+)+\b")  # Node.js, TensorFlow 2.x handled by camel
_SUFFixed = re.compile(r"\b[A-Z][A-Za-z]+-\d[\w.]*\b")  # GPT-4, Claude-3
_ACRONYM = re.compile(r"\b[A-Z][A-Z0-9&+]{1,}\b")

# Dotted abbreviations that are prose, not tools.
_DOTTED_STOPLIST = {"e.g.", "i.e.", "etc.", "vs.", "cf."}


def _digits_only(s: str) -> str:
    return re.sub(r"\D", "", s)


def extract_facts(text: str) -> list[dict]:
    """Pull checkable facts out of the tailored resume."""
    text = strip_fences(text)
    facts: list[dict] = []

    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = _MD_INLINE.sub(" ", line)

        # metrics: numeric claims (skip bare years here; checked as dates)
        for m in _NUMBER.finditer(stripped):
            token = m.group(0).strip()
            digits = _digits_only(token)
            if not digits:
                continue
            if _YEAR.fullmatch(digits):
                continue  # handled as a date
            if digits == "1" and not re.search(r"[%$€£xkm+]", token, re.IGNORECASE):
                # a bare "1" ("1 direct report" vs "1." list noise) is too
                # weak to audit meaningfully; keep signal-to-noise sane
                continue
            facts.append({
                "kind": "metric", "text": token, "line": lineno,
                "needles": [re.sub(r"(?<=\d),(?=\d{3}\b)", "", digits)],
            })

        # dates: 4-digit years
        for m in _YEAR.finditer(stripped):
            facts.append({
                "kind": "date", "text": m.group(0), "line": lineno,
                "needles": [m.group(0)],
            })

        # titles: markdown headings (role / degree / institution lines)
        hm = _HEADING.match(line)
        if hm:
            heading = hm.group(1)
            words = [
                w for w in re.findall(r"[A-Za-z][A-Za-z'&+.-]{2,}", heading)
                if w.lower() not in {"the", "and", "for", "with"}
            ]
            if words:
                facts.append({
                    "kind": "title", "text": heading.strip(), "line": lineno,
                    "needles": words,
                    "require_all": True,
                })

        # tools: technology-shaped tokens
        seen_on_line: set[str] = set()
        for regex in (_CAMEL, _DOTTED, _SUFFixed, _ACRONYM):
            for m in regex.finditer(line):
                token = m.group(0)
                if token in seen_on_line:
                    continue
                seen_on_line.add(token)
                if token.lower().rstrip(".") in {s.rstrip(".") for s in _DOTTED_STOPLIST}:
                    continue
                upper = token.upper().strip("&+")
                if upper in _ACRONYM_STOPLIST or upper in _MONTHS:
                    continue
                if regex is _ACRONYM and upper in {"I"}:
                    continue
                # skip tokens that are part of a heading (already audited)
                if hm and token in heading:
                    continue
                facts.append({
                    "kind": "tool", "text": token, "line": lineno,
                    "needles": [token],
                })

    return facts


def audit(resume_text: str, sources: list[str]) -> list[dict]:
    """Return the list of facts not grounded in any source."""
    corpus = fold("\n\n".join(sources))
    ungrounded: list[dict] = []
    for fact in extract_facts(resume_text):
        needles = fact["needles"]
        if fact.get("require_all"):
            missing = [n for n in needles if fold(n) not in corpus]
            if missing:
                ungrounded.append({**fact, "missing": missing})
        else:
            if not any(fold(n) in corpus for n in needles):
                ungrounded.append({**fact, "missing": needles})
    return ungrounded


# --- CLI --------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Grounding audit: every metric, date, title and tool in "
                    "the tailored resume must appear in the sources.")
    ap.add_argument("--resume", required=True, help="tailored resume (markdown)")
    ap.add_argument("--source", action="append", required=True,
                    help="grounding source file (master resume, candidate "
                         "profile); repeatable")
    ap.add_argument("--json", action="store_true", help="print findings as JSON")
    args = ap.parse_args(argv)

    try:
        resume_text = Path(args.resume).read_text(encoding="utf-8")
        sources = [Path(s).read_text(encoding="utf-8") for s in args.source]
    except OSError as e:
        print(f"grounding_audit: error: {e}", file=sys.stderr)
        return 2

    ungrounded = audit(resume_text, sources)

    if args.json:
        print(json.dumps({"resume": args.resume, "sources": args.source,
                          "ungrounded": ungrounded,
                          "verdict": "fail" if ungrounded else "pass"},
                         indent=2, ensure_ascii=False))
    else:
        if ungrounded:
            print(f"grounding_audit: FAIL - {len(ungrounded)} ungrounded fact(s):")
            for u in ungrounded:
                missing = ", ".join(repr(m) for m in u["missing"])
                print(f"  line {u['line']:>4} [{u['kind']:>6}] {u['text']!r} "
                      f"- not in sources: {missing}")
            print("Cut these, or write the confirmed fact back to "
                  "jobseek/profile/candidate-profile.md (same turn) and re-run.")
        else:
            print("grounding_audit: pass - every extracted metric, date, "
                  "title and tool is grounded in the sources")
    return 1 if ungrounded else 0


if __name__ == "__main__":
    raise SystemExit(main())
