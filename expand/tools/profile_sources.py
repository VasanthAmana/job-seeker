#!/usr/bin/env python3
"""Read `profile/candidate-profile.md` and list the public sources it names.

This is Step 0 plus the "other URLs in profile" half of Step 1 from
ai-job-search's `/expand`, and it is the only place `expand` touches
the profile at all - **read-only, always.** The profile's own header says the
owner fills it from the resume and nothing in it may be invented; this module
honours that by never writing to it and never inventing a source that is not
written there.

That is also the privacy boundary. `expand` scans a source only when
the owner's profile names a handle or URL for it: no guessing a GitHub
username from a name, no searching for a person who did not publish a link.
A source type with no handle in the profile is reported as skipped, with that
as the reason, rather than quietly not happening.

`[FILL ...]` placeholders are ignored - an unfilled template line is not a
source.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

JOBSEEK_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_PROFILE = JOBSEEK_ROOT / "profile" / "candidate-profile.md"

# Every source type expand knows. `sources=` on the MCP tool narrows to these.
SOURCE_KINDS = ("github", "scholar", "linkedin", "talks", "press", "board", "site")

URL_RE = re.compile(r"https?://[^\s<>\"'`)\]]+")
FILL_RE = re.compile(r"\[FILL[^\]]*\]", re.I)
NAME_RE = re.compile(r"^[ \t]*-[ \t]*\*\*Name:?\*\*[ \t]*(.+?)[ \t]*$", re.I | re.M)
# "### VP, AI Strategy - Globex Corp (2021 - present)": the company half is
# the affiliation a publication or press search would be qualified with.
ROLE_RE = re.compile(r"^###\s+(?P<title>[^\n]+?)\s+[-–]\s+(?P<company>[^(\n]+?)\s*(?:\((?P<period>[^)]*)\))?\s*$", re.M)
LABEL_RE = re.compile(r"^[ \t]*[-*][ \t]*\*\*(?P<label>[A-Za-z][A-Za-z /&-]*?):?\*\*[ \t]*(?P<value>.+?)[ \t]*$", re.M)

# A labelled profile line whose value is a bare handle rather than a URL.
LABEL_KINDS = {
    "github": "github",
    "google scholar": "scholar",
    "scholar": "scholar",
    "linkedin": "linkedin",
    "publications": "scholar",
    "talks": "talks",
    "speaking": "talks",
    "press": "press",
    "media": "press",
    "board": "board",
    "board roles": "board",
    "advisory": "board",
    "website": "site",
    "portfolio": "site",
    "personal site": "site",
}

HANDLE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$")

# A URL the profile drops in without a label still usually says what it is.
# Only the two unambiguous shapes are guessed at; a news article is not
# guessable from its URL, so press stays label-driven (or `--url press=...`).
TALKS_HINT = re.compile(r"(speaker|speaking|talks?|keynote|conference|summit|webinar|podcast|programme)", re.I)
BOARD_HINT = re.compile(r"(board|trustee|advisory|advisor|governors?)", re.I)


@dataclass(frozen=True)
class SourceRef:
    """One public source the profile points at.

    `ref` is what the scanner needs: a GitHub username for `github`, a URL
    for everything else. `origin` says which profile line produced it, so the
    proposals file can tell the owner where a scanned source came from.
    """

    kind: str
    ref: str
    origin: str = ""

    @property
    def label(self) -> str:
        return f"{self.kind}: {self.ref}"


@dataclass
class ProfileFacts:
    """What the profile says about the person, for qualifying a lookup."""

    name: str = ""
    affiliations: tuple = ()
    linkedin_slug: str = ""
    sources: tuple = ()
    path: str = ""


def _github_user(url: str) -> str | None:
    parts = [p for p in urlsplit(url).path.split("/") if p]
    if not parts:
        return None
    user = parts[0]
    if user.lower() in ("orgs", "topics", "search", "about", "features", "sponsors"):
        return None
    return user


def _linkedin_slug(url: str) -> str:
    parts = [p for p in urlsplit(url).path.split("/") if p]
    if len(parts) >= 2 and parts[0].lower() == "in":
        return parts[1]
    return ""


def classify_url(url: str, hint: str = "") -> SourceRef | None:
    """A URL plus the label it sat behind -> one SourceRef, or None if unusable."""
    url = url.rstrip(".,;)")
    split = urlsplit(url)
    if split.scheme not in ("http", "https") or not split.netloc:
        return None
    host = split.netloc.lower()
    if host.endswith("github.com") or host == "github.com":
        user = _github_user(url)
        return SourceRef("github", user, url) if user else None
    if "scholar.google." in host:
        return SourceRef("scholar", url, url)
    if host.endswith("linkedin.com"):
        return SourceRef("linkedin", url, url)
    if hint in ("talks", "press", "board", "scholar"):
        return SourceRef(hint, url, url)
    target = f"{host}{split.path}"
    if TALKS_HINT.search(target):
        return SourceRef("talks", url, url)
    if BOARD_HINT.search(target):
        return SourceRef("board", url, url)
    return SourceRef("site", url, url)


def _from_labelled_line(label: str, value: str) -> list[SourceRef]:
    """A `- **GitHub:** handle` line: a bare handle, or URLs inside the value."""
    kind = LABEL_KINDS.get(label.strip().lower())
    urls = URL_RE.findall(value)
    if urls:
        return [ref for ref in (classify_url(u, kind or "") for u in urls) if ref]
    if kind in ("github", "linkedin") and HANDLE_RE.match(value.strip()):
        handle = value.strip()
        if kind == "github":
            return [SourceRef("github", handle, f"profile line: {label}")]
        return [SourceRef("linkedin", f"https://www.linkedin.com/in/{handle}/", f"profile line: {label}")]
    return []


def parse_profile(text: str, path: str = "") -> ProfileFacts:
    """Everything `expand` needs out of the profile, and nothing else."""
    text = FILL_RE.sub(" ", text)
    name_match = NAME_RE.search(text)
    name = name_match.group(1).strip() if name_match else ""
    affiliations = []
    for match in ROLE_RE.finditer(text):
        company = match.group("company").strip().strip("*_")
        if company and company not in affiliations and not company.startswith("["):
            affiliations.append(company)

    refs: list[SourceRef] = []
    seen = set()

    def push(ref: SourceRef | None) -> None:
        if ref is None:
            return
        key = (ref.kind, ref.ref.rstrip("/").lower())
        if key not in seen:
            seen.add(key)
            refs.append(ref)

    # A labelled line wins: "- **Press:** <url>" is a press source, and the
    # sweep below must not also file that same URL as a generic site.
    claimed = set()
    for match in LABEL_RE.finditer(text):
        label, value = match.group("label"), match.group("value")
        for ref in _from_labelled_line(label, value):
            push(ref)
        for url in URL_RE.findall(value):
            claimed.add(url.rstrip(".,;)").rstrip("/").lower())
    # Any other URL anywhere in the profile - the original's Step 1f.
    for url in URL_RE.findall(text):
        if url.rstrip(".,;)").rstrip("/").lower() in claimed:
            continue
        push(classify_url(url))

    linkedin_slug = ""
    for ref in refs:
        if ref.kind == "linkedin":
            linkedin_slug = _linkedin_slug(ref.ref)
            break

    return ProfileFacts(
        name=name,
        affiliations=tuple(affiliations),
        linkedin_slug=linkedin_slug,
        sources=tuple(refs),
        path=path,
    )


def load_profile(path: Path | str | None = None) -> ProfileFacts:
    """Read the profile file (read-only) and parse it. A missing file is empty facts."""
    resolved = Path(path).expanduser() if path else DEFAULT_PROFILE
    if not resolved.is_file():
        return ProfileFacts(path=str(resolved))
    return parse_profile(resolved.read_text(encoding="utf-8"), str(resolved))
