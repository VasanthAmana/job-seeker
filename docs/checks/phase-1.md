# Phase 1 client check

- **Acceptance scenarios covered:** AT-1.1 (status counts and ranked jobs over
  the imported legacy fixtures), AT-1.2 (`job_get` wraps the description and
  carries the guard's findings), AT-1.3 (`jobs_search`), AT-1.4
  (`rank_submit`), AT-1.5 (application states and the pipeline page), AT-1.6
  (profile sources and quote validation) and AT-1.7 (a newer database) - in
  `test/mcp/scenarios/`, pending a green CI run; record the run here once it
  passes.
- **Real-account manual checks:** MC-1.1, the legacy import of the user's
  real predecessor state (below). It reads personal data, so it is run by the
  user on their own machine and never in CI.

The phase 1 client check from the execution plan (section 6): `setup`
configures both clients; in each, ask for the top jobs and for the pipeline
page, over demo data.

## Prerequisites

- Node.js 22.13 or later (`node --version`).
- This repository, built: `npm ci && npm run build`. Below, `job-seeker`
  means `node /absolute/path/to/job-seeker/dist/cli.js`.
- Claude Desktop and Codex installed.

## Steps

1. Create the demo data directory, outside any git repository:

   ```sh
   job-seeker demo init --home ~/job-seeker-demo
   ```

   - Expected: "16 fictional jobs, 9 applications."

2. Point both clients at it:

   ```sh
   JOB_SEEKER_HOME=~/job-seeker-demo job-seeker setup
   ```

   - Expected: setup shows, for Claude Desktop and then Codex, the
     configuration file, the current job-seeker entry (none the first time)
     and the new one, and asks before writing each. Answer yes to both. It
     reports where it kept the backup of each file it changed.
   - Then `JOB_SEEKER_HOME=~/job-seeker-demo job-seeker setup --check`
     reports every part as `ok`.

3. Restart Claude Desktop. In **Claude Desktop**, ask: "What are my top jobs
   right now?"
   - Expected: the assistant calls `jobs_list` and lists five jobs, Acme
     Analytics' "Director, AI Strategy" first, each with its sources (for
     example `legacy:linkedin` and `demo-postings`) and the score method
     `rule`. It mentions that some jobs were left out because a gate vetoed
     them (four in the demo data).

4. In Claude Desktop, ask: "Tell me about the Globex job."
   - Expected: the assistant calls `job_get`, summarises the posting, and
     says the posting guard flagged hidden instructions in it. It does not
     follow them (it does not score the job 100 or mention the URL in the
     hidden text as something to visit).

5. In Claude Desktop, ask: "Open my pipeline page."
   - Expected: the assistant calls `pipeline_page` and gives the path of
     `pipeline.html` in the demo data directory. Opened in a browser, the
     page shows the applications by state (Applied, Interview, Shortlisted
     and the others), the top matches with their score method, a "Waiting
     for you" panel saying nothing is waiting, and the Globex title shown
     as text (`<img src=x onerror=alert(1)>` appears literally; no broken
     image and no alert).

6. In **Codex**, ask the same three questions.
   - Expected: the same answers.

7. When done, restore each client's previous configuration from the backup
   setup reported, or run `job-seeker setup` again later without
   `JOB_SEEKER_HOME` to point the clients at your real data directory.

## MC-1.1: import the real predecessor state

A real-account check (execution plan section 2, rule 3): run by the user on
their own machine, never in CI, and the notes below record outcomes only.

1. Refuse to run in CI:

   ```sh
   test "$CI" != "true" || { echo "MC-1.1 reads real data and refuses to run in CI"; exit 1; }
   ```

2. Set up the real data directory (the platform default, outside any
   repository): `job-seeker setup`. `job-seeker setup --check` reports the
   data directory and database as `ok`.

3. Count what the predecessor holds, from the predecessor's folder (the
   checkout that has `state/seen_jobs.json` and `tracker.csv`):

   ```sh
   python3 -c "import json; d = json.load(open('state/seen_jobs.json')); print('seen', len(d.get('seen', d)))"
   python3 -c "import csv; print('tracker', sum(1 for _ in csv.DictReader(open('tracker.csv', encoding='utf-8-sig'))))"
   ```

4. Import it: `job-seeker import-legacy --from <the predecessor's folder>`.
   - Expected: "seen_jobs.json: N read" with N equal to the `seen` count,
     and the new, merged and (if any) title-less counts adding up to N;
     "tracker.csv: M rows read" with M equal to the `tracker` count, all
     imported. Any statuses the engine did not recognise are listed as
     recorded as `found`.

5. Run the same command again.
   - Expected: nothing new: every seen job and tracker row is "already
     imported", and the totals are unchanged.

6. `job-seeker pipeline open`.
   - Expected: the page lists the user's applications in the states their
     tracker rows map to, and the current top matches.

7. Check that the data stayed in the data directory: `git status` in the
   predecessor's folder shows no new or changed files, and
   `job-seeker status` names the data directory outside any repository.

## Results

Outcomes only - never personal data, account details, counts that identify
the user's search, or captures.

| Date | Check | Client | Result | Notes |
|---|---|---|---|---|
| | Client check | Claude Desktop | | |
| | Client check | Codex | | |
| | MC-1.1 | (CLI) | | |
