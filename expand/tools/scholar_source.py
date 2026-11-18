#!/usr/bin/env python3
"""Google Scholar: publications, venues and the citation counts Scholar shows.

The original `/expand` lumps Scholar in with "other profile URLs" (Step 1f)
and extracts whatever a generic fetch finds. For a Director/VP AI-strategy
profile the publication record is a category of its own - it is the main
evidence of thought leadership - so it gets a parser that reads Scholar's
actual table instead of prose scraped off the page.

**Never fabricate a count.** Scholar shows a citation number per paper and a
totals block (citations, h-index, i10-index). When the cell is absent, empty
or not a number, the proposal simply has no number in it. The same goes for
the year. Nothing here derives a count from anything other than a digit
Scholar printed.

Structure is matched against the raw HTML, then every extracted fragment
goes through `read_source.clean_fragment()` - `posting_guard.py` in `--html`
mode - so a `display:none` payload planted inside a table cell is stripped
from the cell as well as from the page-level read.
"""

from __future__ import annotations

import re

from competency_map import SourceReport, cited, inferred
from read_source import clean_fragment, read_url

ROW = re.compile(r'<tr[^>]*class="[^"]*gsc_a_tr[^"]*"[^>]*>(.*?)</tr>', re.I | re.S)
TITLE = re.compile(r'<a[^>]*class="[^"]*gsc_a_at[^"]*"[^>]*>(.*?)</a>', re.I | re.S)
GRAY = re.compile(r'<div[^>]*class="[^"]*gs_gray[^"]*"[^>]*>(.*?)</div>', re.I | re.S)
CITES = re.compile(r'<td[^>]*class="[^"]*gsc_a_c[^"]*"[^>]*>(.*?)</td>', re.I | re.S)
YEAR = re.compile(r'<td[^>]*class="[^"]*gsc_a_y[^"]*"[^>]*>(.*?)</td>', re.I | re.S)
NAME = re.compile(r'<div[^>]*id="gsc_prf_in"[^>]*>(.*?)</div>', re.I | re.S)
AFFIL = re.compile(r'<div[^>]*class="[^"]*gsc_prf_il[^"]*"[^>]*>(.*?)</div>', re.I | re.S)
STAT = re.compile(r'<td[^>]*class="[^"]*gsc_rsb_sc1[^"]*"[^>]*>(.*?)</td>\s*'
                  r'<td[^>]*class="[^"]*gsc_rsb_std[^"]*"[^>]*>\s*(\d+)\s*</td>', re.I | re.S)
DIGITS = re.compile(r"^\d+$")
# Scholar repeats the year inside the venue line as an overlay span; left in,
# every venue reads "..., 2024 - 2024" once the year column is appended.
OVERLAY = re.compile(r'<span[^>]*class="[^"]*gs_oph[^"]*"[^>]*>.*?</span>', re.I | re.S)
MAX_PAPERS = 40


def _digits(fragment: str) -> str:
    """The integer Scholar printed in a cell, or "" - never a guess."""
    text, _flagged = clean_fragment(fragment)
    text = text.strip()
    return text if DIGITS.match(text) else ""


def parse(markup: str):
    """Scholar page -> (header dict, list of paper dicts). Pure parsing, no I/O."""
    header: dict = {}
    name_match = NAME.search(markup)
    if name_match:
        header["name"], _ = clean_fragment(name_match.group(1))
    affiliations = []
    for match in AFFIL.finditer(markup):
        value, flagged = clean_fragment(match.group(1))
        if value and value not in affiliations:
            affiliations.append(value)
    header["affiliations"] = affiliations
    header["stats"] = {}
    for match in STAT.finditer(markup):
        label, _ = clean_fragment(match.group(1))
        if label:
            header["stats"].setdefault(label.strip().lower(), int(match.group(2)))

    papers = []
    for row in ROW.findall(markup)[:MAX_PAPERS]:
        title_match = TITLE.search(row)
        if not title_match:
            continue
        title, title_flagged = clean_fragment(title_match.group(1))
        if not title:
            continue
        grays = GRAY.findall(row)
        authors, authors_flagged = clean_fragment(grays[0]) if grays else ("", False)
        venue, venue_flagged = clean_fragment(OVERLAY.sub("", grays[1])) if len(grays) > 1 else ("", False)
        cites_match = CITES.search(row)
        year_match = YEAR.search(row)
        papers.append({
            "title": title,
            "authors": authors,
            "venue": venue,
            "citations": _digits(cites_match.group(1)) if cites_match else "",
            "year": _digits(year_match.group(1)) if year_match else "",
            "flagged": title_flagged or authors_flagged or venue_flagged,
        })
    return header, papers


def scan(url: str, *, reader=read_url):
    """Scan one Scholar profile URL. -> (signals, reports, needs_review notes)."""
    signals: list = []
    needs_review: list = []
    read = reader(url, "html")
    if not read.ok:
        return signals, [SourceReport("scholar", url, "skipped", reason=read.reason)], needs_review

    header, papers = parse(read.raw)
    label = "Google Scholar"
    for affiliation in header.get("affiliations", []):
        signals.append(cited("strategic-leadership",
                             f"Scholar profile affiliation: {affiliation}",
                             affiliation, url, label, read.flagged))
    for paper in papers:
        detail = " - ".join(part for part in (paper["venue"], paper["year"]) if part)
        suffix = f" [{paper['citations']} citations per Scholar]" if paper["citations"] else ""
        item = f'Publication: "{paper["title"]}"' + (f" ({detail})" if detail else "") + suffix
        evidence = " | ".join(part for part in (paper["authors"], paper["venue"], paper["year"]) if part) \
            or paper["title"]
        signals.append(cited("publications", item, evidence, url, label,
                             paper["flagged"] or read.flagged))
    if papers:
        signals.append(inferred(
            "publications", "Peer-reviewed or published research output",
            f"Scholar lists {len(papers)} publication row(s) under this profile",
            url, label, read.flagged))
    for stat_label, value in header.get("stats", {}).items():
        signals.append(cited("publications",
                             f"Scholar {stat_label}: {value}",
                             f"Scholar statistics table row '{stat_label}' = {value}",
                             url, label, read.flagged))
    if not papers:
        needs_review.append(
            f"Scholar: no publication rows were recognised at {url} - the page may be "
            "a different profile layout, empty, or served as a consent interstitial. "
            "Open it and check by hand before concluding there are no publications.")
    if len(papers) == MAX_PAPERS:
        needs_review.append(
            f"Scholar: stopped at {MAX_PAPERS} publications; the profile may list more "
            "(Scholar paginates with a 'Show more' button this tool does not press).")
    reports = [SourceReport("scholar", url, "scanned", len(signals),
                            verdict=read.verdict, flagged=read.flagged)]
    return signals, reports, needs_review
