# Connecting Notion for `notion_sync`

`notion_sync` (the `notion sync` command and the `notion_sync` MCP tool)
pushes jobseek's ranked shortlist into a Notion database, one-way: jobseek
writes, nothing is ever read back. It never stores a Notion API token in
this repo - authentication is the Notion MCP's own OAuth sign-in, read from
a local account folder exactly like the Gmail setup in `README.md`.

## 1. Connect the Notion MCP

Use your usual Notion MCP / Notion-for-Claude connection flow to sign in
(OAuth) and authorize access to the workspace that should hold "Job Search
Pipeline". Once connected, that flow writes a token to:

```
~/.notion-mcp/default/token.json      # {"access_token": "..."}
```

(or wherever `config.json`'s `notion.account_dir` points - see
`config.example.json`.) This path is **outside** this repository and
is never read into git; `notion_sync` only ever reads it, never writes it.

No token file, or an empty/unreadable one: `notion_sync` reports
`"connected": false` with a clear message and makes no changes - this is the
expected state before you've connected Notion, not an error.

## 2. Point jobseek at a parent page (first sync only)

The database is created once, under a page you choose. In
`config.json` (copy from `config.example.json` if you haven't):

```json
"notion": {
  "account_dir": "~/.notion-mcp/default",
  "database_name": "Job Search Pipeline",
  "database_id": null,
  "parent_page_id": "<the Notion page id to create the database under>"
}
```

The first successful sync creates the database under `parent_page_id` and
you can then copy its id into `database_id` (optional - `notion_sync` will
otherwise just reuse `parent_page_id` to look it up... in the current
implementation, set `database_id` explicitly after the first run so later
syncs don't need `parent_page_id` at all).

No `database_id` and no `parent_page_id` configured: `notion_sync` fails
with a clear configuration message (not a silent no-op, since this is a
setup gap rather than "Notion isn't connected").

## 3. Run it

```bash
python3 tools/notion_sync.py sync              # current shortlist
python3 tools/notion_sync.py sync --all         # every stored posting
python3 tools/notion_sync.py sync --min-score 70
python3 tools/notion_sync.py sync --rebuild     # recreate every synced page
```

or, in a Claude Code session: **notion sync**, **notion sync --all**, etc.
(`.claude/commands/notion-sync.md`).

## What gets written

One Notion page per posting, with Title, Company, Status, Score, URL,
Deadline, Reason and the posting's jobseek key (`JobKey`, for cross-
reference). Each posting's Notion page id is written back to
`state/seen_jobs.json` (gitignored) as `notion_page_id` - so a
resync **updates** that same page rather than creating a duplicate.
`--rebuild` creates a fresh page and archives the previous one instead.

## Safety

- One-way: jobseek -> Notion only. Nothing from Notion is ever read back
  into jobseek's ranking state or the conversation.
- Read-only with respect to jobseek's own data: the only field `notion_sync`
  writes to `state/seen_jobs.json` is `notion_page_id`.
- No Notion API token is ever committed; `state/`, `config.json` and the
  account folder are all outside git's reach (see `.gitignore`, and
  the account folder lives outside the repo entirely).
