#!/usr/bin/env python3
"""LinkedIn, through jobseek's own LinkedIn tool when it exists, else the web path.

Two paths, tried in that order, and the proposals file always says which one
ran:

1. **`linkedin/client.py`** - the Python client for the vendored
   LinkedIn MCP app. When the app is running and signed in, this module
   calls its read-only `linkedin_search_people` tool and takes the owner's
   public headline from the result. That catalogue has no "read my own
   profile" tool, so a people search for the owner's own name, matched
   against the profile slug the candidate profile already names, is the
   strongest signal available through it. `linkedin_save_job`, the app's one
   write, is never called.
2. **`read_source.read_url()`** - the same robots-gated, bounded,
   `posting_guard`-scanned GET the rest of `expand` uses.

LinkedIn blocks naive fetching hard, so path 2 normally comes back refused.
That is reported as a skipped source with LinkedIn's own reason, and the run
continues. **It is never guessed around**: no inferred job title, no
reconstructed history, nothing but what a path actually returned.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from urllib.parse import urlsplit

from competency_map import SourceReport, cited, inferred
from read_source import clean_prose, read_url

JOBSEEK_ROOT = Path(__file__).resolve().parent.parent.parent
CLIENT_PATH = JOBSEEK_ROOT / "linkedin" / "client.py"

EXEC_WORDS = re.compile(
    r"\b(chief|vp\b|vice president|director|head of|board|advisor|adviser|partner|principal"
    r"|founder|executive|strategy|strategist|transformation|governance)\b", re.I)
PEOPLE_SEARCH_LIMIT = 10


def load_client():
    """`linkedin/client.py` as a module, or None when it is absent.

    Imported by path rather than by name, for two reasons: the module name
    `client` is too generic to rely on finding on `sys.path` (mcp
    puts `linkedin/` there, but nothing else does), and a checkout
    without `linkedin/` must still run the rest of this scan rather
    than fail to import.
    """
    if not CLIENT_PATH.is_file():
        return None
    spec = importlib.util.spec_from_file_location("jobseek_linkedin_client", CLIENT_PATH)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception:  # noqa: BLE001 - a half-landed branch must not break expand
        return None
    return module


def _slug(url: str) -> str:
    parts = [p for p in urlsplit(url).path.split("/") if p]
    return parts[1].lower() if len(parts) >= 2 and parts[0].lower() == "in" else ""


def _match_person(people, slug: str, name: str):
    """The owner's own entry in a people-search result, or None.

    Matched on the profile slug the candidate profile already names, and only
    then on an exact name match - a headline attached to the wrong person is
    worse than no headline.
    """
    for person in people:
        if not isinstance(person, dict):
            continue
        if slug and _slug(str(person.get("profileUrl") or "")) == slug:
            return person
    if name:
        for person in people:
            if isinstance(person, dict) and str(person.get("name") or "").strip().lower() == name.strip().lower():
                return person
    return None


def _tool_path(client, url: str, name: str, slug: str):
    """Path 1. -> (signals, reason) where a non-empty reason means it did not run."""
    if not name.strip():
        return [], "candidate-profile.md has no `- **Name:**`, so the LinkedIn tool has nothing to search for"
    try:
        client.status()
        result = client.search_people(name, limit=PEOPLE_SEARCH_LIMIT)
    except Exception as exc:  # noqa: BLE001 - the client raises its own error types
        return [], f"jobseek LinkedIn tool unavailable ({type(exc).__name__}: {exc})"
    person = _match_person(result.get("people") or [], slug, name)
    if person is None:
        return [], (f"jobseek LinkedIn tool returned {len(result.get('people') or [])} result(s), "
                    "none matching the profile URL in candidate-profile.md")
    label = "LinkedIn (jobseek linkedin_search_people)"
    signals = []
    headline, flagged = clean_prose(str(person.get("headline") or ""))
    if headline:
        signals.append(cited("strategic-leadership", f"LinkedIn headline: {headline}",
                             headline, url, label, flagged))
        if EXEC_WORDS.search(headline):
            signals.append(inferred(
                "strategic-leadership",
                "Publicly positioned at executive/leadership level",
                f"the public LinkedIn headline reads: {headline}", url, label, flagged))
    profile_url = str(person.get("profileUrl") or url)
    signals.append(cited("speaking", f"Public LinkedIn profile is live at {profile_url}",
                         "returned by the read-only jobseek LinkedIn people search", url, label))
    return signals, ""


def scan(url: str, *, name: str = "", reader=read_url, client=None, client_loader=load_client):
    """Scan the owner's LinkedIn profile. -> (signals, reports, needs_review notes)."""
    slug = _slug(url)
    needs_review: list = []
    client = client if client is not None else client_loader()
    tool_reason = ("linkedin/client.py is not present in this checkout - "
                   "the LinkedIn MCP tool path was not available")
    if client is not None:
        signals, tool_reason = _tool_path(client, url, name, slug)
        if signals:
            return signals, [SourceReport("linkedin", url, "scanned", len(signals),
                                          verdict="read through the jobseek LinkedIn tool (no page fetched)")], needs_review

    read = reader(url, "html")
    if not read.ok:
        needs_review.append(
            "LinkedIn: nothing was read. LinkedIn blocks unauthenticated fetching, so this is the "
            "expected outcome without the jobseek LinkedIn app running. Add LinkedIn facts by hand, "
            "or start the app (see linkedin/app/README.md) and re-run.")
        return [], [SourceReport("linkedin", url, "skipped",
                                 reason=f"{tool_reason}; web fetch: {read.reason}")], needs_review

    label = "LinkedIn (public page fetch)"
    signals = []
    headline = ""
    for line in read.text.splitlines():
        stripped = line.strip()
        if 20 <= len(stripped) <= 200 and name and name.lower() not in stripped.lower():
            headline = stripped
            break
    if headline:
        quote, flagged = clean_prose(headline)
        signals.append(cited("strategic-leadership", f"LinkedIn public page line: {quote}",
                             quote, url, label, flagged or read.flagged))
    needs_review.append(
        "LinkedIn: the public page was readable but is a logged-out teaser, not the full profile. "
        "Treat anything taken from it as a pointer and confirm on the real profile.")
    return signals, [SourceReport("linkedin", url, "scanned", len(signals),
                                  verdict=read.verdict, flagged=read.flagged)], needs_review
