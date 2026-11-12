#!/usr/bin/env python3
"""Sync the ranked shortlist (and, optionally, the whole tracker) into a
Notion "Job Search Pipeline" database - one-way, read-only with respect to
jobseek's own state.

Ported from ai-job-search's `/notion-sync` (MIT, see jobseek/NOTICE),
rebased on jobseek's state/seen_jobs.json and the Director/VP rank fields
instead of its own tracker format.

  * **One-way.** jobseek -> Notion only. Nothing here reads anything back
    from Notion into jobseek's state or the conversation.
  * **Read-only with respect to jobseek's own data.** This never changes a
    posting's rank_score, status or any ranking field - the only field it
    writes back to state/seen_jobs.json is `notion_page_id`, so a page is
    written once and updated on resync rather than duplicated.
  * **No-op when Notion isn't connected.** A missing/empty OAuth token
    (`tools/notion_client.py`) is not an error - it is reported cleanly so
    the owner knows to connect, and nothing in state changes.
  * **No stored Notion API token in this repo.** Authentication is the
    Notion MCP's own OAuth sign-in, read from an external account folder
    (see jobseek/NOTION_SETUP.md) - exactly the Gmail account-folder
    pattern this repo already uses.

Filters:
  --min-score N   only postings with rank_score >= N (0-100 scale, same as
                  the stored `rank_score` field)
  --all           every stored posting, regardless of score or gate verdict
  --rebuild       create a fresh page for every synced posting instead of
                  updating the one already tracked (the old page is archived,
                  never left as an orphaned duplicate)
With neither --min-score nor --all, this syncs the current shortlist - the
same ranked, non-vetoed, top-N set `list_shortlist`/`rank` return.

Usage:
  python3 jobseek/tools/notion_sync.py sync [--min-score N] [--all] [--rebuild]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as jobseek_config  # noqa: E402
import notion_client  # noqa: E402

DATABASE_SCHEMA = {
    "Title": {"title": {}},
    "Company": {"rich_text": {}},
    "Status": {"rich_text": {}},
    "Score": {"number": {}},
    "URL": {"url": {}},
    "Deadline": {"date": {}},
    "Reason": {"rich_text": {}},
    "JobKey": {"rich_text": {}},
}


def _is_eligible(entry: dict) -> bool:
    return (
        entry.get("status") == "ranked"
        and entry.get("location_verdict") != "FAIL"
        and entry.get("seniority_gate") != "FAIL"
        and entry.get("engineering_role") is not True
    )


def select_entries(
    seen: dict, *, min_score: float | None = None, all_: bool = False, top_n: int = 5
) -> list[tuple[str, dict]]:
    """Which (key, entry) pairs this sync run covers - the filtering logic,
    independent of Notion/network so it is directly unit-testable."""
    items = list(seen.items())
    if all_:
        return items

    eligible = [(k, e) for k, e in items if _is_eligible(e)]
    if min_score is not None:
        return [(k, e) for k, e in eligible if (e.get("rank_score") or 0) >= min_score]

    eligible.sort(key=lambda kv: kv[1].get("rank_score", 0), reverse=True)
    return eligible[:top_n]


def _rich_text(value) -> dict:
    return {"rich_text": [{"text": {"content": str(value)[:2000]}}]} if value else {"rich_text": []}


def build_properties(key: str, entry: dict) -> dict:
    props = {
        "Title": {"title": [{"text": {"content": str(entry.get("title") or key)[:2000]}}]},
        "Company": _rich_text(entry.get("company")),
        "Status": _rich_text(entry.get("status")),
        "Score": {"number": entry.get("rank_score")},
        "URL": {"url": entry.get("url") or None},
        "Reason": _rich_text(entry.get("reason")),
        "JobKey": _rich_text(key),
    }
    deadline = entry.get("deadline")
    props["Deadline"] = {"date": {"start": deadline}} if deadline else {"date": None}
    return props


def _load_seen(seen_jobs_path: Path) -> tuple[dict, dict] | None:
    """(doc, seen-map), or None when the store doesn't exist/parse - a clean
    "nothing to sync" rather than rank_state's hard sys.exit (notion_sync
    runs standalone and must no-op gracefully, not crash a fresh checkout).
    `doc` is the raw parsed JSON (may equal `seen`, or wrap it under a
    "seen" key) - kept so a resync writes back in the same shape."""
    if not seen_jobs_path.is_file():
        return None
    try:
        doc = json.loads(seen_jobs_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    seen = doc.get("seen") if isinstance(doc, dict) and "seen" in doc else doc
    return (doc, seen) if isinstance(seen, dict) else None


def _save_seen(seen_jobs_path: Path, doc_or_seen) -> None:
    import os
    import tempfile
    fd, tmp = tempfile.mkstemp(dir=str(seen_jobs_path.parent), prefix=".seen_jobs.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc_or_seen, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, seen_jobs_path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def ensure_database(client, notion_cfg: dict) -> str:
    if notion_cfg.get("database_id"):
        return notion_cfg["database_id"]
    parent = notion_cfg.get("parent_page_id")
    if not parent:
        raise notion_client.NotionError(
            "no notion.database_id or notion.parent_page_id configured - "
            "set one in jobseek/config.json (see jobseek/NOTION_SETUP.md)"
        )
    return client.create_database(parent, notion_cfg.get("database_name", "Job Search Pipeline"), DATABASE_SCHEMA)


def sync(
    config: dict,
    *,
    min_score: float | None = None,
    all_: bool = False,
    rebuild: bool = False,
    client=None,
) -> dict:
    """Runs the sync. `client` is an injected NotionClient-shaped object for
    tests; production code leaves it None and this builds one from the
    configured OAuth account folder."""
    notion_cfg = jobseek_config.notion_config(config)

    if client is None:
        client = notion_client.build_client(notion_cfg["account_dir"])
    if client is None:
        return {
            "connected": False,
            "synced": 0,
            "created": 0,
            "updated": 0,
            "message": (
                "Notion is not connected - sign in via the Notion MCP "
                f"(see jobseek/NOTION_SETUP.md); expected a token at "
                f"{notion_cfg['account_dir']}/token.json. No changes made."
            ),
        }

    seen_jobs_path = jobseek_config.resolve_path(config, "seen_jobs")
    with jobseek_config.state_lock(seen_jobs_path):
        loaded = _load_seen(seen_jobs_path)
        if loaded is None:
            return {
                "connected": True,
                "synced": 0,
                "created": 0,
                "updated": 0,
                "message": f"no postings yet ({seen_jobs_path} not found) - run run-alerts first",
            }
        doc, seen = loaded

        top_n = jobseek_config.top_n(config)
        entries = select_entries(seen, min_score=min_score, all_=all_, top_n=top_n)

        database_id = ensure_database(client, notion_cfg)

        created = updated = 0
        changed = False
        for key, entry in entries:
            properties = build_properties(key, entry)
            existing_page_id = entry.get("notion_page_id")
            if rebuild:
                new_id = client.create_page(database_id, properties)
                if existing_page_id:
                    client.archive_page(existing_page_id)
                entry["notion_page_id"] = new_id
                created += 1
                changed = True
            elif existing_page_id:
                client.update_page(existing_page_id, properties)
                updated += 1
            else:
                new_id = client.create_page(database_id, properties)
                entry["notion_page_id"] = new_id
                created += 1
                changed = True

        if changed:
            # `entry` objects came straight out of `seen` (same dicts), so the
            # mutations above already live in `seen`/`doc` - persist as-is.
            _save_seen(seen_jobs_path, doc)

    return {
        "connected": True,
        "database_id": database_id,
        "synced": len(entries),
        "created": created,
        "updated": updated,
        "min_score": min_score,
        "all": all_,
        "rebuild": rebuild,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="command", required=True)
    sync_ap = sub.add_parser("sync", help="sync the shortlist (or everything) to Notion")
    sync_ap.add_argument("--min-score", type=float, default=None)
    sync_ap.add_argument("--all", action="store_true")
    sync_ap.add_argument("--rebuild", action="store_true")
    sync_ap.add_argument("--config", type=Path, help="override jobseek/config.json")
    args = ap.parse_args(argv)

    config = jobseek_config.load_config(args.config)
    try:
        result = sync(config, min_score=args.min_score, all_=args.all, rebuild=args.rebuild)
    except notion_client.NotionError as exc:
        print(json.dumps({"connected": True, "error": str(exc)}, ensure_ascii=False))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0  # a clean no-op (not connected / nothing to sync) is still exit 0


if __name__ == "__main__":
    raise SystemExit(main())
