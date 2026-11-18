#!/usr/bin/env python3
"""The competency map: categories, signals, dedupe, and the proposals file.

`/expand` in ai-job-search builds a categorized, source-attributed,
deduplicated competency map and then appends confirmed items to the profile.
This module is the jobseek port of that map, with two deliberate changes:

  * **Executive categories, not IC categories.** The original groups findings
    as primary/secondary technical skills, domain knowledge, methods and
    practices, soft/behavioral and portfolio projects - the shape of an
    early/mid-career individual contributor. A Director/VP AI-strategy
    profile is read for scope, governance, visibility and credibility, so the
    categories here are strategic scope, board/advisory, publications,
    speaking, press and technical depth. `technical-depth` is the one that
    overlaps the original, and it exists to show credibility behind an
    executive's AI claims, not to list a toolchain.
  * **Proposals, never writes.** The original writes confirmed items straight
    into the profile after an interactive `all`/`review`/`skip` prompt. An MCP
    tool call has nobody to prompt, so this module renders a separate
    "proposed - not yet applied" file and the owner applies it by hand.

Every signal carries the source URL it came from and a basis label, kept from
the original: `A` = direct citation (the source literally says this), `B` =
reasoned inference (what the cited evidence implies), `A+B` = both. A `B`
signal states a capability, never a title, a date or a number: those exist
only where a source printed them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

# key -> heading, in the order they appear in the proposals file.
CATEGORIES: tuple[tuple[str, str], ...] = (
    ("strategic-leadership", "Strategic & Leadership Scope"),
    ("board-advisory", "Board & Advisory Roles"),
    ("publications", "Publications & Thought Leadership"),
    ("speaking", "Speaking & Public Visibility"),
    ("press", "Press & Media Mentions"),
    ("technical-depth", "Technical & Domain Depth"),
)
CATEGORY_KEYS = tuple(key for key, _heading in CATEGORIES)
CATEGORY_HEADINGS = dict(CATEGORIES)

PROPOSALS_FILENAME = "expand-proposals.md"
EVIDENCE_MAX = 240


class MapError(ValueError):
    """A malformed signal: a bad category or an empty item/source."""


def _squeeze(text: str, limit: int = EVIDENCE_MAX) -> str:
    """One line, collapsed whitespace, capped - evidence is a quote, not a page."""
    text = re.sub(r"\s+", " ", (text or "")).strip()
    return text[: limit - 1] + "…" if len(text) > limit else text


@dataclass(frozen=True)
class Signal:
    """One proposed profile addition, with where it came from and how.

    `item` is the line the owner would paste into the profile. `evidence` is
    what the source actually showed - a quote for `A`, the observation that
    was reasoned from for `B`. `flagged` marks a signal whose source page
    tripped `posting_guard.py`; it is carried all the way into the proposals
    file so the owner never reads a suspect page's output unlabelled.
    """

    category: str
    item: str
    evidence: str
    source_url: str
    source_label: str
    basis: str = "A"
    flagged: bool = False

    def __post_init__(self) -> None:
        if self.category not in CATEGORY_HEADINGS:
            raise MapError(f"unknown category {self.category!r}")
        if not self.item.strip():
            raise MapError("a signal needs an item")
        if not self.source_label.strip():
            raise MapError("a signal needs a source label")
        if self.basis not in ("A", "B", "A+B"):
            raise MapError(f"basis must be A, B or A+B, got {self.basis!r}")

    @property
    def dedupe_key(self) -> tuple[str, str]:
        return self.category, re.sub(r"[^a-z0-9]+", " ", self.item.lower()).strip()


def cited(category: str, item: str, evidence: str, source_url: str, source_label: str,
          flagged: bool = False) -> Signal:
    """An `A` signal: the source says this, quoted."""
    return Signal(category=category, item=_squeeze(item, 400), evidence=_squeeze(evidence),
                  source_url=source_url, source_label=source_label, basis="A", flagged=flagged)


def inferred(category: str, item: str, evidence: str, source_url: str, source_label: str,
             flagged: bool = False) -> Signal:
    """A `B` signal: what the cited evidence implies, never a new fact."""
    return Signal(category=category, item=_squeeze(item, 400), evidence=_squeeze(evidence),
                  source_url=source_url, source_label=source_label, basis="B", flagged=flagged)


@dataclass
class SourceReport:
    """One source's outcome, for the "scanned"/"skipped" tables."""

    kind: str
    ref: str
    status: str                 # "scanned" | "skipped"
    signals: int = 0
    reason: str = ""            # why it was skipped, or the gate verdict when scanned
    verdict: str = ""
    flagged: bool = False


@dataclass
class CompetencyMap:
    """Deduplicated signals plus the per-source bookkeeping around them."""

    signals: list[Signal] = field(default_factory=list)
    reports: list[SourceReport] = field(default_factory=list)
    needs_review: list[str] = field(default_factory=list)
    _seen: dict = field(default_factory=dict, repr=False)

    def add(self, signal: Signal) -> None:
        """Add one signal, merging a duplicate instead of repeating it.

        The same item reached twice by direct citation and by inference is one
        entry labelled `A+B`, exactly as the original's map records it.
        """
        key = signal.dedupe_key
        existing = self._seen.get(key)
        if existing is None:
            self._seen[key] = signal
            self.signals.append(signal)
            return
        merged_basis = "A+B" if existing.basis != signal.basis else existing.basis
        merged = Signal(
            category=existing.category,
            item=existing.item,
            # Keep the citation's evidence when one side is a citation.
            evidence=existing.evidence if existing.basis.startswith("A") else signal.evidence,
            source_url=existing.source_url,
            source_label=existing.source_label,
            basis=merged_basis,
            flagged=existing.flagged or signal.flagged,
        )
        self.signals[self.signals.index(existing)] = merged
        self._seen[key] = merged

    def extend(self, signals) -> None:
        for signal in signals:
            self.add(signal)

    def by_category(self) -> dict:
        grouped = {key: [] for key in CATEGORY_KEYS}
        for signal in self.signals:
            grouped[signal.category].append(signal)
        return grouped

    def counts(self) -> dict:
        return {key: len(items) for key, items in self.by_category().items() if items}

    def flagged_sources(self) -> list[dict]:
        return [
            {"kind": r.kind, "ref": r.ref, "verdict": r.verdict}
            for r in self.reports if r.flagged
        ]


HEADER = """# Profile expansion proposals - PROPOSED, NOT YET APPLIED

Generated by `expand` at {generated_at} from **public sources only**.

> **Nothing in this file has been applied to your profile.** It is a proposal
> list: `expand` never edits `candidate-profile.md` or any other
> profile file. Read each line, delete what is wrong or stale, and move what
> survives into `candidate-profile.md` by hand. This file is overwritten on
> every run, so edits made here are lost - edit the profile, not this.

**How to read a line**

- `[A]` - **direct citation.** The cited page literally says this. The
  evidence line quotes it.
- `[B]` - **reasoned inference.** What the quoted evidence implies about
  scope or capability. A `[B]` line never asserts a title, a date or a
  number; if one is missing from the page, it is missing here too.
- `[A+B]` - the same item reached both ways.
- A line marked **⚠ flagged source** came from a page that tripped
  `posting_guard.py` (hidden text, instruction-shaped lines, invisible
  characters). The payload is stripped before anything here is derived from
  it, but read that line with the page open.
"""


def render(cmap: CompetencyMap, *, generated_at: str | None = None,
           profile_path: str = "", sources_requested=None) -> str:
    """The proposals file: header, source tables, categories, needs-review."""
    stamp = generated_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = [HEADER.format(generated_at=stamp)]
    if profile_path:
        out.append(f"Source profile read (never written): `{profile_path}`\n")
    if sources_requested:
        out.append("Source types requested: " + ", ".join(sources_requested) + "\n")

    scanned = [r for r in cmap.reports if r.status == "scanned"]
    skipped = [r for r in cmap.reports if r.status != "scanned"]

    out.append("## Sources scanned\n")
    if scanned:
        out.append("| Source | Reference | Signals | Integrity gate |")
        out.append("|---|---|---|---|")
        for r in scanned:
            gate = r.verdict or "not applicable"
            out.append(f"| {r.kind} | {r.ref} | {r.signals} | {'⚠ ' if r.flagged else ''}{gate} |")
    else:
        out.append("_No source could be read on this run._")
    out.append("")

    out.append("## Sources skipped\n")
    if skipped:
        out.append("| Source | Reference | Why |")
        out.append("|---|---|---|")
        for r in skipped:
            out.append(f"| {r.kind} | {r.ref} | {r.reason} |")
    else:
        out.append("_None._")
    out.append("")

    grouped = cmap.by_category()
    for key, heading in CATEGORIES:
        items = grouped[key]
        if not items:
            continue
        out.append(f"## {heading}\n")
        for signal in items:
            mark = " **⚠ flagged source**" if signal.flagged else ""
            out.append(f"- **[{signal.basis}]** {signal.item}{mark}")
            if signal.evidence:
                out.append(f'  - evidence: "{signal.evidence}"')
            out.append(f"  - source: {signal.source_label} - {signal.source_url}")
        out.append("")

    out.append("## Needs manual review\n")
    if cmap.needs_review:
        out.extend(f"- {note}" for note in cmap.needs_review)
    else:
        out.append("_Nothing flagged for manual review._")
    out.append("")
    return "\n".join(out)
