#!/usr/bin/env python3
"""Run the whole expansion: discover public sources, read them, propose additions.

This is the non-interactive core of ai-job-search's `/expand`, ported for a
Director/VP AI-strategy profile. It performs the original's Step 0
(read the existing profile), Step 1 (discovery, public sources only), the
citation half of Step 2 plus the bounded inference each source module
implements, Step 3 (categorized, source-attributed, deduplicated map) and
Step 6 (report what was scanned, skipped and needs review).

Step 4 - the `all`/`review`/`skip` confirmation - and Step 5 - writing the
confirmed items into the profile - are deliberately **not** ported. An MCP
tool call has nobody to prompt, so there is nothing to confirm against, and
writing into `candidate-profile.md` without that confirmation would break
the one rule that file states about itself. Instead everything lands in a
separate `expand-proposals.md`, rewritten from scratch on every run, and the
owner moves what survives into the profile by hand. `expand.md` is where the
interactive version of Steps 2b/4/5 lives, for a human-in-the-loop session.

Safety properties, each pinned by `expand/tests/`:

  * **No profile file is ever written.** The only writable path is a file
    named `expand-proposals.md`; any other name is refused before anything
    is fetched.
  * **Public sources only, and only the ones the profile names.** No local
    CV, LinkedIn export, diploma or reference-letter step exists here - the
    original's 1a-1d have no analogue in this port.
  * **Every page goes through `posting_guard.py`.** A source that trips it
    is still used, but every signal derived from it is marked, and the
    verdict is printed in the proposals file.
  * **One failing source never fails the run.** It becomes a skipped row
    with its reason.

Usage:
  python3 expand/tools/expand_profile.py [--sources github,scholar]
      [--profile PATH] [--out PATH] [--url kind=URL ...] [--json]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))
JOBSEEK_ROOT = TOOLS_DIR.parent.parent
JOBSEEK_TOOLS = JOBSEEK_ROOT / "tools"
if str(JOBSEEK_TOOLS) not in sys.path:
    sys.path.insert(0, str(JOBSEEK_TOOLS))

import config as jobseek_config  # noqa: E402
import github_source  # noqa: E402
import linkedin_source  # noqa: E402
import profile_sources  # noqa: E402
import scholar_source  # noqa: E402
import web_source  # noqa: E402
from competency_map import (  # noqa: E402
    PROPOSALS_FILENAME, CompetencyMap, SourceReport, render,
)
from profile_sources import SOURCE_KINDS  # noqa: E402
from read_source import read_url  # noqa: E402

DEFAULT_OUT = JOBSEEK_ROOT / "profile" / PROPOSALS_FILENAME
MAX_NEEDS_REVIEW_IN_SUMMARY = 20


class ExpandError(ValueError):
    """Bad input, or a write that would land anywhere but the proposals file."""


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def resolve_out_path(out: Path | str | None = None) -> Path:
    """The proposals path, refusing to be pointed at a profile file.

    The filename is fixed. A directory is accepted and the proposals file is
    placed inside it; any other filename - `candidate-profile.md` above all -
    is refused here, before a single page is fetched, so no failure mode of
    this tool can end in an overwritten profile.
    """
    if out is None:
        return DEFAULT_OUT
    path = Path(out).expanduser()
    if path.is_dir() or str(out).endswith(("/", "\\")):
        return path / PROPOSALS_FILENAME
    if path.name != PROPOSALS_FILENAME:
        raise ExpandError(
            f"refusing to write to {path.name!r}: expand only ever writes a file named "
            f"{PROPOSALS_FILENAME!r}. It never edits candidate-profile.md or any other profile file.")
    return path


def normalise_sources(sources=None) -> tuple:
    """Validate the `sources` narrowing argument. None/empty means every kind."""
    if sources is None:
        return SOURCE_KINDS
    if isinstance(sources, str):
        sources = [part for part in sources.replace(",", " ").split() if part]
    if not isinstance(sources, (list, tuple)):
        raise ExpandError("sources must be a list of source-type names")
    wanted = []
    for item in sources:
        kind = str(item).strip().lower()
        if not kind:
            continue
        if kind not in SOURCE_KINDS:
            raise ExpandError(f"unknown source type {kind!r} (have: {', '.join(SOURCE_KINDS)})")
        if kind not in wanted:
            wanted.append(kind)
    return tuple(wanted) or SOURCE_KINDS


def extra_sources(cfg: dict | None) -> list:
    """Public source URLs from `config.json`'s optional `expand.extra_sources`.

    Entries are `{"kind": "press", "url": "https://..."}` or a bare URL
    string. This is how a talk, a board page or a press article that the
    candidate profile does not link gets scanned without editing the profile;
    `config.json` is gitignored, so it is also where a URL the owner would
    rather not commit belongs.
    """
    raw = ((cfg or {}).get("expand") or {}).get("extra_sources") or []
    refs = []
    for entry in raw:
        if isinstance(entry, str):
            ref = profile_sources.classify_url(entry)
        elif isinstance(entry, dict) and entry.get("url"):
            ref = profile_sources.classify_url(str(entry["url"]), str(entry.get("kind") or ""))
        else:
            continue
        if ref is not None:
            refs.append(ref)
    return refs


def _scan_one(ref, facts, reader, linkedin_client_loader=None):
    """Dispatch one SourceRef to its scanner. -> (signals, reports, needs_review)."""
    if ref.kind == "github":
        return github_source.scan(ref.ref, reader=reader)
    if ref.kind == "scholar":
        return scholar_source.scan(ref.ref, reader=reader)
    if ref.kind == "linkedin":
        extra = {"client_loader": linkedin_client_loader} if linkedin_client_loader else {}
        return linkedin_source.scan(ref.ref, name=facts.name, reader=reader, **extra)
    return web_source.scan(ref.ref, ref.kind, name=facts.name, reader=reader)


def build_map(facts, *, sources=None, cfg=None, reader=read_url,
              linkedin_client_loader=None) -> CompetencyMap:
    """Read every selected source and fold the results into one competency map.

    `linkedin_client_loader` overrides how `linkedin_source` finds the
    jobseek LinkedIn client. Left as None it loads `linkedin/client.py`
    from disk, which is the production path; the tests pass a stand-in so a
    run never depends on whether the LinkedIn app happens to be running on
    the machine the suite is on.
    """
    wanted = normalise_sources(sources)
    cmap = CompetencyMap()
    refs = [ref for ref in list(facts.sources) + extra_sources(cfg) if ref.kind in wanted]
    for kind in wanted:
        if any(ref.kind == kind for ref in refs):
            continue
        cmap.reports.append(SourceReport(
            kind, "-", "skipped",
            reason=("no handle or URL for this source type in candidate-profile.md "
                    "(and none in config.json's expand.extra_sources) - nothing is guessed")))
    for ref in refs:
        try:
            signals, reports, review = _scan_one(ref, facts, reader, linkedin_client_loader)
        except Exception as exc:  # noqa: BLE001 - one bad source is a skipped row, not a failed run
            cmap.reports.append(SourceReport(ref.kind, ref.ref, "skipped",
                                             reason=f"{type(exc).__name__}: {exc}"))
            continue
        cmap.extend(signals)
        cmap.reports.extend(reports)
        for note in review:
            if note not in cmap.needs_review:
                cmap.needs_review.append(note)
    return cmap


def summarise(cmap: CompetencyMap, *, out_path: Path, generated_at: str,
              profile_path: str, sources_requested) -> dict:
    """The JSON-shaped result the MCP tool returns - a summary, never the map."""
    return {
        "proposals_path": str(out_path),
        "generated_at": generated_at,
        "profile_read": profile_path,
        "sources_requested": list(sources_requested),
        "signals_total": len(cmap.signals),
        "signals_by_category": cmap.counts(),
        "sources_scanned": [
            {"kind": r.kind, "ref": r.ref, "signals": r.signals,
             "integrity_gate": r.verdict, "flagged": r.flagged}
            for r in cmap.reports if r.status == "scanned"
        ],
        "sources_skipped": [
            {"kind": r.kind, "ref": r.ref, "reason": r.reason}
            for r in cmap.reports if r.status != "scanned"
        ],
        "flagged_sources": cmap.flagged_sources(),
        "needs_review": cmap.needs_review[:MAX_NEEDS_REVIEW_IN_SUMMARY],
        "note": ("Proposals only. Nothing was written to candidate-profile.md or any other "
                 "profile file; read the proposals file and apply what survives by hand."),
    }


def run(*, profile=None, sources=None, out=None, cfg=None, reader=read_url,
        extra_urls=None, generated_at=None, linkedin_client_loader=None) -> dict:
    """Discover, read, map and write the proposals file. Returns the summary."""
    out_path = resolve_out_path(out)          # refuse a bad target before any fetch
    wanted = normalise_sources(sources)
    cfg = cfg if cfg is not None else jobseek_config.load_config()
    facts = profile_sources.load_profile(profile)
    if extra_urls:
        merged = list(facts.sources)
        for kind, url in extra_urls:
            ref = profile_sources.classify_url(url, kind)
            if ref is not None:
                merged.append(ref)
        facts.sources = tuple(merged)
    cmap = build_map(facts, sources=wanted, cfg=cfg, reader=reader,
                     linkedin_client_loader=linkedin_client_loader)
    stamp = generated_at or _now()
    text = render(cmap, generated_at=stamp, profile_path=facts.path, sources_requested=wanted)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding="utf-8")
    return summarise(cmap, out_path=out_path, generated_at=stamp,
                     profile_path=facts.path, sources_requested=wanted)


def _parse_url_arg(value: str) -> tuple:
    kind, sep, url = value.partition("=")
    if not sep:
        return "", kind
    return kind.strip().lower(), url.strip()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="expand_profile.py",
        description="Propose profile additions from public sources; see the module docstring.")
    parser.add_argument("--profile", type=Path, default=None,
                        help="candidate-profile.md to read (never written)")
    parser.add_argument("--sources", default=None,
                        help=f"comma-separated subset of: {', '.join(SOURCE_KINDS)}")
    parser.add_argument("--out", type=Path, default=None,
                        help=f"where to write {PROPOSALS_FILENAME} (a directory, or that exact filename)")
    parser.add_argument("--url", action="append", default=[], metavar="KIND=URL",
                        help="an extra public source to scan, e.g. press=https://...")
    parser.add_argument("--jobseek-config", type=Path, default=None)
    parser.add_argument("--json", action="store_true", help="print the summary as JSON")
    args = parser.parse_args(argv)

    try:
        cfg = jobseek_config.load_config(args.jobseek_config)
        summary = run(profile=args.profile, sources=args.sources, out=args.out, cfg=cfg,
                      extra_urls=[_parse_url_arg(value) for value in args.url])
    except (ExpandError, jobseek_config.ConfigError) as exc:
        print(f"expand_profile: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    print(f"wrote {summary['proposals_path']}")
    print(f"{summary['signals_total']} proposed signal(s) across "
          f"{len(summary['sources_scanned'])} scanned source(s); "
          f"{len(summary['sources_skipped'])} skipped")
    for row in summary["sources_skipped"]:
        print(f"  skipped {row['kind']} {row['ref']}: {row['reason']}")
    print(summary["note"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
