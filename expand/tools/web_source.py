#!/usr/bin/env python3
"""Talks, board roles, press and personal sites: one generic read-only page reader.

Step 1f of the original `/expand` fetches "other URLs in the profile" and
extracts whatever skills they name. For an executive the interesting content
is not a skill list but visibility and governance scope, so this reader
produces pointers: the page's own title, the lines where the person is
actually named, and one inference about what kind of evidence the page is.

It is deliberately modest. A conference programme, a board page and a news
article have nothing structural in common, so pretending to parse "the talk
title" or "the board seat" out of arbitrary HTML would mean inventing a
field the page never labelled. Instead every proposal here quotes the line
it came from and carries a standing needs-review note telling the owner to
confirm the exact title, date and role on the page before applying it. That
is the honest version of this step, and it is why the richer extraction
lives in `expand.md`, where a model reads the page with judgement.

`kind` picks the category: `talks` and `site` are public visibility,
`press` is media, `board` is governance.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

from competency_map import SourceReport, cited, inferred
from read_source import clean_fragment, clean_prose, is_instruction_like, read_url

TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
HEADING = re.compile(r"<h([12])[^>]*>(.*?)</h\1>", re.I | re.S)
MAX_MENTIONS = 5
MIN_MENTION_CHARS = 20
MAX_MENTION_CHARS = 240
SENTENCE_END = ".!?:\u2026"

# kind -> (category, how a cited line is phrased, what a page of this kind implies)
KIND_SHAPE = {
    "talks": ("speaking", "Speaking/visibility reference", "Public speaking or conference-programme presence"),
    "site": ("speaking", "Public professional presence", "Maintained public professional web presence"),
    "press": ("press", "Press mention", "External media visibility"),
    "board": ("board-advisory", "Board/advisory reference", "Board or advisory involvement referenced publicly"),
}
REVIEW_NOTE = (
    "{kind} page {url}: extraction here is a pointer, not a parsed record. Confirm the exact "
    "title, date and role on the page before moving anything from it into the profile."
)


def _host(url: str) -> str:
    return urlsplit(url).netloc.lower() or url


def _page_title(markup: str) -> tuple[str, bool]:
    match = TITLE.search(markup)
    if match:
        return clean_fragment(match.group(1))
    match = HEADING.search(markup)
    return clean_fragment(match.group(2)) if match else ("", False)


def mentions(text: str, name: str, limit: int = MAX_MENTIONS) -> list[str]:
    """Lines of the cleaned page that actually name the person.

    Without a name from the profile this returns nothing: a page that never
    names the owner is not evidence about the owner, and guessing which of
    its lines are about them is exactly the invention this port forbids.

    A matched line that is still mid-sentence is continued onto the lines
    after it, up to `MAX_MENTION_CHARS`. The gate folds a page to one line
    per source line, so a wrapped `<p>` otherwise quotes as half a sentence.
    Instruction-shaped lines are skipped outright - the gate quotes those
    rather than removing them, and a proposal never needs one.
    """
    if not name.strip():
        return []
    needle = name.strip().lower()
    surname = needle.split()[-1] if " " in needle else needle
    lines = [line.strip() for line in text.splitlines()]
    found: list[str] = []
    for index, stripped in enumerate(lines):
        if len(stripped) < MIN_MENTION_CHARS:
            continue
        lowered = stripped.lower()
        if needle not in lowered and not (len(surname) > 3 and surname in lowered):
            continue
        if is_instruction_like(stripped):
            continue
        quote = stripped
        step = index + 1
        while (quote[-1] not in SENTENCE_END and step < len(lines) and lines[step]
               and len(quote) + len(lines[step]) + 1 <= MAX_MENTION_CHARS
               and not is_instruction_like(lines[step])):
            quote = f"{quote} {lines[step]}"
            step += 1
        if quote not in found:
            found.append(quote)
        if len(found) >= limit:
            break
    return found


def scan(url: str, kind: str = "site", *, name: str = "", reader=read_url):
    """Scan one generic page. -> (signals, reports, needs_review notes)."""
    category, cite_prefix, implication = KIND_SHAPE.get(kind, KIND_SHAPE["site"])
    read = reader(url, "html")
    if not read.ok:
        return [], [SourceReport(kind, url, "skipped", reason=read.reason)], []

    host = _host(url)
    label = f"{kind} - {host}"
    signals: list = []
    title, title_flagged = _page_title(read.raw)
    if title:
        signals.append(cited(category, f"{cite_prefix}: {title} ({host})", title, url, label,
                             title_flagged or read.flagged))
    for line in mentions(read.text, name):
        quote, flagged = clean_prose(line)
        if quote:
            signals.append(cited(category, f"{cite_prefix} on {host}: {quote}", quote, url, label,
                                 flagged or read.flagged))
    if signals:
        signals.append(inferred(category, implication,
                                f"the page at {host} was readable and names the owner or their work",
                                url, label, read.flagged))
    needs_review = [REVIEW_NOTE.format(kind=kind, url=url)]
    if not name.strip():
        needs_review.append(
            f"{kind} page {url}: the profile has no Name, so only the page title was used - "
            "fill in `- **Name:**` in candidate-profile.md for per-line mention matching.")
    reports = [SourceReport(kind, url, "scanned", len(signals),
                            verdict=read.verdict, flagged=read.flagged)]
    return signals, reports, needs_review
