/**
 * The SQLite store (design 5.4): one database in WAL mode, schema version in
 * PRAGMA user_version, forward-only migrations that each run in a
 * transaction, a `VACUUM INTO` backup before migrating an existing
 * database, and refusal of a database newer than this build understands.
 *
 * The driver is Node's built-in `node:sqlite` (docs/decisions/storage-driver.md).
 * It is loaded lazily so the CLI can silence its experimental-feature
 * warning before the module is first touched.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "../util/clock.js";
import { assertOutsideGit } from "./dataDir.js";
import { sql as m0001 } from "./migrations/0001_initial.js";

export type Database = DatabaseSync;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: "initial", sql: m0001 }];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export const DB_FILE = "jobseeker.db";

export class NewerDatabaseError extends Error {
  override name = "NewerDatabaseError";
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `This job-seeker database is at schema version ${found}, newer than this build understands ` +
        `(version ${supported}). Upgrade job-seeker (npm install -g job-seeker@latest) and try again; ` +
        "the database was left untouched.",
    );
  }
}

const require = createRequire(import.meta.url);

function sqliteModule(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

export function schemaVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

function stamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export interface OpenOptions {
  dataDir: string;
  clock: Clock;
  /** Skip migration: used to inspect a database without changing it. */
  readOnly?: boolean;
}

export interface OpenResult {
  db: Database;
  path: string;
  /** Schema version before this open (0 for a new database). */
  previousVersion: number;
  backupPath: string | null;
}

const depth = new WeakMap<Database, number>();

/**
 * Run `fn` inside BEGIN IMMEDIATE ... COMMIT, rolling back on any error.
 * Nested calls become savepoints, so a core function that writes in its
 * own transaction can also run inside a caller's.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const savepoint = `sp_${level}`;
  db.exec(level === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    db.exec(level === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    try {
      db.exec(level === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    } catch {
      // the transaction may already have been rolled back
    }
    throw error;
  } finally {
    depth.set(db, level);
  }
}

/** Apply every pending migration, after a backup when the database already had data. */
export function migrate(
  db: Database,
  options: { dataDir: string; clock: Clock },
  migrations: readonly Migration[] = MIGRATIONS,
): { previousVersion: number; backupPath: string | null } {
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  const previousVersion = schemaVersion(db);
  if (previousVersion > latest) {
    throw new NewerDatabaseError(previousVersion, latest);
  }
  if (previousVersion === latest) return { previousVersion, backupPath: null };

  let backupPath: string | null = null;
  if (previousVersion > 0) {
    const dir = join(options.dataDir, "backups");
    mkdirSync(dir, { recursive: true });
    backupPath = join(dir, `jobseeker-v${previousVersion}-${stamp(options.clock.now())}.db`);
    db.prepare("VACUUM INTO ?").run(backupPath);
  }
  for (const migration of migrations) {
    transaction(db, () => {
      // Re-read inside the write lock: another process may have migrated first.
      const current = schemaVersion(db);
      if (current >= migration.version) return;
      if (current !== migration.version - 1) {
        throw new Error(`cannot apply migration ${migration.version} to a database at version ${current}`);
      }
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
  return { previousVersion, backupPath };
}

export function openDatabase(options: OpenOptions): OpenResult {
  assertOutsideGit(options.dataDir);
  mkdirSync(options.dataDir, { recursive: true });
  const path = join(options.dataDir, DB_FILE);
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    if (options.readOnly) {
      const version = schemaVersion(db);
      if (version > LATEST_SCHEMA_VERSION) throw new NewerDatabaseError(version, LATEST_SCHEMA_VERSION);
      return { db, path, previousVersion: version, backupPath: null };
    }
    const { previousVersion, backupPath } = migrate(db, options);
    return { db, path, previousVersion, backupPath };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** An in-memory or file database without the data-directory rules, for tests. */
export function openRaw(path: string): Database {
  const { DatabaseSync } = sqliteModule();
  return new DatabaseSync(path);
}
