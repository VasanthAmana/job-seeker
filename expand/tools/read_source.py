#!/usr/bin/env python3
"""The one read-only path by which `expand` pulls a public page.

A GitHub README, a Scholar profile, a conference programme and a press
article are untrusted third-party text in exactly the way a job posting is,
so they go through the stack jobseek already uses for postings rather than a
second, weaker one:

    tools/robots_check.py  -> tools/fetch_page.py  -> tools/posting_guard.py
      (RFC 9309 gate,          (GET-only, browser      (hidden content, invisible
       fail-closed)             headers, bounded,       characters, instruction-
                                redirects re-gated)     shaped lines; removed)

`fetch_page.main()` is called rather than reimplemented: it owns the robots
gate for the first hop *and* every redirect, the 45 s / 5-redirect / 10 MB
bounds, the http(s)-only rule and the refusal to write fetched bytes inside
the repo. Its one awkwardness for library use - it prints the gate verdict
and returns a process exit code - is handled here by capturing stdout, which
is cheaper than owning a second copy of that logic.

Nothing in this module writes to the repo. Fetched bytes land in a temporary
directory and are deleted when the read returns.

Three cleaning entry points, all of them `posting_guard.guard`:

  * `read_url(url)` - fetch and clean a whole page.
  * `clean_fragment(markup)` - clean an HTML fragment a parser pulled out of
    a page (a Scholar table cell), in `--html` mode, so a `display:none`
    payload inside the fragment is removed there too.
  * `clean_prose(text)` - clean a plain-text field (a JSON `bio`, a README
    line) in `--text` mode.

A caller that parses structure out of raw markup or JSON must pass every
prose value it extracts through one of the last two before that value
reaches a `Signal`. The page-level read is what produces the verdict shown
in the proposals file; the per-value clean is what keeps a payload out of
the text the owner reads.
"""

from __future__ import annotations

import contextlib
import io
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

JOBSEEK_ROOT = Path(__file__).resolve().parent.parent.parent
JOBSEEK_TOOLS = JOBSEEK_ROOT / "tools"
if str(JOBSEEK_TOOLS) not in sys.path:
    sys.path.insert(0, str(JOBSEEK_TOOLS))

import fetch_page  # noqa: E402
import posting_guard  # noqa: E402
from page_decode import decode_page  # noqa: E402

__all__ = ["SourceRead", "read_url", "clean_fragment", "clean_prose",
           "is_instruction_like", "default_fetcher"]


@dataclass
class SourceRead:
    """The outcome of one read: what came back, cleaned, and whether to trust it."""

    url: str
    status: str = "error"       # "fetched" | "robots" | "error"
    reason: str = ""
    raw: str = ""               # decoded page bytes - UNTRUSTED, never shown to a reader
    text: str = ""              # posting_guard-cleaned text
    findings: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == "fetched"

    @property
    def verdict(self) -> str:
        return self.findings.get("verdict", "")

    @property
    def flagged(self) -> bool:
        return "⚠" in self.verdict


def default_fetcher(url: str, out: Path) -> tuple[int, str]:
    """Run `fetch_page.main` for one URL, returning (exit code, its output).

    Exit 0 = fetched (whatever the HTTP status), 1 = robots.txt refused the
    path, 2 = usage or transport error. The captured output carries the gate
    verdict line, which is what the skipped-sources table quotes.
    """
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
        code = fetch_page.main([url, "--out", str(out)])
    return code, buffer.getvalue().strip()


def _last_line(text: str) -> str:
    lines = [line for line in (text or "").splitlines() if line.strip()]
    return lines[-1].strip() if lines else "no output"


def read_url(url: str, mode: str = "html", *, fetcher=None) -> SourceRead:
    """Fetch one URL read-only and return it cleaned by `posting_guard.py`.

    `fetcher` is the seam the tests use: any callable `(url, out_path) ->
    (exit_code, message)` that writes the body to `out_path`. The default
    runs the real `fetch_page.py`; the test suite passes a fixture reader, so
    no test touches the network.
    """
    fetcher = fetcher or default_fetcher
    with tempfile.TemporaryDirectory(prefix="jobseek_expand_") as tmp:
        out = Path(tmp) / "page"
        try:
            code, message = fetcher(url, out)
        except Exception as exc:  # noqa: BLE001 - a transport failure is a skipped source, not a crash
            return SourceRead(url=url, status="error", reason=f"{type(exc).__name__}: {exc}")
        if code == 1:
            return SourceRead(url=url, status="robots", reason=_last_line(message) or "robots.txt refused this path")
        if code != 0:
            return SourceRead(url=url, status="error", reason=_last_line(message) or f"fetch failed (exit {code})")
        if not out.is_file():
            return SourceRead(url=url, status="error", reason="fetch reported success but wrote nothing")
        raw = decode_page(out.read_bytes())
    text, findings = posting_guard.guard(raw, mode)
    return SourceRead(url=url, status="fetched", reason="", raw=raw, text=text, findings=findings)


def clean_fragment(markup: str) -> tuple[str, bool]:
    """Clean an HTML fragment pulled out of a page. Returns (text, flagged)."""
    text, findings = posting_guard.guard(markup or "", "html")
    return text, "⚠" in findings.get("verdict", "")


def clean_prose(text: str) -> tuple[str, bool]:
    """Clean a plain-text value (JSON field, README line). Returns (text, flagged)."""
    cleaned, findings = posting_guard.guard(text or "", "text")
    return cleaned, "⚠" in findings.get("verdict", "")


def is_instruction_like(text: str) -> bool:
    """Is this line one `posting_guard.py` would quote as aimed at an agent?

    The gate deliberately *quotes* instruction-shaped lines rather than
    removing them - an SSH administrator posting legitimately says "SSH", so
    deleting the line would corrupt a real posting. Nothing in a profile
    proposal needs such a line, though, so the extractors here use this to
    skip one outright: a README whose first sentence is "Ignore all previous
    instructions" contributes no summary at all rather than contributing
    that sentence.
    """
    return bool(posting_guard.scan(text or "", "")["instruction_like"])
