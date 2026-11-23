# job-seeker design

- **Status:** revised after the design review, for the build. Nothing in this document is built yet.
- **Companion:** [execution-plan.md](execution-plan.md) turns this design into phases, MCP first.
- **Layout:** the predecessor `jobseek` code now lives at this repository's root with its history. Paths in section 11 use that layout.

## 1. Decisions at a glance

1. **One engine, local and single-user, in TypeScript.** The whole of job-seeker is TypeScript on Node.js: the engine core, the connectors, the browser host, the MCP server and the CLI. The migrated Python code is ported, and its tests are the behavioural spec for the port. One runtime keeps the install simple and matches Command Center (CC), whose cc-foundation and cc-engine are TypeScript. State lives in one SQLite database plus a data directory outside the repository. There are no accounts, roles or sharing.
2. **One boundary.** Every caller goes through the **Engine API**: the MCP server, the CLI and the background service. It is a versioned set of JSON-schema'd commands, queries and events, and it is the surface cc-engine's extension API can wrap later. job-seeker never imports CC code.
3. **MCP is the main way in.** The MCP server is a local process that the assistant starts over stdio. There is no network transport for now. Every capability is reachable as an MCP tool, and every build phase is accepted through the MCP interface (see the execution plan).
4. **Connectors follow CC's connector model.** A connector is a package with a `connector.json` manifest that uses CC's fields. It declares capability contracts such as `jobs.search@1`. API connectors and browser connectors are both TypeScript modules: API connectors run in the engine process, browser connectors on a browser host built on Playwright.
5. **The background service runs in the user's own login session.** It is a macOS LaunchAgent, so it can open a visible browser window when a site needs a person. A run that hits a login or a captcha pauses, records the human step, notifies the user, opens a headed window on that site's profile, and carries on headless once the step is done (section 7). The MCP process hands runs to the service, and runs them in-process only when the service is down.
6. **AI is compartmentalised.** Model calls go through one **AI adapter**, which uses the user's own assistant CLI (such as Claude Code or Codex) or an API key, as set in config. Only five named places may call it, and each can be switched off: profile intake, unattended match review, resume tailoring, research synthesis and criteria proposals (section 13). Everything else is deterministic, and every model output passes a deterministic check before it is kept.
7. **Ranking is rule-based first.** Rule scores rank every job unattended. Judgement scores, from the user's assistant over MCP or from the AI adapter's match review, are stored next to them.
8. **Nothing consequential happens without approval.** Criteria changes and LinkedIn profile edits are created as pending **approval records**. The user approves with a plain yes in chat (the assistant then calls a tool), in the CLI, or through MCP elicitation where the client supports it. Every decision is recorded (section 9.1).
9. **LinkedIn is the first connector,** on the user's main account. It searches, reads job details, reads the user's own profile and alerts, and updates the user's own profile. Every profile write is shown as a diff and applied only after approval. It never messages, sends connection requests or applies. Page views are capped at 200 a day.
10. **One install.** One npm package, then `job-seeker setup`, which installs the browser, a bundled Tectonic for LaTeX, the background service, and the MCP configuration for Claude Desktop and Codex (section 12.6).

## 2. The design principle, per capability

The assistant does what needs judgement or writing, in conversation with the user. job-seeker keeps the durable state and does what needs a machine that is always on, logged in and exact. When no assistant is connected, the AI adapter can do a small, named part of the judgement work, and its output is checked the same way.

| # | Capability | The assistant does (over MCP) | The AI adapter may do (switchable) | job-seeker provides and persists |
|---|---|---|---|---|
| 1 | Profile intake | Reads the extracted source text and proposes claims. Discusses edits with the user | Turns a resume or LinkedIn profile text into evidenced claims | Text extraction from PDF, DOCX, LaTeX, free text and the LinkedIn profile. Stored sources. Versioned profile documents. Rejects a claim whose evidence quote does not match its source |
| 2 | API connectors | Nothing at run time | Nothing | Connector registry, manifests, scoped HTTP, secrets, health |
| 3 | Browser connectors | Tells the user when a human step is waiting | Nothing | Persistent profiles, headless runs, the human-step hand-off, pacing, challenge detection |
| 4 | Search by criteria | Optional judgement scores for top matches | Reviews top matches after a scheduled run | Criteria sets, query mapping, dedupe, rule ranking, provenance |
| 5 | Market research | Weighs the findings and explains them to the user | Writes a synthesis of a research run | Dated, evidence-backed aggregates over collected jobs and connector data |
| 6 | Criteria changes | Proposes changes and asks the user | Proposes changes from research, always as pending approvals | Proposals, approval records and the audit trail |
| 7 | Resumes | Selects and phrases claims for one job | Selects and phrases real claims for one job | Template registry, a deterministic grounding audit by claim ID, LaTeX and .docx output, and resume records |
| 8 | LinkedIn profile edits | Drafts an edit with the user | Nothing | Reads the live profile, shows the diff, grounds it against the profile claims, applies it only after approval, then verifies it |
| 9 | Schedules and reports | Nothing (reports are readable without it) | Nothing | Background service, runs, JSON and HTML reports, the pipeline page |
| 10 | MCP server | Is the client | Nothing | Tools, resources, prompts and elicitation |
| 11 | Applying | Fills in the employer's form and submits it, then reports back | Nothing | The application packet (job details, apply URL, tailored resume, "why me" note) and the tracker states |

job-seeker has no chat UI, email writer or form filler. Workflows that used to be Claude Code commands become MCP prompts, which any MCP client can run.

## 3. Component map

```mermaid
flowchart LR
  AS["AI assistant<br/>Claude Desktop, Codex, any MCP client"]
  US["User<br/>terminal, pipeline page, reports, notifications"]
  subgraph JS["job-seeker (one machine, one user, one Node.js runtime)"]
    MCP["MCP server<br/>stdio"]
    CLI["CLI"]
    SVC["Background service<br/>LaunchAgent: scheduler and run executor"]
    API{{"Engine API<br/>the one boundary"}}
    subgraph CORE["Engine core"]
      PRO["Profile"]
      CRI["Criteria"]
      APR["Approvals"]
      JOB["Jobs: dedupe and ranking"]
      RES["Research"]
      RSM["Resumes"]
      APP["Applications"]
      RUN["Schedules, runs, reports"]
      HUM["Human steps"]
    end
    AI["AI adapter<br/>assistant CLI or API key"]
    DB[("SQLite and data directory")]
    CH["Connector host<br/>API connectors"]
    BH["Browser host<br/>Playwright"]
    TEX["Resume renderer<br/>Tectonic, pandoc"]
    SEC["Secret store<br/>OS keychain"]
  end
  SVCS["Service APIs and the mailbox"]
  WEB["Sites without an API"]
  AS -- "MCP" --> MCP --> API
  US --> CLI --> API
  SVC --> API
  API --> CORE --> DB
  CORE -. "five named call sites" .-> AI
  API --> CH --> SVCS
  CH --> SEC
  API --> BH --> WEB
  API --> TEX
```

**Processes.** There is no network listener. Processes share state through the database and the data directory.

| Process | Started by | Role |
|---|---|---|
| `job-seeker service` | The LaunchAgent, in the user's login session (section 12.1) | The only scheduler. Executes queued and scheduled runs, opens headed browser windows for human steps, sends notifications, runs maintenance |
| `job-seeker mcp` | The assistant, over stdio | Serves MCP. It never schedules. It queues runs for the service, and executes a run itself only when the service is down |
| `job-seeker` (CLI) | The user | Setup, secrets, sessions, approvals, reports, the pipeline page |
| Browser host | Spawned on demand by whichever process executes the run | Owns Playwright contexts. Closes after 10 idle minutes |
| AI adapter backend | Spawned per call by the engine, when the configured backend is an assistant CLI | Runs one non-interactive call with no tools, then exits |

**Concurrency.** SQLite runs in WAL mode with short write transactions. A run is claimed with a lease row (owner, expiry, heartbeat), so the service and an MCP process never execute the same run. Each binding runs one step at a time. Each browser session is serial.

**Run hand-off.** An MCP tool that starts work (`search_run`, `alerts_ingest`, `linkedin_profile_apply` and so on) writes a `queued` run and touches `run/wake` in the data directory. The service watches that file and its own 30-second schedule tick, and writes its heartbeat every 5 seconds, separately from the tick. If the service's heartbeat is older than 15 seconds, the MCP process takes the run's lease and executes it in-process instead. Both paths run in the user's session, so both can open a headed window. If the MCP client disconnects mid-run, the lease expires and the next executor resumes the run from its step cursors. A tool can wait up to 60 seconds for a short run; otherwise it returns the run ID and the assistant follows it with `run_status`.

### 3.1 Technology choices

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22 LTS or later | One runtime for every component |
| Language | TypeScript, `strict` | Compiled to JavaScript for the npm package |
| Database | SQLite through Node's built-in `node:sqlite`, with `better-sqlite3` as the fallback | Chosen in phase 1 by a short check of WAL, `VACUUM INTO` and prebuilt availability; recorded in `docs/decisions/` |
| MCP | The official TypeScript SDK, stdio transport | Tools, resources, prompts and elicitation |
| Browser | Playwright with its pinned Chromium build | Persistent contexts, one profile per service |
| Secrets | The OS keychain through a maintained native binding, with an encrypted-file fallback | Section 5.5 |
| Schemas | JSON Schema, validated at every boundary | The same schemas generate the TypeScript types |
| Tests | Vitest, plus an MCP test client over stdio | Section 3 of the execution plan |
| LaTeX | Tectonic, a pinned build downloaded and checksum-checked by `setup` | Bundled, so the user installs no TeX distribution |
| .docx | pandoc, when the user has it | Optional. `setup` reports whether it is present |

## 4. The engine boundary

- **Shape.** The engine exposes named operations. Each one has a kind (command or query), a risk (`read`, `write_internal`, or `write_external` for an action that changes something outside job-seeker, such as a LinkedIn profile edit), and an input and output JSON Schema under `schemas/engine/v1/`. MCP tools, CLI commands and service jobs are thin adapters generated from or checked against that table, so there is one source of truth. A `write_external` operation can only execute an approved approval record.
- **Versioning.** `ENGINE_API = 1`. A breaking change adds `v2` schemas and keeps `v1` working for one minor release.
- **Events.** Every state change appends a domain event, such as `job.found`, `job.scored`, `criteria.changed`, `approval.decided`, `linkedin.profile_edit_applied`, `application.state_changed`, `human_step.opened` and `run.finished`. Events are stored in an `events` table with a monotonic cursor. Reports read from it, and a later integration can sync from it.
- **How CC can wrap it later (not built now):**
  1. Call the Engine API through job-seeker's MCP server, run as a local server with an allowlist of tools.
  2. Load job-seeker's connector manifests, which already use CC's fields. Connectors are TypeScript written against a CC-shaped context, so moving one is a re-host.
  3. Consume `job.posting@1` records and the events feed as a "company" data source.

## 5. Data model

### 5.1 Where data lives

The data directory is `~/Library/Application Support/job-seeker` on macOS, `%LOCALAPPDATA%\job-seeker` on Windows and `$XDG_DATA_HOME/job-seeker` on Linux, or wherever `JOB_SEEKER_HOME` points. job-seeker refuses to start if the directory is inside a git work tree, so private data cannot be committed by accident.

```text
<data dir>/
  jobseeker.db                 # SQLite (WAL), schema version in PRAGMA user_version
  config.json                  # settings, including the AI adapter's backend and switches
  sources/<source_id>.<ext>    # profile source documents and their extracted text
  resumes/<resume_id>/         # resume.tex, resume.pdf, resume.docx, why-me.md, build.log
  reports/<yyyy>/<mm>/<run_id>.json|.html   # one report per run
  reports/latest.html, reports/pipeline.html
  browser/profiles/<service>/  # one persistent profile per service, mode 0700
  browser/captures/            # page captures from failed parses (kept 14 days)
  tools/tectonic/              # the pinned Tectonic build
  run/wake                     # touched to wake the service
  backups/                     # database snapshot taken before each migration
  logs/                        # redacted, rotated
```

The Playwright Chromium build lives in Playwright's own cache, at the version job-seeker pins.

### 5.2 Entities

| Entity | Key fields | Notes |
|---|---|---|
| `profile_sources` | id, kind (`resume_pdf`, `resume_docx`, `resume_latex`, `resume_text`, `free_text`, `linkedin_profile`, `public_page`, `user_statement`), sha256, stored path, extracted text, imported_at | Immutable. Claims cite text spans in these |
| `profile_versions` | version, parent, document (`profile@1`), created_by (`user`, `assistant`, `ai_adapter`, `import`), note, created_at | Immutable. The highest version is current. A revert saves an old document as a new version |
| `criteria_sets` / `criteria_versions` | set id, name, status; version, body (`criteria@1`), change_id | Every version comes from an approved change |
| `criteria_changes` | id, kind (`create`, `modify`, `archive`), target, proposed body or patch, proposed_by (`user`, `assistant`, `ai_adapter`, `research:<run_id>`, `profile:<version>`), evidence refs, approval id, status (`proposed`, `approved`, `rejected`, `superseded`) | Append-only. Rejected proposals are kept |
| `approvals` | id, subject kind (`criteria_change`, `linkedin_profile_edit`), subject id, payload sha256, summary, status (`pending`, `approved`, `rejected`, `superseded`, `expired`), requested_by, requested_at, decided_by, channel (`chat`, `cli`, `mcp_elicitation`), user words, decided_at | **The one approval record** (section 9.1). An approval is bound to its payload's hash |
| `linkedin_profile_edits` | id, section (`headline`, `about`, `experience:<entry>`, `skills`), before (as read, with its source id), after, diff, grounding audit, approval id, status (`proposed`, `approved`, `applying`, `applied`, `verified`, `failed`, `superseded`, `rejected`), applied_at, verify source id | Section 7.5 |
| `jobs` | id, dedupe key, canonical URL, title, company, location, workplace, salary, seniority, description (guarded, untrusted), `partial`, first_seen, last_seen, status (`active`, `unreachable`, `expired`) | One row per real posting after dedupe |
| `job_sightings` | job id, connector, binding, external id, raw URL, run id, criteria set, record (`job.posting@1`), seen_at | Provenance: every source of every job |
| `job_features` | job id, skills, normalised title, certifications, salary figures | Small and kept after descriptions are pruned, so research evidence stays valid |
| `job_scores` | job id, profile version, criteria version, method (`rule`, `assistant`, `ai_review`), score 0-100, band, gate verdicts, dimension scores, reason, scored_at | Every method is kept. Section 8 says which one is shown |
| `research_runs` / `research_findings` / `research_notes` | run (profile version, window, inputs, created_at); finding (kind, subject, metrics, n, evidence refs); note (author, text, finding refs) | Dated, so findings can be compared over time. A synthesis from the AI adapter is a note |
| `templates` | id, name, output (`latex`, `docx`), path, sha256, page budget, licence | Synced from `templates/` in the repository |
| `resumes` | id, job id, template id and sha, profile version, content (items with claim IDs), audit result, PDF and .docx paths, "why me" note path, created_at | Each item traces to claims, and each claim to source spans |
| `applications` / `application_events` | job id, current state, resume id; event (from, to, at, reported_by, channel, note) | States: `found`, `shortlisted`, `resume_prepared`, `applied`, `interview`, `offer`, `rejected` |
| `schedules` | id, kind (`search`, `alerts`, `research`, `match_review`, `maintenance`), targets, schedule (interval, cron or manual), time zone, enabled, next_run_at | Survives restarts because it lives in the database |
| `runs` / `run_steps` | run (kind, trigger, status, lease, report id); step (connector, binding, criteria set, status, cursor, counts, redacted error) | Run statuses: `queued`, `running`, `waiting_for_human`, `succeeded`, `partial`, `failed`, `cancelled` |
| `connector_bindings` | id, connector id and version, settings, secret refs, health (`ok`, `degraded`, `needs_human`, `auth_expired`, `failing`, `disabled`) | One binding per connector and account |
| `browser_sessions` | service, profile dir, state, engine version, last probe, page loads per day and hour | Section 7 |
| `human_steps` | id, binding or session, run step, reason, detail, URL to open, opened_at, notified_at, window_opened_at, resolved_at, resolution | **The one needs-human signal** (section 7.3) |
| `ai_calls` | id, purpose, backend, model, input refs, prompt sha256, output, validation result, duration, status, at | Every model call, kept for audit |
| `events` | cursor, type, entity, payload, at | Section 4 |

### 5.3 Documents and evidence

The profile, criteria, reports and records are JSON documents. Each carries its own `schema` tag (`profile@1`, `criteria@1`, `report@1`, `job.posting@1`) and has an upgrade function. A profile claim must cite evidence:

```json
{
  "schema": "profile@1",
  "claims": [
    {
      "id": "clm_skill_pricing",
      "type": "skill",
      "value": "B2B pricing strategy",
      "evidence": [
        { "source_id": "src_resume_2026_11", "start": 1180, "end": 1251,
          "quote": "Led the pricing redesign for a B2B analytics product across 3 regions" }
      ]
    }
  ]
}
```

job-seeker rejects a version whose quotes do not match their source spans (whitespace is normalised). This applies whoever proposed the claims: the user, the assistant or the AI adapter. A fact the user states in conversation is first recorded as a `user_statement` source, and claims then cite it. The example person, product and figures are fictional.

### 5.4 Schema versions and migrations

1. `PRAGMA user_version` holds the schema version. Migrations are forward-only files, `store/migrations/NNNN_<name>.sql` or `.ts` for data moves, and each runs in a transaction.
2. Before migrating, job-seeker writes `VACUUM INTO backups/jobseeker-v<N>-<timestamp>.db`. It refuses to open a database newer than it understands and asks the user to upgrade.
3. Tests migrate an empty database to the latest version, and every stored fixture snapshot (one per released schema version) to the latest.
4. `job-seeker import-legacy` reads the predecessor's `state/seen_jobs.json`, `state/last_run.json` and `tracker.csv` and records what it imported. It is repeatable and idempotent until phase 8 of the execution plan: each run merges newly seen jobs and tracker rows and skips what it already imported. From phase 8 it stops accepting new imports.

### 5.5 Secrets

- **Storage.** API keys and OAuth tokens go in the OS keychain (macOS Keychain, Windows Credential Manager, the Linux Secret Service) through a maintained native binding. Where no keychain backend exists, they go in an encrypted file whose key file sits outside the data directory with mode 0600. That fallback protects against accidental copies and backups, not against someone using the same OS account, and setup says so.
- **Entry.** Secrets are entered only through the CLI (`job-seeker secrets set`, or `job-seeker connect gmail`, which runs the OAuth loopback flow in the system browser). They never pass through MCP, so the model never sees them. This includes an API key for the AI adapter.
- **Browser cookies** stay in the browser profile. Chromium encrypts them with the OS keychain where one exists (section 12.3).
- **Redaction.** Logs, reports and AI adapter inputs pass through a redactor that masks every stored secret value. Cookie and authorization headers are never logged.

## 6. Connector contract

### 6.1 Kinds

| | API connector | Browser connector |
|---|---|---|
| Talks to | A service API over HTTPS, or the mailbox through the `mailbox@1` contract | A site in a signed-in, persistent browser profile |
| Code | TypeScript module with `ctx.http` and `ctx.mailbox` | TypeScript module with `ctx.browser`, a guarded Playwright page |
| Sign-in | `api_key`, `oauth2` or `none` | `browser_session` |
| Hosted by | The connector host, in the engine process | The browser host, a Node child process |

### 6.2 Manifest

A connector's `connector.json` uses CC's manifest fields: `manifestVersion`, `id`, `name`, `version`, `kind`, `description`, `implements`, `auth`, `permissions`, `actions` (each with a risk class, schemas, idempotency and an optional rate limit), `syncs`, `records`, `settingsSchema`, `browser` (service, origins, login URL, signed-in probe, challenge signatures, `requiresHeaded`, pacing, `selectorsVersion`), `limits` and `flags` (`tos_risk`, `unofficial_surface`, `beta`). job-seeker's additions all sit under one key, `x-jobseeker`, so a CC port can move or drop them:

- `requires`: contracts the connector consumes, such as `mailbox@1`;
- `mail.senders`: the only senders an alert connector may read;
- `noFetchHosts`: portal hosts whose postings must never be fetched, because their terms forbid it;
- `market`: for example `us` or `in`;
- `manualOnly`: actions that may run only on a direct user request, never from a schedule (LinkedIn people search).

An action with risk `write_external` also declares `"confirmation": "approval"`. The host refuses to run it without an approved approval record whose payload hash matches the call.

```json
{
  "manifestVersion": 1,
  "id": "adzuna",
  "name": "Adzuna job search API",
  "version": "0.1.0",
  "kind": "api",
  "description": "Searches Adzuna's official API with a saved criteria set.",
  "implements": ["jobs.search@1", "market.stats@1"],
  "auth": { "method": "api_key", "inject": { "in": "query", "name": "app_key" },
            "instructions": "Register a free developer account, then run: job-seeker secrets set adzuna.app_key" },
  "permissions": { "network": { "hosts": ["api.adzuna.com"] },
                   "records": { "write": ["job.posting@1", "market.stat@1"] },
                   "secrets": { "custom": false } },
  "actions": [
    { "name": "search_jobs", "title": "Search jobs", "risk": "read", "idempotent": true,
      "confirmation": "policy", "rateLimit": { "perMinute": 20 },
      "inputSchema": { "$ref": "contracts/jobs.search@1#/input" },
      "outputSchema": { "$ref": "contracts/jobs.search@1#/output" } }
  ],
  "syncs": [],
  "records": ["job.posting@1", "market.stat@1"],
  "settingsSchema": { "type": "object", "required": ["app_id", "country"],
                      "properties": { "app_id": { "type": "string" }, "country": { "type": "string" } } },
  "limits": { "timeoutSeconds": 60, "maxMemoryMb": 256, "minSyncIntervalMinutes": 60 },
  "flags": [],
  "x-jobseeker": { "market": "us" }
}
```

### 6.3 Capability contracts

The engine calls contracts, never a specific connector.

| Contract | Members | Record | Used by |
|---|---|---|---|
| `jobs.search@1` | action `search_jobs({criteria, filters}) -> {records, unsupported, next}` | `job.posting@1` | Search runs (capability 4) |
| `jobs.recommended@1` | action `recommended_jobs({limit})` | `job.posting@1` | Search from the site's own profile-based recommendations |
| `jobs.alerts@1` | sync `alerts(cursor)` | `job.posting@1` | Alert ingest |
| `jobs.detail@1` | action `get_job({url or externalId})` | `job.posting@1` with its description | Detail fetch for top candidates |
| `profile.read@1` | action `read_own_profile()` | `profile.source@1` | Profile intake (capability 1), and the "before" of a profile edit |
| `profile.write@1` | action `apply_profile_edit({section, after, expectedBefore})`, risk `write_external` | `profile.edit_result@1` | LinkedIn profile edits (capability 8) |
| `market.stats@1` | action `market_stats({query, kind})` | `market.stat@1` | Research (capability 5) |
| `mailbox@1` | actions `list_messages({senders, since})` and `get_message(id)`, read-only | `mail.message@1` | Alert connectors, through `ctx.mailbox` |
| `tracker.export@1` | action `export_applications({since})` | none | Notion sync |

- **Records.** `job.posting@1` keeps CC's core fields (title, company, location, URL, source, posted time, and a description marked untrusted). It adds `workplace`, `salary {min, max, currency, period, predicted}`, `seniority`, `employment_type`, `apply_url`, `partial` and `employer_hidden`.
- **Criteria.** `search_jobs` receives the normalised criteria fields plus that connector's own `filters`, validated against the action's `inputSchema`. It returns the criteria fields it could not apply as `unsupported`, and the engine applies those after the search. Alert connectors take no query, because the user sets up alerts on the portal. Criteria sets filter and rank their results instead.

### 6.4 Runtime API

```ts
interface ConnectorContext {
  run: RunInfo;                 // run id, connector, version, binding, action or sync, deadline
  settings: Readonly<Record<string, unknown>>;  // validated against settingsSchema
  http?: ScopedHttp;            // API connectors: HTTPS only, hosts from permissions.network.hosts, auth injected by the host
  browser?: GuardedBrowser;     // browser connectors: ctx.browser.page(), a guarded Playwright page
  mailbox?: Mailbox;            // only with x-jobseeker.requires mailbox@1; read-only, limited to mail.senders
  state: KeyValue;              // per-binding cursor store, at most 64 KB
  clock: Clock;                 // injectable, for deterministic tests
  emit(record: ConnectorRecord): void;                           // validated against the record schema
  log(level: LogLevel, msg: string, fields?: object): void;      // redacted by the host
  needsHuman(reason: HumanReason, detail: string): never;
}
```

`needsHuman` reasons are `signed_out`, `challenge`, `two_factor`, `consent_screen`, `unexpected_page` and `auth_expired`. These match CC's set.

### 6.5 Rules

1. **No AI in connectors.** Connectors make no model calls and no judgement calls. A static check fails any connector that imports the AI adapter or an AI SDK, or names an AI provider host.
2. **Determinism.** The same fixture input, settings, cursor and clock give byte-identical output and records.
3. **Credentials stay with the host.** A connector never receives a raw secret. The host injects authentication into requests.
4. **Untrusted text.** Text from services passes `posting_guard` at ingest. MCP returns it wrapped as `{"untrusted_page_content": ...}`, and the AI adapter receives it only inside a marked untrusted block.
5. **Site rules.**
   - Postings are fetched only through the `web-posting` connector, which enforces robots.txt and skips every `noFetchHosts` entry.
   - API hosts follow their API terms and are not robots-gated.
   - Rate limits and pacing come from the manifest, and a binding may only tighten them.
6. **External writes need approval.** An action with risk `write_external` runs only with an approved, hash-matched approval record, and never from a schedule.
7. **The testing kit.** `job-seeker connector test <id>` runs offline and checks:
   - the manifest against its schema;
   - the static checks;
   - fixture tests for every action and sync;
   - determinism;
   - that a login-page fixture leads to `needsHuman`;
   - that every `write_external` action refuses to run without a matching approval;
   - fixture hygiene: no real names, emails, phone numbers, tokens or cookies.

### 6.6 Registry: adding a source

Each connector lives in `connectors/<id>/` with `connector.json`, its code (`index.ts`, plus `extractors.ts` for a browser connector), `fixtures/`, `tests/` and a `README.md` that says what it does and what it never does. The registry is `connectors/registry.json`: one entry per connector with id, version and enabled flag. **Adding a source means adding one directory and one registry line.** A test fails if a directory is unregistered, or if a registry entry has no directory.

### 6.7 The initial connectors

| id | Kind | Implements | Origin |
|---|---|---|---|
| `linkedin` | browser | `jobs.search@1`, `jobs.recommended@1`, `jobs.detail@1`, `jobs.alerts@1`, `profile.read@1`, `profile.write@1` | the vendored LinkedIn app (section 7.4) |
| `gmail` | api (oauth2, read-only scope) | `mailbox@1` | `tools/gmail_alerts.py` |
| `linkedin-alerts`, `indeed-alerts`, `ladders-alerts`, `employer-alerts` | api (mailbox) | `jobs.alerts@1` | `gmail_alerts.py` link extraction, `sources/registry.py`, `alert-sources.json` |
| `web-posting` | api (robots-gated GET) | `jobs.detail@1` | `tools/fetch_page.py`, `robots_check.py`, `page_decode.py` |
| `adzuna` | api (api_key) | `jobs.search@1`, `market.stats@1` | Adzuna API portal issue |
| `naukri-alerts`, `iimjobs-alerts`, `execthread-alerts`, `builtin-alerts` | api (mailbox) | `jobs.alerts@1` | The four alert-email portal issues. Each portal's host goes in `noFetchHosts` |
| `github-public` | api (none) | none: an action that reads public repositories, used by `profile_expand_scan` | `expand/tools/github_source.py` |
| `notion` | api (api_key) | `tracker.export@1` | `tools/notion_client.py`, `notion_sync.py` |

WhatsApp is not in v1. No other browser service is planned; the session model supports one if a job-search use appears.

## 7. Browser-session lifecycle

### 7.1 Mechanism

- **Profiles.** One Playwright persistent context per service (`launchPersistentContext(profileDir)`). Each service has its own profile directory, so sessions share no cookies or storage.
- **One build for both modes.** Headless runs and headed windows use the same full Chromium build (Playwright's `chromium` channel, so headless uses Chromium's new headless mode in that build) on the **same profile directory**.
- **One process per profile.** Chromium locks a profile to one process. Switching modes therefore closes one context cleanly, which flushes cookies, and launches the other.
- **Where windows come from.** Every process that executes runs lives in the user's login session: the service is a LaunchAgent limited to the user's graphical session, and the in-process fallback runs inside the MCP process, which the user's assistant started. Either one can open a visible window. A system-wide daemon could not, which is why there is none.

### 7.2 States

```mermaid
stateDiagram-v2
  [*] --> new
  new --> signing_in: user opens the session
  signing_in --> signed_in: signed-in probe passes
  signed_in --> running: a run step takes the session lease (headless)
  running --> signed_in: step done, context closed
  running --> needs_human: login wall, challenge, 2FA or unexpected page
  signed_in --> needs_human: health probe fails
  needs_human --> resolving: headed window opens on the same profile
  resolving --> signed_in: probe passes and no challenge remains
  resolving --> needs_human: window closed unresolved
  needs_human --> disabled: user disables the binding
  signed_in --> [*]: sign out deletes the profile
```

1. **Sign in.** `job-seeker sessions open linkedin`, or the MCP tool `session_open`, creates the profile and opens a headed window at the manifest's `loginUrl`. The user signs in by hand. The host checks the read-only `probeSignedIn` every few seconds. When it passes, the session is `signed_in` and the window closes.
2. **Run headless.** A run step takes the session's lease, and the host launches the profile headless.
   - Every page load goes through the session's pacer: one at a time, a random 3 to 7 second gap, at most 40 loads an hour, and the service's daily cap (200 for LinkedIn). Page loads are counted in the database, so the service and an in-process run share one budget. A cap hit fails fast with a retry time, and the rest of the step is deferred to the next run.
   - After each navigation, the host checks the manifest's challenge signatures, common CAPTCHA frames and login URLs.
3. **Human step.** On a match, or when the connector calls `ctx.needsHuman`:
   1. **Pause.** The host records the URL and closes the headless context. The step keeps a cursor so it can resume, and is marked `waiting_for_human`.
   2. **Record.** It sets the session to `needs_human` and writes a `human_steps` row.
   3. **Notify.** It sends an OS notification naming the site and the reason, and the MCP `status` tool shows the step.
   4. **Open.** The executing process (the service, or the MCP process when the service is down) reopens the same profile headed at that URL. The window is the user's to work in; job-seeker types nothing into it.
4. **Back to headless.** The user finishes the step in the headed window. Once the probe passes and no challenge signature remains, the host closes the window, sets the session to `signed_in` and resolves the human step. The waiting step then carries on headless in the same profile from its cursor. The user can also say so with `session_done` or `job-seeker sessions done linkedin`.
5. **Time-out.** A run started from MCP or the CLI waits up to 10 minutes. A scheduled run waits up to 12 hours, or until the same schedule's next run if that comes sooner. Then the step ends as `needs_human` and the run as `partial`, and the window closes. While the session stays `needs_human`, later runs skip that connector without loading a page and list it again under "Waiting for you". There is no retry loop against the site.
6. **Sign out** deletes the profile directory after the user confirms.

If the user is away or the screen is locked, the window and the notification are waiting when they return; nothing proceeds until they act.

### 7.3 One needs-human signal

`human_steps` is the only record of "waiting for you", for browser sessions and for everything else that needs a person: an expired OAuth token, a keychain that denies access, an AI adapter backend that is signed out, or a connector whose selectors broke. Every surface reads that table:

- the report's and the pipeline page's "Waiting for you" section;
- the MCP `status` tool and the `jobseeker://human-steps` resource;
- `job-seeker status`;
- the OS notification.

### 7.4 Guards and the LinkedIn connector

The browser host applies these guards to every run:

- navigation pinned to the manifest's origins;
- no input into password, OTP or 2FA fields;
- no cookie or storage export to connector code;
- no downloads or permission grants unless the manifest declares them;
- **no evasion**: no changes to `navigator.webdriver`, the user agent or the fingerprint.

job-seeker never solves a CAPTCHA, types a credential or answers a security check.

The `linkedin` connector reuses the vendored app's extractors, URL builders, pacing defaults, result cache, failed-parse captures and the "LinkedIn needs you" detection, ported to TypeScript. The app's Electron window and socket endpoint are replaced by the browser host; they stay in use by the predecessor's LinkedIn ingest until phase 8 of the execution plan. It uses the user's main account.

| Need | Action | Notes |
|---|---|---|
| Job search with saved criteria | `search_jobs` | Criteria map to LinkedIn's keyword box and its experience-level, workplace, date-posted and job-type filters. Pagination stops at the limit |
| Jobs LinkedIn recommends for the profile | `recommended_jobs` | Reads the signed-in account's recommended-jobs collection |
| Job details | `get_job` | Fetched only for the top candidates of a run, within the daily budget |
| The person's own profile | `read_own_profile` | New extractor. Stored as a `linkedin_profile` source for intake, and as the "before" of an edit |
| Job-alert results | `alerts` sync | Lists the account's alerts, then replays each alert's search. LinkedIn's alert emails remain a second route through `linkedin-alerts`, which needs no session |
| Own-profile edits | `apply_profile_edit` | Risk `write_external`. Section 7.5 |
| People search | `search_people` | Read-only and `manualOnly`: one MCP tool, `linkedin_search_people`, on a direct user request. A schedule that names it is refused |
| Save job | `save_job` | The app's write. Not exposed |

Messaging, connection requests and applying do not exist as actions.

**Budget.** At most 200 page loads a day (the user's local day) and 40 an hour, one at a time with a 3 to 7 second gap. A planner shared by all criteria sets and schedules spends the day's budget in this order: human-requested calls, profile reads and edits, alerts, saved searches, then details for top candidates. Whatever does not fit is deferred, and the report says so.

The binding is created only after the user accepts its `tos_risk` flag. Section 18 of the execution plan covers the LinkedIn risks.

### 7.5 LinkedIn profile edits

1. **Draft.** In chat, the assistant drafts an edit with the user and calls `linkedin_profile_propose({section, after})`. v1 supports the headline, the About section, the description of an existing experience entry, and adding or removing skills.
2. **Read and diff.** job-seeker reads the live section (`read_own_profile`), stores it as a source, and builds a diff of before and after. It checks LinkedIn's field length limits.
3. **Ground.** The deterministic grounding audit from resumes runs on the new text: numbers, dates, titles, employers and tools must appear in the current profile's claims or their evidence. A failure blocks the proposal and names the token. To add a new fact, the user first states it, and it is recorded as a `user_statement` source.
4. **Approve.** The proposal becomes a pending approval record showing the diff. The user approves it (section 9.1). An approval binds to the payload's hash, so any change to the text needs a new approval.
5. **Apply.** `linkedin_profile_apply({approval_id})` queues a run. Before writing, the connector reads the section again; if it no longer matches the diff's "before", the edit is `superseded` and the user is asked again. The edit runs in a **visible headed window**, at the same pace as reads, using LinkedIn's own edit form, so the user can watch it. At most 5 edits a day.
6. **Verify.** After saving, the connector reads the section again and compares it with the approved text. A match marks the edit `verified`. A mismatch, or an edit form that no longer matches the connector's selectors, stops the edit, opens a human step and leaves the approved text ready for the user to paste in the open window.

The diff tells the user that LinkedIn may share some profile changes with their network, depending on the user's own LinkedIn setting. job-seeker does not change that setting. A binding setting, `profileWrites: assisted`, turns step 5 into "open the edit form headed and show the approved text" so the user saves by hand; it is the fallback if automated edits prove risky.

## 8. Search, dedupe and ranking

1. **Collect.** Search steps run `jobs.search@1` for each selected connector and criteria set, and `jobs.recommended@1` where a criteria set asks for it. Alert steps run `jobs.alerts@1`. Every record is stored as a `job_sightings` row.
2. **Dedupe.** The ported `url_canon` and `job_key` code merges sightings into `jobs` by canonical URL, then by company and title. A job keeps every source.
3. **Guard and detail.** Descriptions pass `posting_guard`. For the top candidates by rule score, `jobs.detail@1` fills in descriptions. A job with no fetchable detail is scored from what its alert says and flagged `partial`.
4. **Rule score, always.** Gates come first, and any gate failure vetoes the job:
   - exclusions;
   - seniority, comparing title signals with the criteria;
   - location and workplace;
   - a salary floor, applied when the salary is known.

   Weighted dimensions follow (title, skills against profile evidence, domain, seniority and location), with weights per criteria set. This ports `rank_state`'s gates, bands and unreachable-retry rules.
5. **Judgement score, optional.**
   - **Assistant:** the MCP prompt `review_matches` asks the assistant to score the top matches on the rubric dimensions, and `rank_submit` stores them as method `assistant`.
   - **AI adapter:** when match review is switched on, a `match_review` step after a scheduled run sends the top matches to the adapter, and the same validation stores them as method `ai_review`.

   Both go through `rank_state`'s apply path: weights and vetoes apply, and a judgement score can never lift a job that a gate vetoed.
6. **What is shown.** The newest judgement score is shown when it was made for the current profile version and the job has not changed since. Otherwise the rule score is shown. Every list labels which one it is.

### 8.1 Searching from the LinkedIn profile

"Search with my LinkedIn profile" chains existing parts:

1. `profile_read_linkedin` reads the own profile and stores it as a source.
2. Profile intake turns it into claims, through the assistant in chat or the AI adapter, and the user saves a profile version.
3. `criteria_from_profile` derives a draft criteria set deterministically: target titles from the current and recent roles, the top evidenced skills as keywords, and the profile's location and workplace preferences. It is created as a pending approval.
4. Once approved, `search_run` runs it on LinkedIn (`search_jobs`) together with LinkedIn's own recommendations for the account (`recommended_jobs`), and ranks the results against the profile.

## 9. MCP surface

The MCP server is the TypeScript SDK's stdio server. Each tool is an adapter over one Engine API operation. Tool descriptions tell the assistant when to ask the user first.

| Capability | Tools | Resources and prompts |
|---|---|---|
| 1 Profile | `profile_import_source` (file path, or pasted text from an attachment), `profile_read_linkedin`, `profile_intake_run` (AI adapter), `profile_get`, `profile_save_version`, `profile_add_statement`, `profile_diff`, `profile_expand_scan` | `jobseeker://profile/current`, `jobseeker://profile/versions/{n}`, `jobseeker://profile/sources/{id}`; prompt `intake_profile` |
| 2, 3 Connectors and sessions | `connectors_list`, `connector_configure` (no secrets), `sessions_list`, `session_open`, `session_done`, `human_steps_list`, `linkedin_search_people` (manual only) | `jobseeker://connectors`, `jobseeker://human-steps` |
| 4 Search | `criteria_list`, `criteria_get`, `criteria_from_profile`, `search_run` (saved sets or one unsaved criteria body), `alerts_ingest`, `run_status`, `jobs_list`, `job_get`, `jobs_search`, `rank_submit`, `match_review_run` (AI adapter) | `jobseeker://criteria/{id}`, `jobseeker://jobs/{id}`; prompt `review_matches` |
| 5, 6 Research and criteria | `research_run`, `research_get`, `research_list`, `research_compare`, `research_annotate`, `research_synthesize` (AI adapter), `criteria_propose` | `jobseeker://research/latest`; prompt `review_research` |
| Approvals | `approvals_list`, `approval_get`, `approval_decide` | `jobseeker://approvals/pending` |
| 7 Resumes | `templates_list`, `resume_prepare`, `resume_tailor` (AI adapter), `resume_render` (PDF or .docx), `resume_get`, `resumes_list`, `why_me_prepare` | `jobseeker://templates`; prompt `tailor_resume` |
| 8 LinkedIn profile | `linkedin_profile_get`, `linkedin_profile_propose`, `linkedin_profile_apply`, `linkedin_profile_edits_list` | prompt `edit_linkedin_profile` |
| 9 Schedules and reports | `schedules_list`, `schedule_set`, `schedule_delete`, `reports_list`, `report_get`, `pipeline_page` | `jobseeker://reports/latest`, `jobseeker://reports/{id}` |
| 11 Applications | `application_prepare` (job details, apply URL, resume paths, "why me" note), `application_set_state`, `applications_list`, `application_get`, `notion_sync` | prompt `apply_to_job` |
| All | `status`: service state, next runs, waiting human steps, pending approvals, failing connectors, AI adapter state | |

### 9.1 Approvals

Criteria changes and LinkedIn profile edits are created as pending approval records. Nothing they describe happens until the record is approved. A record can be decided through three channels, which all write the same record:

1. **Chat.** The user says yes in the conversation, and the assistant calls `approval_decide({id, decision, user_words})`. The tool description tells the assistant to call it only after the user's explicit answer to that specific approval, and to pass the user's own words. Channel `chat`.
2. **MCP elicitation.** Where the client supports elicitation, `approval_decide` (and a proposing tool, when asked to) first asks the user directly with the diff, and the user's answer decides. Channel `mcp_elicitation`.
3. **CLI.** `job-seeker approvals list|show|approve|reject <id>`. Channel `cli`.

Rules:

- An approval binds to the sha256 of its payload. Changing the payload supersedes the record.
- A pending record expires after 14 days. Rejected and expired records are kept.
- A record whose target changed first (a newer criteria version, or a profile section that no longer matches its "before") is superseded.
- The AI adapter can create proposals but can never decide one.
- The pipeline page, reports and `status` list pending approvals.

**The whole flow from Claude Desktop or Codex.** `session_open` (LinkedIn sign-in), `profile_read_linkedin`, `profile_save_version`, `criteria_from_profile`, `approval_decide`, `search_run`, `jobs_list`, `linkedin_profile_propose`, `approval_decide`, `linkedin_profile_apply`, then `research_run`, `criteria_propose`, `schedule_set`, `resume_prepare`, `resume_render`, `application_prepare` and `application_set_state`.

**Compatibility.** The predecessor's Python MCP server keeps working under its own configuration until the port retires it (execution plan, section 4). From phase 8 it is trimmed to the tools not yet replaced (`tailor` and `upskill_report`), and it is removed once phases 9 and 10 have both shipped. The new server uses the new tool names only.

## 10. Scheduler, reports and the pipeline page

### 10.1 Scheduler

- **Schedules.**
  - Kinds: `{kind: interval, minutes}`, `{kind: cron, expr, timeZone}` (five-field) and `{kind: manual}`. Time zones are IANA names.
  - A schedule can never fire more often than any target connector's `minSyncIntervalMinutes`.
  - A schedule can never include a `manualOnly` action or a `write_external` action.
- **Defaults created by `job-seeker setup`:**
  - alert ingest every 4 hours;
  - saved-criteria search daily at 07:00;
  - match review after each scheduled search, when the AI adapter's match review is on;
  - research weekly on Monday;
  - maintenance weekly.
- **Firing.**
  - The service checks due schedules every 30 seconds and adds plus or minus 10 percent jitter.
  - After sleep, log-out or downtime it runs a missed schedule once, not once per missed slot. The service runs only while the user is logged in, which is the price of being able to open windows.
  - Each schedule has at most one active run.
- **Runs.** A run is a list of steps, one per connector, binding and criteria set. The steps run independently: a LinkedIn human step does not hold up Adzuna.
- **Retries.** Retries apply only to idempotent actions, after network errors, HTTP 429 or 5xx, with backoff at 1, 5 and 25 minutes. A binding that fails 3 runs in a row becomes `failing` and opens a human step.

### 10.2 Report format

Every run writes `reports/<yyyy>/<mm>/<run_id>.json` (`report@1`) and a matching `.html` page. The HTML is self-contained, works offline and escapes all untrusted text. Each run also refreshes `reports/latest.html` and the pipeline page. `job-seeker report open` opens the latest report without any assistant.

```json
{
  "schema": "report@1",
  "run": { "id": "run_01JD3Q", "kind": "search", "trigger": "schedule", "schedule_id": "sch_daily_search",
           "started_at": "2026-12-01T07:00:04Z", "finished_at": "2026-12-01T07:09:41Z", "status": "partial" },
  "profile_version": 7,
  "criteria": [ { "id": "crs_product_remote", "name": "Product leadership, remote", "version": 3 } ],
  "summary": { "new_jobs": 12, "merged_duplicates": 9, "connectors_failed": 0, "waiting_for_you": 1, "pending_approvals": 2 },
  "new_jobs": [ { "job_id": "job_8f2c", "title": "Director of Product", "company": "Acme Analytics (fictional)",
                  "sources": ["adzuna", "linkedin-alerts"], "score": 78, "score_method": "rule" } ],
  "top_matches": [ { "job_id": "job_8f2c", "score": 78, "score_method": "rule", "band": "Strong Fit",
                     "flags": ["seniority:FLAG"], "sources": ["adzuna", "linkedin-alerts"], "partial": false } ],
  "changes_since_last_run": { "previous_run_id": "run_01JCZ1", "new": 12, "rescored": 3, "expired": 4,
                              "application_changes": [], "criteria_changes": ["chg_0042 approved"] },
  "connectors": [ { "connector": "adzuna", "status": "ok", "records": 31 },
                  { "connector": "linkedin", "status": "needs_human", "records": 0, "detail": "challenge",
                    "page_loads_today": 112, "page_load_cap": 200 } ],
  "waiting_for_you": [ { "human_step_id": "hs_0007", "service": "linkedin", "reason": "challenge",
                         "since": "2026-12-01T07:03:12Z", "how": "job-seeker sessions open linkedin" } ],
  "pending_approvals": [ { "approval_id": "apr_0043", "kind": "criteria_change", "summary": "Add the title 'Group Product Manager'", "requested_by": "research:res_0011" } ]
}
```

"Changes since the last run" compares with the previous finished run of the same schedule, or for an on-demand run, the previous run of the same kind and criteria sets.

### 10.3 The pipeline page

`reports/pipeline.html` is a read-only, self-contained page built from the existing offline dashboard (`dashboard/build.py`, ported). It shows applications by state, the current top matches with their score method and sources, follow-ups that are due, "Waiting for you" and pending approvals. It has no server and no write actions; it is regenerated after every run and on demand by `job-seeker pipeline open` or the MCP tool `pipeline_page`, which returns its path and a short summary.

## 11. How the existing code maps onto the new structure

Paths are relative to the repository root. **Port** means rewrite in TypeScript with the same behaviour, using the existing tests as the spec. **Reshape** means port the logic behind a new interface. **Retire** means remove, for the reason given. The execution plan's section 4 gives the order.

| Existing | Verdict | Becomes |
|---|---|---|
| `tools/job_key.py`, `tools/url_canon.py` | Port | `core/dedupe`: job identity and URL canonicalisation |
| `tools/alert_state.py` | Reshape | `core/jobs` ingest: candidate selection and store, on SQLite instead of `seen_jobs.json` |
| `tools/rank_state.py` | Reshape | `core/ranking`: gates, weights, bands, sweep, unreachable-retry, and the judgement-score apply path |
| `tools/config.py`, `config.example.json` | Reshape | Settings and connector bindings. `state_lock` gives way to transactions and run leases |
| `sources/registry.py`, `alert-sources.json` | Reshape | `connectors/registry.json`. Senders and host patterns move into each alert connector's manifest |
| `tools/gmail_alerts.py` | Reshape | The `gmail` connector (`mailbox@1`) and the four existing alert connectors |
| `tools/christiantechjobs_alerts.py` | Reshape | The `christiantechjobs` connector (`jobs.alerts@1`): a public RSS feed, no mailbox, no auth. Ported in Phase 8, "the other connectors" |
| `tools/fetch_page.py`, `robots_check.py`, `page_decode.py` | Port | The `web-posting` connector |
| `tools/posting_guard.py` and its copy in `tailor/tools/` | Port one | `core/guard`. The copy is removed |
| `tools/notion_client.py`, `notion_sync.py`, `NOTION_SETUP.md` | Port | The `notion` connector (`tracker.export@1`) and the `notion_sync` tool. The setup guide is updated for the new commands |
| `tools/upskill_state.py`, `upskill/upskill.md`, `upskill/README.md` | Reshape | Research `skill_gap` findings and the heatmap section of the research report. The learning-plan prose moves to the `review_research` prompt and the research synthesis |
| `expand/tools/*`, `expand/expand.md` | Reshape | `profile_expand_scan` stores public pages as profile sources, and the `github-public` connector. The command becomes part of the `intake_profile` prompt |
| `tailor/tools/grounding_audit.py`, `ats_keywords.py` | Port | `resume/` audit, now checking each item against the claims it cites, also used for LinkedIn profile edits; and keyword coverage for `resume_prepare` |
| `tailor/tools/render_latex.py`, `compile_latex.py`, `verify_pdf.py`, `verify_layout.py`, `latex_pipeline.py` | Port | `resume/` render, compile (Tectonic) and verify loop |
| `tailor/tools/latex_templates/resume.tex.tmpl` | Reshape | The first template in `templates/` |
| `tailor/tools/latex_templates/cover.*` | Reshape | The "why me" note's template |
| `tailor/tools/export_resume.py` (pandoc and .docx route) | Port | The `.docx` output of `resume_render`, when pandoc is present |
| `tailor/tailor.md`, `tailor/agents/resume-reviewer.md` | Reshape | MCP prompt `tailor_resume`, which includes the reviewer's checks, and the adapter's tailoring instructions |
| `linkedin/app/src/extractors.js`, `urls.js`, `pacing.js`, `cache.js`, `format.js`, `capture.js` and their tests | Port | The `linkedin` connector and the browser host's pacer, in TypeScript |
| `linkedin/app/src/main.js`, `server.js`, `paths.js`, `bin/linkedin-mcp.js` | Retire | Replaced by the browser host's persistent contexts and the one MCP server. The "needs you" logic moves across |
| `linkedin/client.py`, `linkedin/source.py` | Reshape | The connector's criteria-driven search; the browser host replaces the client |
| `mcp/server.py` | Retire | Replaced by the TypeScript SDK server. Its tests become the protocol error-path spec |
| `mcp/tools.py` | Reshape | Each old tool maps to a new tool over the Engine API (execution plan, section 4) |
| `dashboard/build.py` | Reshape | The pipeline page and the per-run report pages |
| `profile/candidate-profile.example.md`, and the user's gitignored filled copy `profile/candidate-profile.md` | Reshape | The template becomes intake guidance. The filled copy is an import source for the first profile version |
| `profile/job-evaluation.example.md` and its gitignored filled copy | Reshape | The rule ranker's gates and weights per criteria set, plus the `review_matches` prompt and the adapter's match-review instructions |
| `profile/writing-style.example.md` and its gitignored filled copy | Reshape | The profile's `preferences.writing`, passed by `resume_prepare` |
| `tracker.schema.csv`, `state/`, `applications/` | Reshape | The `applications` tables, plus CSV export and the one-time legacy import |
| `tests/` and each module's fixtures | Port | Rewritten as Vitest suites next to their modules. Fixtures move unchanged and stay fictional |
| `.github/workflows/jobseek-tests.yml` | Reshape | Node CI on Linux, macOS and Windows. The Python jobs stay until the last Python module is retired |
| `NOTICE` | Keep | MIT attribution for the derived files |
| `CLAUDE.md` trust rules | Keep | Engine invariants, and the rules in section 6.5. Rule 3 is updated when LinkedIn profile edits land |
| `.claude/commands/run-alerts.md`, `.claude/commands/notion-sync.md`, `.claude/agents/posting-scorer.md` | Retire | Replaced by scheduled runs, `search_run`, `notion_sync`, `web-posting` and the `review_matches` prompt, which carries the posting scorer's gates and rubric |
| The README's "Current code (migrated from jobseek)" section | Reshape | Replaced phase by phase with the new engine's install and usage notes |

## 12. Open questions, answered

### 12.1 Background running

**Decision:** a per-user background service (`job-seeker service`), installed by `job-seeker setup` as a macOS LaunchAgent limited to the user's graphical login session, with `RunAtLoad` and `KeepAlive`. Linux (a systemd user unit in the graphical session) and Windows (a Task Scheduler task that starts at log-on) follow the same rule later.

**Why.**

- It runs in the user's session, which is what opening a headed browser window, showing notifications, reading the user's keychain and running the user's assistant CLI all need. A system-wide service can do none of them.
- `KeepAlive` restarts it after a crash; a plain login item cannot.
- An app with its own UI would duplicate what the assistant, the pipeline page and reports already provide.

**How it works with a browser that has to be open.** Most runs are headless and need no window. When a site needs a person, the service itself opens the headed window on that site's profile, as section 7.2 describes, because it lives in the session where the user is. The user does the step and the run resumes headless. When the service is down, the MCP process runs the work in-process, also in the user's session, so the same hand-off works.

**When no assistant is connected,** a "waiting for you" step reaches the user through the OS notification, the opened window, the pipeline page and the report. `job-seeker status` lists it. If the service is not installed, `status` says so, and runs started from MCP or the CLI still execute in-process.

### 12.2 Notifications

**Decision:**

- **Report entry, always.** It is the durable record.
- **OS notification for events that need action:** a human step, a pending approval, and a connector that has started failing. Optionally, one daily digest of new top matches.
- **No email and no WhatsApp in v1.** Sending email would need either Gmail's send scope, which breaks the read-only Gmail rule, or a new SMTP secret.

Notifications use `osascript` on macOS (later `notify-send` on Linux and a PowerShell toast on Windows). Each notification names the command to run. If notifications are unavailable, the report entry and `status` still show everything.

### 12.3 Browser engine

**Decision:** Playwright persistent contexts on the full Chromium build, one profile directory per service, with the same build and the same profile for headless and headed runs (section 7.1).

**Why.**

- One build in both modes keeps the browser identical between the user's sign-in and later headless runs, which gives the most durable sessions.
- Persistent contexts are documented Playwright API.
- The existing extractor pattern ports directly.
- It matches the browser model of CC's connector design, so connectors stay portable.

**Durability details.**

- **Cookie encryption.** Ask Chromium to encrypt cookies with the OS keychain where one exists. Playwright's default launch flags select a mock keychain on macOS and a basic password store on Linux. The LinkedIn spike verifies this and records the flags used.
- **Clean shutdown.** Always close contexts cleanly, so cookies reach the disk.
- **After an upgrade.** Re-probe every session after a Playwright or Chromium upgrade.
- **Sites that refuse headless.** Let a site's manifest set `requiresHeaded`, which runs it in a headed window instead. Never mask automation.

### 12.4 Ranking

**Decision: a mix with a fixed split** (section 8).

- **Rule-based ranking always runs.** It covers the gates and the weighted dimensions, so unattended runs and reports rank on their own.
- **The user's assistant adds judgement scores** through the `review_matches` prompt and `rank_submit`.
- **The AI adapter can review the top matches after a scheduled run,** when that call site is switched on. Its scores are validated the same way and labelled `ai_review`.

### 12.5 Data growth

| Data | Kept | Limit |
|---|---|---|
| Job identity (dedupe key, URL, title, company, scores, sources) and `job_features` | For the life of the installation, so old postings never come back as new | Small: about 1 KB per job |
| Full descriptions and raw records | 180 days, then pruned. Jobs linked to an application, resume or research evidence keep theirs | |
| Run reports | 180 days, and the last 50 always | |
| Resumes, profile versions, criteria changes, approvals, LinkedIn profile edits, research runs | Kept until the user deletes them | |
| `ai_calls` | 180 days; the ones a kept record cites are kept with it | |
| Page captures | 14 days | 200 MB |
| Browser profiles | Indefinitely. Weekly maintenance clears Chromium's caches (HTTP cache, code cache, GPU cache, service-worker cache) but never cookies or site storage | Warn at 1 GB per profile |
| Whole data directory | | Warn at 2 GB. `job-seeker gc` prunes on demand, and the weekly maintenance run prunes and vacuums |

**Why.** Dedupe needs a permanent identity, which is cheap. Bulk text is what grows. At 50 jobs a day, descriptions add about 0.5 MB a day, so 180 days stays under 100 MB. Clearing only caches keeps sign-ins intact.

### 12.6 Install

1. `npm install -g` the job-seeker package. Node.js 22 or later is the only prerequisite.
2. `job-seeker setup`, which is idempotent and asks before each step:
   - creates the data directory and `config.json`, and refuses one inside a git work tree;
   - downloads Playwright's pinned Chromium build;
   - downloads the pinned Tectonic build and checks its checksum;
   - installs and starts the LaunchAgent;
   - adds the `job-seeker mcp` server to Claude Desktop's configuration and to Codex's, showing the change and keeping a backup of each file;
   - chooses the AI adapter's backend, or leaves it off;
   - creates the default schedules;
   - reports whether pandoc is present, for the optional .docx output.
3. `job-seeker setup --check` (also `job-seeker doctor`) reports each part's state and what is missing.

## 13. The AI adapter

**Interface.** One module, `ai/`, with one call:

```ts
run({ purpose, instructions, trusted, untrusted, outputSchema }) -> { output, meta }
```

`untrusted` carries posting and page text inside a marked block. `output` must validate against `outputSchema`; one retry is allowed, then the call fails and the caller falls back to its deterministic path.

**Backends,** set in `config.json`:

| Backend | How it runs | Notes |
|---|---|---|
| `claude-code` | One non-interactive Claude Code call with JSON output | Uses the user's own sign-in. Run with no tools and no MCP servers, so it cannot read files or call job-seeker back |
| `codex` | One non-interactive Codex call in a read-only sandbox | Uses the user's own sign-in, with the same limits |
| `anthropic-api` | The Messages API with the key from the keychain | The model ID is a setting |
| `off` | No calls | The default until the user chooses |
| `fake` | Canned outputs from fixtures | Tests only |

**The five call sites.** Each has its own switch, `ai.uses.<name>`, and nothing else may import the adapter; a lint rule and a test enforce the list.

| Call site | Input | Output and the deterministic check |
|---|---|---|
| `profile_intake` | Extracted resume or LinkedIn profile text | Claims with evidence spans. Quote validation (section 5.3) rejects any claim whose quote is not in its source |
| `match_review` | Top matches after a scheduled run, the profile and the rubric | Dimension scores and reasons. `rank_submit`'s validation; gates still veto |
| `resume_tailoring` | The job, the profile's claims, the template's slots | Items that cite claim IDs. The grounding audit rejects invented numbers, titles, dates and tools |
| `research_synthesis` | A research run's findings | A note that cites finding IDs. Every cited ID must resolve |
| `criteria_proposals` | Research findings and the current criteria | Proposals with evidence refs, created as pending approvals. Never decided by the adapter |

**Limits and audit.** A per-run and a per-day call cap, set in config. Every call is an `ai_calls` row. A backend that is signed out or failing opens a human step, and the call site falls back to its deterministic path: rule scores only, no synthesis, no proposals, and intake or tailoring left to the user's assistant in chat.

**Connectors never call it** (section 6.5).

## 14. Non-goals

- Multi-user features of any kind.
- A chat UI, cover letters beyond the "why me" note, email writing, or filling in application forms.
- LinkedIn messaging, connection requests, applying, or editing anything but the user's own profile.
- Scheduled LinkedIn people search.
- WhatsApp in v1.
- A network MCP transport, for now.
- Solving or bypassing CAPTCHAs and security checks, or masking automation.
- The Command Center integration itself. Section 4 only keeps it possible.
