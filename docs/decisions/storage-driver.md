# Storage driver: Node's built-in `node:sqlite`

- **Status:** decided
- **Phase:** 1
- **Date:** 2026-11-24

## Context

The engine keeps its state in one SQLite database (design 3.1, 5.4). The
execution plan (section 6) asks for a choice between Node's built-in
`node:sqlite` and `better-sqlite3`, made by checking three things on every
platform the release runs on (Linux, macOS and Windows, the CI matrix of
section 2):

- **WAL mode** - the service and an MCP process share the database (design 3,
  Concurrency);
- **`VACUUM INTO`** - the backup taken before each migration (design 5.4);
- **install** - nothing to compile on the user's machine, since a native
  module that fails to build breaks `npm install -g` (risk "Native modules",
  section 18).

## Decision

Use `node:sqlite` (`DatabaseSync`). The checks are executable and run in CI
on all three platforms, in `src/store/store.test.ts`:

- WAL: a freshly opened database reports `journal_mode` `wal`;
- `VACUUM INTO`: a migration over an existing database writes
  `backups/jobseeker-v<N>-<timestamp>.db`, and the backup opens with the old
  schema and its rows;
- install: there is nothing to install; the module ships with Node.js. The
  concurrent-writer test (`test/integration/concurrent-ingest.test.ts`) runs
  two processes against one database with `busy_timeout` set.

Consequences for the package:

- The minimum Node.js is **22.13**, the first 22.x release where `node:sqlite`
  works without a flag. `package.json` `engines` and `setup --check` say so.
- `node:sqlite` still prints an `ExperimentalWarning` when loaded. The CLI
  filters that one warning (`src/warnings.ts`) before the module is first
  loaded, which `src/store/db.ts` does lazily, so it never reaches an MCP
  client's log. Every other warning still prints.
- The API is synchronous, which suits short write transactions. Nested
  writes become savepoints (`transaction()` in `src/store/db.ts`).

## Alternatives considered

- **`better-sqlite3`** - mature, fast and synchronous too, with WAL and
  `VACUUM INTO`. It lost on install: it is a native module, so every Node.js
  release and platform depends on its prebuilt binaries being published, and
  falls back to a node-gyp build (a C++ toolchain) when they are not. A
  built-in module removes that failure mode entirely. It stays the fallback
  named in design 3.1 should `node:sqlite` regress.
- **An async driver (`sqlite3`)** - native as well, and its callback API
  adds nothing for a single-user engine with short transactions.

## Consequences

- Easier: `npm install -g` has no native step for storage; tests open real
  databases in temporary directories in milliseconds.
- Harder: `node:sqlite` is still marked experimental (stability 1.1 in Node
  22), so its API may change in a minor Node release. The store touches it
  in one module (`src/store/db.ts`), behind `DatabaseSync`'s small surface
  (`exec`, `prepare`, `get`, `all`, `run`).
- Revisit if a supported Node.js release changes or removes the API, if WAL
  or `VACUUM INTO` fails on a platform in CI, or if the experimental warning
  can no longer be filtered.
