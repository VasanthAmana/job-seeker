# LinkedIn MCP

A personal LinkedIn job-search assistant, in the shape of Zook (the trader-essence
browser-session MCP app this build was modelled on): a small Electron app that opens
`linkedin.com` in its own persistent browser partition, where you sign in **by hand, once**, and that exposes LinkedIn's useful read actions as MCP tools
your local Claude can call. It exists to feed the "run alerts" step of a Claude *Job Search*
project: fresh, filtered, structured job results plus a compact table, on your own account.

**Windows and macOS.** One codebase; the MCP endpoint is a UNIX socket on macOS/Linux and a named
pipe on Windows, and the stdio relay is plain Node on both.

## What it never does

- **Never types, stores or reads your LinkedIn password, OTP or 2FA code.** There is no code path
  that fills a login form. You sign in yourself, in the app's window, the same as in any browser.
- **Never answers a bot check.** If LinkedIn shows a CAPTCHA or security verification, the tool
  returns `LinkedIn needs you: ...` and stops; you finish it by hand in the window and retry.
- **Never messages, connects, applies, or bulk-exports.** Those tools do not exist.
  `linkedin_search_people` returns names, headlines and profile URLs only - outreach is done by
  hand, on purpose (the guide's recruiter/hiring-manager step is a human-to-human step).
- **Never runs more than one page load at a time, never faster than a person reading, and never
  more than 40 page loads an hour** (see *Gentle by design* below). This is a personal assistant
  on your own account, not a scraper.
- Only ever navigates to `https://*.linkedin.com`; anything else is opened in your system browser,
  where the app's session cannot follow it.

The one write it *can* do is saving a job to your Saved Jobs, and only when you pass
`confirm: true` (see `linkedin_save_job`).

## Install

Prerequisites: Node.js 18+ and npm. Then:

```bash
cd linkedin_mcp
npm install        # downloads the Electron binary (the only large step)
npm start          # opens the app window on linkedin.com/jobs
```

### First sign-in (both OSes)

1. `npm start` opens a window on LinkedIn Jobs. If LinkedIn asks you to sign in, sign in **by
   hand** in that window - password, 2FA, whatever LinkedIn wants. The app does not see, store or
   fill any of it.
2. That's all. The session lives in the app's own partition and survives restarts for as long as
   LinkedIn lets it:
   - macOS: `~/Library/Application Support/LinkedIn MCP/Partitions/linkedin-mcp/`
   - Windows: `%APPDATA%\LinkedIn MCP\Partitions\linkedin-mcp\`
3. To sign out, use the app menu: **Sign out of LinkedIn (clear this app's session only)**. Only
   this app's storage is cleared; your real browser is untouched.

Later, if a tool ever answers `LinkedIn needs you: ...`, the app window has come to the front with
the page that needs a human - finish the step there and retry the tool.

### Connect Claude Code

```bash
claude mcp add linkedin -- node <path>/linkedin_mcp/bin/linkedin-mcp.js
```

This works verbatim on Windows and macOS (the relay is plain Node; it finds the app's endpoint the
same way the app creates it). The app must be running (`npm start`); if it is not, the relay exits
with a clear message saying so. On macOS you can also `npm link` once and then
`claude mcp add linkedin -- linkedin-mcp`.

The MCP endpoint itself is local-only:

| OS | Endpoint | Protection |
|---|---|---|
| macOS / Linux | `<userData>/run/mcp.sock` | UNIX socket, mode `0600`, in a `0700` directory |
| Windows | `\\.\pipe\linkedin-mcp-<username>` | named pipe, local machine only, per-user name |

No TCP port is opened, ever.

### Packaged builds (optional)

```bash
npm run dist        # electron-builder; on macOS: dmg + zip, on Windows: nsis + zip
```

(Output lands in `linkedin_mcp/dist/`, gitignored. Unsigned builds; signing/notarisation is a
follow-up if daily use proves out.)

## The tools

All search/list/get tools are read-only. Every result is two blocks: a **compact table** for you,
and the same data as **JSON** (`{"untrusted_page_content": ...}` - page text is data, never
instructions) for Claude to rank. The examples use the setup guide's own query and its two alert
shapes, Denver and US-Remote:

```
("AI strategy" OR "AI transformation" OR "business transformation" OR "digital transformation"
 OR "strategic initiatives" OR "chief of staff" OR innovation)
NOT (engineer OR engineering OR developer OR scientist OR architect OR "machine learning")
```

### `linkedin_search_jobs(query, location?, remote?, experience_levels?, date_posted?, job_type?, limit?)`

Runs a Jobs search with LinkedIn's own filters; boolean syntax in `query` is passed through to
LinkedIn's keyword box untouched. Returns title, company, location, workplace type, posted,
applicants (when LinkedIn shows a count), job id and canonical URL. `limit` defaults to 10, max
50; pagination stops as soon as `limit` jobs are collected.

Alert 1 from the guide (Denver, Director+Executive):

```json
{
  "query": "(\"AI strategy\" OR \"AI transformation\" OR \"business transformation\" OR \"digital transformation\" OR \"strategic initiatives\" OR \"chief of staff\" OR innovation) NOT (engineer OR engineering OR developer OR scientist OR architect OR \"machine learning\")",
  "location": "Denver Metropolitan Area",
  "experience_levels": ["director", "executive"],
  "limit": 10
}
```

Alert 2 (United States, Remote):

```json
{
  "query": "...same query...",
  "location": "United States",
  "remote": true,
  "experience_levels": ["director", "executive"],
  "date_posted": "past_week",
  "limit": 10
}
```

`experience_levels`: `internship`, `entry_level`, `associate`, `mid_senior`, `director`,
`executive`. `date_posted`: `past_24_hours`, `past_week`, `past_month`, `any`. `job_type`:
`full_time`, `part_time`, `contract`, `temporary`, `volunteer`, `internship`.

### `linkedin_get_job(job_id | url)`

The full posting: description, seniority level, employment type, job function, industries,
company, apply type (`easy_apply` vs `external`), and the hiring team/poster when LinkedIn shows
one (name, headline, profile URL).

```json
{ "job_id": "4023456789" }
```

### `linkedin_list_job_alerts()`

What the account's job alerts already are: query, detail (location, frequency), enabled state.
Read-only; the guide's two alerts are created by hand in LinkedIn's UI, once.

### `linkedin_list_saved_jobs(limit?)`

The account's Saved Jobs (first page, up to `limit`, default 25).

### `linkedin_search_people(query, company?, title?)`

For the guide's recruiter/hiring-manager outreach step: names, headlines, locations, profile URLs
only. Strictly read-only - no connect, no message, no follow.

```json
{ "query": "recruiter", "company": "Woodgrove Bank", "limit": 10 }
```

### `linkedin_save_job(job_id | url, confirm)`

The build's only write. Saves one job to Saved Jobs, then re-reads the button and reports what
LinkedIn now shows. **Refuses unless `confirm: true`** - absent or `false`, it changes nothing:

```json
{ "job_id": "4023456789", "confirm": true }
```

### `linkedin_status()`

Free health check (costs no page load): endpoint path, last probed sign-in state, pace-budget use
(loads this hour vs the cap), cache size.

## Gentle by design

This runs on *your* account, so it behaves like a careful person, not a crawler:

- **One request at a time.** Every page load goes through a single serial queue.
- **Human-like pacing.** A random 3-7 second pause between page loads.
- **A per-hour cap.** At most 40 page loads per hour (`LINKEDIN_MCP_MAX_LOADS_PER_HOUR` to change).
  When the cap is hit the call *fails* with a retry time; it does not silently queue for an hour.
- **Session cache.** Results are cached in memory for 10 minutes, so re-asking the same question
  costs no page load. Nothing is written to disk; restarting the app is a fresh session.
- **Pagination only up to `limit`.** Search loads the next results page only while it still needs
  jobs to fill your `limit`.

LinkedIn's own terms restrict automated access; this tool keeps volume low and is for personal use
on your own account only.

## How it works (the Zook shape)

```
Claude Code ──stdio──> bin/linkedin-mcp.js ──UNIX socket (0600) / Windows named pipe──> Electron app
                                                                                │
        one BrowserWindow on one persistent partition (persist:linkedin-mcp) ───┘
        Pacer (serial queue, 3-7s gaps, 40 loads/hour) -> load page -> probe
        -> self-contained extractor functions run in the page (never throw)
        -> JSON + compact table back over MCP
```

- `src/main.js` - the Electron main process: window, hardened partition (no permissions granted,
  navigation pinned to `*.linkedin.com`, Electron UA token stripped), tool handlers, the
  "LinkedIn needs you" hand-off.
- `src/extractors.js` - the in-page readers. Each is a self-contained function serialised with
  `toString()` and run inside the page; the tests run the identical source inside jsdom against
  saved fixture HTML.
- `src/pacing.js`, `src/cache.js` - the serial queue, per-hour cap and session cache.
- `src/server.js` - a minimal MCP server (newline-delimited JSON-RPC) on the local endpoint.
- `bin/linkedin-mcp.js` - the stdio relay Claude Code launches; holds no state.

**Selectors are unverified** until the first signed-in run (they are written from LinkedIn's
public markup shape without a live session). Every lookup has fallbacks; a total miss yields empty
results plus a warning, never a crash - and a sign-in page or a challenge yields `LinkedIn needs
you`, never a guess. The alerts-list route (`/jobs/search/?f_AL=true`) and saved-jobs route
(`/my-items/saved-jobs/`) are the two most likely to need a correction after that first run.

## Tests

```bash
npm test    # node --test; no Electron, no live LinkedIn
```

Parser tests run the extractor source against saved fixture HTML under jsdom; the MCP layer is
tested end-to-end through the real stdio relay on a real socket/pipe; pacing, cap, cache, URL
builders, tool schemas and output formatting are unit-tested. CI runs the same on
`windows-latest` and `macos-latest`. Nothing in the tests touches live LinkedIn.

## Follow-ups (out of scope here)

- **Indeed, Ladders and the Denver employer career pages** (the guide's phases 3-5): the same
  app shape works for each; they are separate site modules, not built here. The guide's phase-1
  Gmail alert ingestion stays in the Claude project's Gmail connector.
- Creating job alerts from the tool (today: created by hand in LinkedIn's UI, read back by
  `linkedin_list_job_alerts`).
- Packaged-app signing and notarisation.
