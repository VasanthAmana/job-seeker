/**
 * The store (design 5.4, execution plan section 2 rule 5): migrations from
 * empty and from every released schema snapshot, the backup before
 * migrating, refusal of a newer database, refusal of a data directory
 * inside a git work tree, and WAL mode.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "../util/clock.js";
import { assertOutsideGit, DataDirError, defaultDataDir, resolveDataDir } from "./dataDir.js";
import { DB_FILE, LATEST_SCHEMA_VERSION, migrate, MIGRATIONS, NewerDatabaseError, openDatabase, openRaw, schemaVersion } from "./db.js";

const clock = fixedClock("2026-11-02T09:00:00Z");
const SNAPSHOTS = fileURLToPath(new URL("../../test/fixtures/db/", import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-seeker-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TABLES = [
  "settings", "events", "profile_sources", "profile_versions", "criteria_sets", "criteria_versions", "criteria_changes",
  "approvals", "jobs", "job_sightings", "job_features", "job_scores", "applications", "application_events", "runs",
  "run_steps", "schedules", "human_steps", "connector_bindings", "ai_calls",
];

describe("migrations", () => {
  it("migrate an empty database to the latest version with every basic table", () => {
    const { db, previousVersion, backupPath } = openDatabase({ dataDir: dir, clock });
    expect(previousVersion).toBe(0);
    expect(backupPath).toBeNull(); // nothing to back up yet
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const table of TABLES) expect(tables).toContain(table);
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();
  });

  it("are numbered without gaps", () => {
    MIGRATIONS.forEach((m, i) => expect(m.version).toBe(i + 1));
  });

  it("re-opening an up-to-date database changes nothing", () => {
    openDatabase({ dataDir: dir, clock }).db.close();
    const again = openDatabase({ dataDir: dir, clock });
    expect(again.previousVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(again.backupPath).toBeNull();
    again.db.close();
  });

  it("migrate every released schema snapshot to the latest, keeping its data", () => {
    const snapshots = readdirSync(SNAPSHOTS).filter((f) => /^schema-v\d+\.sql$/.test(f));
    expect(snapshots.length).toBeGreaterThanOrEqual(LATEST_SCHEMA_VERSION);
    for (const file of snapshots) {
      const version = Number(/v(\d+)/.exec(file)?.[1]);
      const home = join(dir, `snap-${version}`);
      mkdirSync(home);
      const raw = openRaw(join(home, DB_FILE));
      raw.exec(readFileSync(join(SNAPSHOTS, file), "utf8"));
      expect(schemaVersion(raw)).toBe(version);
      const jobs = (raw.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
      raw.close();

      const { db, previousVersion, backupPath } = openDatabase({ dataDir: home, clock });
      expect(previousVersion).toBe(version);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(jobs);
      if (version < LATEST_SCHEMA_VERSION) expect(backupPath && existsSync(backupPath)).toBeTruthy();
      db.close();
    }
  });

  it("back up an older database with VACUUM INTO before migrating", () => {
    const { db } = openDatabase({ dataDir: dir, clock });
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('kept', '1', 'now')").run();
    const next = [...MIGRATIONS, { version: LATEST_SCHEMA_VERSION + 1, name: "test", sql: "CREATE TABLE extra (x)" }];
    const { previousVersion, backupPath } = migrate(db, { dataDir: dir, clock }, next);
    expect(previousVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(backupPath).toBe(join(dir, "backups", `jobseeker-v${LATEST_SCHEMA_VERSION}-20261102T090000Z.db`));
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION + 1);
    db.close();
    const backup = openRaw(backupPath as string);
    expect(schemaVersion(backup)).toBe(LATEST_SCHEMA_VERSION);
    expect(backup.prepare("SELECT value FROM settings WHERE key = 'kept'").get()).toEqual({ value: "1" });
    backup.close();
  });

  it("roll a failed migration back, leaving the version where it was", () => {
    const { db } = openDatabase({ dataDir: dir, clock });
    const broken = [...MIGRATIONS, { version: LATEST_SCHEMA_VERSION + 1, name: "broken", sql: "CREATE TABLE half (x); NOT SQL" }];
    expect(() => migrate(db, { dataDir: dir, clock }, broken)).toThrow();
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined();
    db.close();
  });
});

describe("refusals", () => {
  it("refuse a database from a newer schema, leaving it untouched", () => {
    const raw = openRaw(join(dir, DB_FILE));
    raw.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openDatabase({ dataDir: dir, clock })).toThrow(NewerDatabaseError);
    expect(() => openDatabase({ dataDir: dir, clock })).toThrow(/Upgrade job-seeker/);
    const check = openRaw(join(dir, DB_FILE));
    expect(schemaVersion(check)).toBe(LATEST_SCHEMA_VERSION + 1);
    check.close();
  });

  it("refuse a data directory inside a git work tree", () => {
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    const inside = join(dir, "repo", "nested", "data");
    expect(() => assertOutsideGit(inside)).toThrow(DataDirError);
    expect(() => openDatabase({ dataDir: inside, clock })).toThrow(/git work tree/);
    expect(existsSync(inside)).toBe(false);
  });

  it("treat a .git file (a worktree or submodule) as a work tree too", () => {
    mkdirSync(join(dir, "wt"));
    writeFileSync(join(dir, "wt", ".git"), "gitdir: /elsewhere\n");
    expect(() => assertOutsideGit(join(dir, "wt", "data"))).toThrow(DataDirError);
  });
});

describe("data directory", () => {
  it("is JOB_SEEKER_HOME when set", () => {
    expect(resolveDataDir({ JOB_SEEKER_HOME: dir })).toBe(dir);
  });

  it("follows the platform conventions otherwise", () => {
    expect(defaultDataDir({}, "darwin")).toMatch(/Library[/\\]Application Support[/\\]job-seeker$/);
    expect(defaultDataDir({ LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" }, "win32")).toMatch(/job-seeker$/);
    expect(defaultDataDir({ XDG_DATA_HOME: "/home/example/.data" }, "linux")).toBe(join("/home/example/.data", "job-seeker"));
  });
});
