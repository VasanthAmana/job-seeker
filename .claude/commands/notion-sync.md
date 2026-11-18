# /notion-sync - push the shortlist (or everything) to Notion

One-way, read-only-with-respect-to-jobseek sync of the ranked shortlist into
a "Job Search Pipeline" Notion database. Ported from ai-job-search's
`/notion-sync` (MIT, see `jobseek/NOTICE`); see `jobseek/NOTION_SETUP.md` for
connecting Notion the first time.

`$ARGUMENTS` may contain:

- Nothing -> sync the current shortlist (ranked, non-vetoed, top-N - same
  set `run alerts` shortlists)
- `--min-score <N>` -> sync postings with `rank_score >= N` (0-100 scale)
  instead of the shortlist
- `--all` -> sync every stored posting, regardless of score or gate verdict
- `--rebuild` -> create a fresh Notion page for every synced posting instead
  of updating the one already tracked (the old page is archived)

Run:

```bash
python3 jobseek/tools/notion_sync.py sync   # add --min-score/--all/--rebuild per $ARGUMENTS
```

This is a deterministic tool, not a judgment call - run it once and report
its JSON output directly:

- `"connected": false` -> Notion isn't connected yet. Show the `message`
  field (it names the expected token path) and point to
  `jobseek/NOTION_SETUP.md`. This is expected, not a failure - stop here,
  nothing was changed.
- `"connected": true` with `created`/`updated`/`synced` counts -> report them
  plainly: "Synced N postings to Notion (C created, U updated)." Mention
  `database_id` the first time a database was created (worth saving to
  `jobseek/config.json`'s `notion.database_id` per `NOTION_SETUP.md`).
- A non-zero exit / `"error"` field -> a genuine Notion API or configuration
  problem (e.g. no `database_id`/`parent_page_id` configured). Show the error
  verbatim; do not retry silently.

**Never** read anything back from Notion into `state/seen_jobs.json` or the
conversation beyond the page id `notion_sync.py` itself records for re-sync
- this command only pushes.
