# job-seeker build plan

- **Status:** proposed, for review together with [design.md](design.md). No phase starts before that review.
- **Before phase 1:** the [migration pull request](https://github.com/merkensoft-iris/job-seeker/pull/6), which moves the predecessor `jobseek` code here with its history, is merged and its CI is green.

## 1. Rules for every phase

1. **Shippable.** Each phase ends with a tagged release (`v0.<phase>.0`) that installs and runs on its own. Behaviour from earlier phases keeps working.
2. **Tested offline.**
   - Unit, fixture, migration and MCP protocol tests run in CI on Linux, macOS and Windows.
   - Live checks against real services are manual. Each phase lists them, and they refuse to run when `CI=true`.
3. **Safe for a public repository.**
   - Fixtures use fictional people and `example.com` addresses. CI runs a fixture-hygiene scan and a secret scan.
   - The data directory is never inside the repository, and job-seeker enforces this.
   - Commits use a GitHub noreply author.
4. **Migrations.** Every schema change ships with a migration, a fixture database snapshot and a test that migrates it.
5. **Connectors.** Every connector passes `job-seeker connector test <id>` offline (design section 6.5).
6. **Docs.** A phase that changes a design decision updates `design.md` in the same pull request.

## 2. Overview

| Phase | Delivers | Depends on | Release |
|---|---|---|---|
| 1 | Engine core, storage, MCP server, scheduler | Migration merged | v0.1.0 |
| 2 | Profile intake and the existing sources | 1 | v0.2.0 |
| 3 | LinkedIn connector and browser sessions | 2 | v0.3.0 |
| 4 | The other new connectors (the five portal issues) | 2 (can be built alongside 3, ships after it) | v0.4.0 |
| 5 | Market research and criteria approval | 2 (uses 4's market data when present) | v0.5.0 |
| 6 | Resume templates and application preparation | 2 | v0.6.0 |

## 3. Phase 1: engine core, storage, MCP server and scheduler

**Goal.** job-seeker installs, starts as a background service, keeps its state in SQLite, serves MCP and runs schedules. The migrated tools keep working.

**Scope.**

- **Packaging.** `pyproject.toml`, the package `jobseeker` and the console command `job-seeker`, installable with `pipx` or `uv tool` from the repository. Python 3.10 or later. The only dependencies are `keyring`, and `tzdata` on Windows.
- **Setup.** `job-seeker init` creates the per-OS data directory and refuses one inside a git work tree. `job-seeker doctor` checks Python, Node, TeX, `pdftotext`, the keychain backend and the daemon.
- **Store.**
  - SQLite in WAL mode, the migration runner, and the first migration with the tables this phase needs: runs, steps, schedules, events, human steps, bindings, settings, jobs, sightings, scores and applications.
  - A backup is taken before each migration, and a database newer than the code is refused.
- **Engine API v1.** The operation table with JSON Schemas, and the events feed.
- **Secrets.** The `keyring` store, the encrypted-file fallback and the redactor. `job-seeker secrets set|list|delete`.
- **Scheduler.**
  - The daemon, with interval, cron and manual schedules, jitter, one catch-up run after sleep, run leases and heartbeats.
  - `job-seeker service install|uninstall|status` for a launchd agent, a systemd user unit and a Task Scheduler task.
- **Needs-human signal.** The human-steps table and OS notifications, in place before any connector needs them.
- **Reports.** `report@1` JSON and HTML, reshaped from `dashboard/build.py`, plus `latest.html` and `job-seeker report open`.
- **MCP.**
  - The reshaped stdio server with resources, prompts and elicitation, and protocol version negotiation.
  - New tools: `status`, `schedules_*`, `run_status`, `reports_*`, and `jobs_list`, `job_get`, `jobs_search` over the store.
  - The existing tools keep their current behaviour.
- **Legacy import.** `job-seeker import-legacy` for `seen_jobs.json`, `last_run.json` and `tracker.csv`.

**Done when.**

1. On a fresh macOS, Windows and Linux machine, `init` and `service install` work. After a reboot the daemon runs a test schedule and the weekly maintenance schedule, which shows that schedules survive restarts.
2. Claude Desktop, configured with `job-seeker mcp`, lists the tools. `status`, `jobs_list` and `report_get` answer over legacy data imported from a fictional fixture, with every job naming its source.
3. The migrated MCP tools answer exactly as before.
4. A run's HTML report opens offline with no assistant.

**Tests.**

- Migrations: from an empty database, and from every fixture snapshot.
- Scheduler, with an injected clock: cron and interval, daylight-saving changes, catch-up after sleep, lease expiry and takeover, and one active run per schedule.
- Golden files for each OS's service definition.
- MCP over stdio: tools, resources, prompts and error paths.
- The secret store against a fake keyring, including the fallback file's permissions, and the redactor.
- The legacy import, checked by record counts.
- Refusal of a data directory inside a git work tree.

**Risks.** Keychain portability and Windows background running (section 9).

## 4. Phase 2: profile intake and the existing sources

**Goal.** Using only an assistant, a user builds a profile from a resume or a description, saves criteria and ingests the existing alert sources. They get a ranked, de-duplicated list in which every job names its sources, both on demand and on a schedule.

**Scope.**

- **Profile.**
  - Sources: PDF through `pdftotext`, DOCX read from its XML, LaTeX, pasted text, free text and user statements. Text is extracted with character offsets.
  - Documents: `profile@1` claims with evidence, quote validation, versions, diffs and the `intake_profile` prompt. The user's filled copy of `profile/candidate-profile.md` can be imported.
  - Expansion: `profile_expand_scan` and the `github-public` connector, reshaped from `expand/`.
- **Connector host.**
  - The manifest schema and its validation, and `connectors/registry.json`.
  - The contracts `mailbox@1`, `jobs.alerts@1` and `jobs.detail@1`.
  - The connector context, with `needs_human` writing human steps.
  - The connector testing kit: static checks for AI imports, determinism and fixture hygiene.
- **Connectors.**
  - `gmail`: the OAuth loopback flow, with the refresh token kept in the keychain. A one-time import from the old account folder, with the user's consent. A read-only scope check.
  - `linkedin-alerts`, `indeed-alerts`, `ladders-alerts`, `employer-alerts` and `web-posting`.
- **Criteria.** `criteria@1` sets and versions. A direct edit by the user is recorded as a change the user both proposed and approved. Connector selection and per-connector filters.
- **Pipeline.** Dedupe, the posting guard, details for the top candidates and the rule ranker. Assistant scores arrive through `rank_submit` and the `review_matches` prompt, and the right score is shown (design section 8).
- **Applications.** The `found`, `shortlisted`, `applied`, `interview`, `offer` and `rejected` states, `application_set_state`, listing and CSV export.
- **Runs and reports.**
  - `search_run`, `alerts_ingest` and the default schedules.
  - Reports with new jobs, top matches, changes since the last run, connector results and "Waiting for you".
- **Retired at the end of the phase:**
  - the JSON state path;
  - the legacy MCP tool aliases;
  - Notion sync;
  - the predecessor's Claude Code files: `.claude/commands/run-alerts.md`, `.claude/commands/notion-sync.md` and `.claude/agents/posting-scorer.md`.

**Done when.**

1. In Claude Desktop alone, the user can do the whole phase-2 flow:
   - import a resume (fictional in CI);
   - review the claims with their evidence and save version 1;
   - create a criteria set and run alert ingest;
   - see ranked, de-duplicated jobs with their sources.
2. A scheduled alert ingest runs with no assistant connected and writes its report.
3. A revoked Gmail token opens an `auth_expired` human step. It shows in the report, in `status` and as a notification.
4. Every claim in a saved profile points to a source span, and a version with a mismatched quote is rejected.

**Tests.**

- Extraction from fictional resumes in each format, with offset checks, and evidence validation.
- The connector kit for each connector, using the existing sanitised alert-email fixtures.
- Dedupe across two connectors.
- Golden tests for the rule ranker: gate vetoes and bands.
- `rank_submit` validation, reusing `rank_state`'s tests.
- Criteria change records.
- One scripted MCP session covering the whole phase-2 flow against fixtures.

**Risks.**

- **PDF layouts.** Some lose structure in text extraction. The assistant cites spans of the extracted text, and the user can paste the text instead.
- **Scanned PDFs.** These have no text layer and are refused with that reason.
- **Gmail refresh tokens.** A Google OAuth client left in "Testing" mode expires its refresh tokens after 7 days, so the setup guide says to publish the consent screen.

## 5. Phase 3: the LinkedIn connector and browser sessions

**Goal.** LinkedIn search, job details, reading the user's own profile and alert results all run headless in one persistent session. Human steps follow the lifecycle in design section 7.

**Scope.**

- **Spike first.** A manual week on the user's own account, written up as a decision record in `docs/`:
  - alternate headless runs and headed windows on one profile at normal pace;
  - record challenges, sign-outs and the cookie-encryption launch flags on each OS;
  - confirm the Chromium channel and how the profile lock behaves.
- **Browser host.** Node 18 or later, with Playwright pinned.
  - A stdio link to the engine, and one persistent context per service.
  - The guards and the pacer (from `pacing.js`), the cache, the captures and challenge detection.
  - Mode switching between headless and headed.
  - The browser download, with the user's consent (`job-seeker browser install`).
- **Session lifecycle.**
  - States, leases and the sign-in flow.
  - Interactive and scheduled human steps, wait limits, resuming from the step's cursor, and sign-out.
  - CLI: `sessions list|open|signout`. MCP: `sessions_list`, `session_open` and `session_done`.
- **`linkedin` connector** (JavaScript):
  - Ported from the app: the extractors, URL builders and "needs you" detection.
  - Actions: `search_jobs` (criteria mapping), `get_job`, `read_own_profile` (a new extractor and fixture), the `alerts` sync (list the account's alerts, then replay each one) and `search_people`.
  - An hourly budget planner shared by all criteria sets, which defers whatever does not fit.
  - The binding requires the user to accept its `tos_risk` flag when it is created.
- **Profile intake from LinkedIn** (`profile_read_linkedin`).
- **Retired:** the Electron app shell and its socket endpoint.

**Done when.**

1. A session survives a restart of the daemon and of the machine.
2. With fixtures, a login page, a security check and a two-factor prompt each lead to `needs_human`, and nothing is typed. A scheduled run records "Waiting for you" in its report and sends a notification.
3. **Manual live check.** The user resolves a human step in the headed window. The same run then carries on headless in the same profile and finishes.
4. The pacer never goes over the hourly cap. When the cap is hit, the work is deferred and the report says so.
5. A scheduled LinkedIn search for a saved criteria set appears in the report, merged with sightings from alert emails.

**Tests.**

- The extractor fixtures, run under Playwright's `setContent`. These port the existing jsdom tests.
- Guard tests:
  - input into a credential field is refused;
  - off-origin navigation is blocked;
  - cookie export is refused.
- The lifecycle state machine, against a fake browser host.
- Headless to headed to headless on one profile directory, against a local fixture site.
- A property test of the pacer and budget planner, with an injected clock.
- The connector kit.

**Risks.** LinkedIn's site rules, markup drift and headless session durability (section 9).

## 6. Phase 4: the other new connectors

**Goal.** The five portal issues land as connectors.

**Scope.**

- **`adzuna`**, through the official API with an API key:
  - `search_jobs` maps criteria to `what_or`, `what_exclude`, `title_only`, `where`, `distance`, `max_days_old` and `salary_min`;
  - `market.stats@1` uses Adzuna's salary histogram and top-companies data;
  - conservative default rate limits, and back-off on HTTP 429.
- **`naukri-alerts`, `iimjobs-alerts`, `execthread-alerts` and `builtin-alerts`**, which parse alert emails:
  - each portal's hosts go in `noFetchHosts`;
  - a job is scored from the alert body and flagged `partial`, and `employer_hidden` is set when the alert hides the company;
  - when the alert names the employer, the employer's own posting is used through `web-posting`, subject to robots.txt.
- **Proof before code.** Each connector first needs a real exchange that the user captures: an alert email, or an API response. It is turned into a synthetic fixture, and the redaction is reviewed before the pull request. A connector without proof stays out of the registry. The phase ships with the proven connectors, and the others' issues stay open.
- **One pull request per connector,** each closing its issue.

**Done when.**

1. Each shipped connector passes the kit offline, has its registry entry, and can be selected by a criteria set.
2. A manual live run succeeds for each connector.
3. A test shows that no posting is ever fetched from a no-fetch host.

**Tests.** A fixture parser for each portal, recorded API replays for Adzuna, enforcement of `noFetchHosts`, golden tests of criteria mapping, and scoring of `partial` jobs.

**Risks.**

- **Alert formats.** These are undocumented until the first real alert arrives.
- **Sign-ups.** Signing up and saving alerts on each portal is a human step that the user must do first.
- **Adzuna.** Its terms changed recently, and it no longer publishes rate limits.
- **Portal terms.** These can change, so they are checked again when each connector is built.

## 7. Phase 5: market research and criteria approval

**Goal.** Research produces dated, evidence-backed findings. Research and the assistant can propose criteria changes, and nothing changes without a recorded approval.

**Scope.**

- **Research.**
  - Finding kinds: skills in demand, skill gaps (reshaped from `upskill`), titles and adjacent roles, certifications, salary ranges, and the locations and sectors that are hiring.
  - Each finding cites its evidence: stored jobs, and `market.stat@1` records when present.
  - Runs are dated, can be compared, and render a heatmap and report. A weekly schedule runs them.
- **Proposals.** Deterministic heuristics, each citing its evidence and requiring a minimum number of jobs:
  - an adjacent title that matches well but is not yet searched;
  - a location that is hiring;
  - an exclusion that vetoes too many strong jobs.

  The assistant can also propose changes.
- **Approval.**
  - The user decides in the CLI, through MCP elicitation, or through the recorded `assistant_reported` fallback.
  - A proposal is superseded when its target changes first.
  - Rejected proposals are kept.
- **MCP.** The `research_*` tools, `criteria_propose`, `criteria_decide`, `research_annotate` and the `review_research` prompt.
- **Reports.** A "Pending approvals" section, and the research deltas.

**Done when.**

1. A research run over a fictional job corpus yields findings whose evidence resolves to stored jobs. Two runs a week apart can be compared.
2. **From Claude Desktop.**
   - The user runs research, and the assistant proposes a change that cites findings.
   - The user approves it in the conversation, through elicitation where the client supports it, and a new criteria version exists.
   - The record shows who proposed the change, the evidence, the approval channel and the time.
   - A rejected proposal stays listed.
3. An approval made in the CLI writes the same record.
4. An invariant test confirms that no criteria version exists without an approved change.

**Tests.**

- Golden tests of the aggregation, and salary percentiles.
- Evidence resolution.
- The proposal heuristics.
- The approval state machine, including two decisions racing.
- An elicitation round trip with a fake client.
- The invariant test.

**Risks.**

- **Thin evidence.** With few jobs, findings carry their sample size, and heuristics stay silent below the minimum.
- **Clients without elicitation.** The weaker approval channel is recorded honestly.

## 8. Phase 6: resume templates and application preparation

**Goal.** Tailored resumes come from several LaTeX templates, and every claim traces to the profile. The assistant gets everything it needs to apply.

**Scope.**

- **Template registry.**
  - Each template lives in `templates/<id>/`, with a `template.json` and its files, and its sha256 is tracked.
  - The existing moderncv resume, plus two more permissively licensed templates: a plain single-column one for applicant-tracking systems, and a compact one. Their licences go in `NOTICE`.
- **Content model.** Resume items cite claim IDs.
  - `resume_prepare` returns:
    - the guarded job text;
    - the profile's claims, ordered by keyword coverage (`ats_keywords`);
    - the template's slots and page budget;
    - the user's writing preferences.
  - `resume_render` audits, renders and stores, in that order:
    - **audit by claim:** numbers, dates, titles and tools must appear in the cited claims or their evidence, and role titles and dates are copied verbatim;
    - **render:** compile, then check the page count, the text layer and overflow;
    - **store:** save the resume record and move the application to `resume_prepared`.
- **Without an assistant.** `resume_render` with `content: auto` uses the top claims' own text, unchanged.
- **Prompts and tools.** The `tailor_resume` prompt (including the reviewer's checks), `application_prepare` and the `apply_to_job` prompt.
- **Retired:** the old tailor command files, the pandoc route and the why-me and cover templates.

**Done when.**

1. For a fictional profile and job, every template renders a PDF within its page budget, with an extractable text layer.
2. An item with an invented metric, title, date or tool is rejected, and the error names the failing token. The existing "fabricated" fixture covers this.
3. Every resume record links the job, the template and its sha256, and the profile version. Every item resolves to source spans.
4. **From Claude Desktop:**
   - prepare and render the resume, then call `application_prepare`;
   - the assistant applies, then calls `application_set_state` with `applied`;
   - over the fixture flow, the tracker shows all seven states.

**Tests.**

- The existing tailor tests, moved.
- The grounding audit by claim, and the template registry.
- A render of every template, in a CI job that installs a TeX engine such as tectonic. The predecessor's CI skipped these tests.
- The application state machine.

**Risks.**

- **TeX on Windows.** TeX is large, and MiKTeX's install-on-the-fly packages need care.
- **Template licences.**
- **Page-budget failures** must give actionable errors.

## 9. Risk register

| Risk | Phase | Impact | Mitigation | Watch for |
|---|---|---|---|---|
| **LinkedIn site rules.** LinkedIn's User Agreement prohibits automated access and scraping, so the account could be restricted | 3 | High | Own account only, read-only. At most 40 page loads an hour with 3 to 7 second gaps. Details only for top candidates. Stop at any challenge and never evade detection. Explicit `tos_risk` consent and a per-binding off switch. LinkedIn's alert emails remain a route that needs no session | Challenge frequency in the spike and in reports. Any restriction notice: disable the binding and fall back to alert emails |
| **LinkedIn markup drift** | 3 | Medium | Page captures, signed-in and selector probes, `selectorsVersion`, a `degraded` state that opens a human step | Zero-result runs with captures |
| **Headless session durability.** Sites may challenge headless browsers or new devices more often; a crash can lose recent cookies; upgrades can change the profile format | 3 | High | The spike. The same build and profile in both modes. Clean context shutdown. A re-probe after every browser upgrade. A `requiresHeaded` fallback | Human steps per week in reports |
| **Keychain portability** | 1, 2, 3 | Medium | Read below the table | Keychain-related human steps |
| **Unknown alert formats** | 4 | Medium | Proof before code. Connectors without proof stay unregistered | First real alert per portal |
| **Adzuna terms and limits** | 4 | Low | Conservative default limits, back-off on HTTP 429, a check of the terms at build time | HTTP 429 rate in reports |
| **MCP client differences.** Clients differ in support for resources, prompts and elicitation | 1, 5 | Medium | Tools alone can carry every flow. The fallbacks are recorded | Client test matrix: Claude Desktop, Codex |
| **Install footprint.** Python, Node, Chromium (about 150 MB) and TeX | 1, 3, 6 | Low | Optional parts install only when their feature is turned on. `doctor` reports what is missing | Setup failures |
| **Windows background running.** Task Scheduler and toast notifications behave differently | 1 | Medium | Golden-file tests in CI, and a manual live check each release | Missed runs on Windows |
| **Private data in a public repository** | All | High | The data directory sits outside the repository, and this is enforced. `.gitignore`, the fixture-hygiene and secret scans, the noreply author, and captures never inside the repository | CI scan results |
| **Data growth** | 1, 5 | Low | Retention from design section 12.5. Size warnings and `gc` | The data directory's size |

**Keychain portability, in detail.**

- **macOS.** Keychain may ask again after the Python interpreter's path changes, for example when `pipx` or `uv` upgrades it. A denied read opens a human step instead of failing silently.
- **Linux.** Servers and minimal desktops may have no Secret Service. They get the encrypted-file fallback, with an honest warning.
- **Windows.** Credential Manager limits the size of each secret to about 2.5 KB, so it holds tokens only, never cookies.
- **Browser cookies.** Chromium's cookie encryption uses the same backends.

## 10. Not in this plan

- The Command Center integration.
- WhatsApp or any other browser connector beyond LinkedIn.
- Email notifications, or a local web UI.
- LLM scoring with a key of job-seeker's own.
