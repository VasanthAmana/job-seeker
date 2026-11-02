#!/usr/bin/env python3
"""ATS keyword coverage check: JD keywords vs the tailored resume.

ATS screening is largely literal keyword matching, so this tool reports, for
each JD keyword, whether the tailored resume covers it (verbatim or trivial
inflection) or misses it. The tailor workflow then classifies each miss:

  * synonym-only   - concept present under another term; prefer the posting's
                     term where it is truthfully applicable
  * missing (have it) - the profile shows the candidate has it; add it
  * missing (gap)  - a genuine gap: leave it missing, list it as a gap.
                     Never stuff keywords.

Keywords come from the agent that read the JD (--keywords/--keywords-file);
that list is authoritative. With no explicit list, --auto extracts candidates
deterministically from the JD (ALL-CAPS acronyms, capitalized terms, dotted
tool names, and bullet lines under requirements/qualifications headings) as a
fallback - noisier, so the output says so.

Matching folds case, Unicode (NFC), and markdown, and accepts a trivial
plural inflection (keyword "roadmap" matches "roadmaps"). Multi-word phrases
match on folded whitespace.

Exit codes: 0 = every keyword covered; 1 = misses; 2 = usage/IO error.

Usage:
    ats_keywords.py --jd jd.txt --resume tailored.md \
        [--keywords "AI strategy,roadmap" | --keywords-file kws.txt | --auto] [--json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

_MD_INLINE = re.compile(r"[`*_~#>]")


def fold(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = _MD_INLINE.sub(" ", text)
    return re.sub(r"\s+", " ", text.lower()).strip()


def _inflections(keyword: str) -> list[str]:
    """The keyword plus trivial plural inflections of its last word."""
    k = fold(keyword)
    forms = {k}
    if " " in k:
        head, last = k.rsplit(" ", 1)
        for plural in (last + "s", last + "es",
                       last[:-1] + "ies" if last.endswith("y") else last):
            forms.add(f"{head} {plural}")
    else:
        forms.update({k + "s", k + "es"})
        if k.endswith("y"):
            forms.add(k[:-1] + "ies")
    return list(forms)


def covered(keyword: str, resume_folded: str) -> bool:
    for form in _inflections(keyword):
        pattern = r"(?<![\w])" + re.escape(form) + r"(?![\w])"
        if re.search(pattern, resume_folded):
            return True
    return False


# --- fallback auto-extraction ------------------------------------------------

_ACRONYM = re.compile(r"\b[A-Z][A-Z0-9&+]{2,}\b")
_CAPPED = re.compile(r"\b[A-Z][a-z]+(?:[ -&][A-Z][a-z]+)+\b")
_MIXED = re.compile(r"\b[A-Z][a-z]+[A-Z][A-Za-z]*\b")  # GenAI, DevOps
_DOTTED = re.compile(r"\b[A-Za-z][\w]*(?:[./][\w]+)+\b")
_REQ_HEADING = re.compile(
    r"^\s*#*\s*(requirements|qualifications|what you.{0,20}(bring|need)|"
    r"skills|must[- ]haves?)\s*:?\s*$", re.IGNORECASE)
_STOP = {
    "CEO", "CFO", "CTO", "COO", "SVP", "EVP", "VP",  # titles, not skills
    "USA", "US", "UK", "EU", "LLC", "INC", "EEO",
}


def auto_extract(jd_text: str) -> list[str]:
    """Deterministic fallback keyword candidates from the JD text."""
    found: dict[str, None] = {}  # ordered set
    for m in list(_ACRONYM.finditer(jd_text)) + list(_DOTTED.finditer(jd_text)) \
            + list(_MIXED.finditer(jd_text)):
        t = m.group(0).strip(".")
        if t.upper().strip("&+") not in _STOP:
            found.setdefault(t)
    for m in _CAPPED.finditer(jd_text):
        t = m.group(0)
        if len(t) > 3 and not t.upper().strip("&+") in _STOP:
            found.setdefault(t)
    # single words on requirement bullet lines ("experience with X")
    in_req = False
    for line in jd_text.splitlines():
        if _REQ_HEADING.match(line):
            in_req = True
            continue
        if line.strip().startswith("#"):
            in_req = False
        if in_req and re.match(r"\s*[-*\u2022]", line):
            for w in re.findall(r"\b[a-z][a-z-]{5,}\b", line.lower()):
                if w in {"strategy", "strategic", "roadmap", "governance",
                         "transformation", "stakeholders", "leadership",
                         "analytics", "forecasting", "budgeting"}:
                    found.setdefault(w)
    return list(found)


def report(keywords: list[str], resume_text: str) -> list[dict]:
    folded = fold(resume_text)
    return [{"keyword": kw, "status": "covered" if covered(kw, folded) else "missing"}
            for kw in keywords]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="ATS keyword coverage: JD keywords covered vs missing "
                    "in the tailored resume.")
    ap.add_argument("--jd", required=True, help="job description text file")
    ap.add_argument("--resume", required=True, help="tailored resume (markdown)")
    ap.add_argument("--keywords", help="comma-separated keyword list "
                                       "(authoritative, from reading the JD)")
    ap.add_argument("--keywords-file", help="file with one keyword per line")
    ap.add_argument("--auto", action="store_true",
                    help="extract keyword candidates from the JD "
                         "(fallback, noisier)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    try:
        jd_text = Path(args.jd).read_text(encoding="utf-8")
        resume_text = Path(args.resume).read_text(encoding="utf-8")
    except OSError as e:
        print(f"ats_keywords: error: {e}", file=sys.stderr)
        return 2

    if args.keywords:
        keywords = [k.strip() for k in args.keywords.split(",") if k.strip()]
        mode = "explicit"
    elif args.keywords_file:
        try:
            keywords = [l.strip() for l in
                        Path(args.keywords_file).read_text(encoding="utf-8")
                        .splitlines() if l.strip()]
        except OSError as e:
            print(f"ats_keywords: error: {e}", file=sys.stderr)
            return 2
        mode = "explicit"
    elif args.auto:
        keywords = auto_extract(jd_text)
        mode = "auto (fallback - pass --keywords for the authoritative list)"
    else:
        print("ats_keywords: error: pass --keywords, --keywords-file, or "
              "--auto", file=sys.stderr)
        return 2

    rows = report(keywords, resume_text)
    missing = [r for r in rows if r["status"] == "missing"]

    if args.json:
        print(json.dumps({"mode": mode, "jd": args.jd, "resume": args.resume,
                          "keywords": rows,
                          "covered": len(rows) - len(missing),
                          "missing": len(missing)}, indent=2,
                         ensure_ascii=False))
    else:
        print(f"ats_keywords: {len(rows) - len(missing)}/{len(rows)} "
              f"keywords covered [{mode}]")
        print(f"{'Keyword':<40} Status")
        print(f"{'-' * 40} {'-' * 8}")
        for r in rows:
            print(f"{r['keyword']:<40} {r['status']}")
        if missing:
            print("\nClassify each miss: synonym-only / missing (have it) / "
                  "missing (gap). Never stuff keywords.")
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
