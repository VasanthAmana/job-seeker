/**
 * AT-1.7 (execution plan section 6): a database from a newer schema makes
 * `status` return a clear "upgrade job-seeker" error. The server keeps
 * serving, and the database is left untouched.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LATEST_SCHEMA_VERSION, openRaw, schemaVersion } from "../../../src/store/db.js";
import { startHarness, type McpHarness } from "../harness.js";
import { callError, withDb } from "../fixtures.js";

describe("AT-1.7 a database from a newer job-seeker", () => {
  let harness: McpHarness;

  beforeAll(async () => {
    harness = await startHarness({
      prepare: (home) => {
        mkdirSync(home, { recursive: true });
        const db = openRaw(join(home, "jobseeker.db"));
        db.exec(`CREATE TABLE from_the_future (x); PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1};`);
        db.close();
      },
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  it("status returns a clear upgrade error", async () => {
    const text = await callError(harness.client, "status");
    expect(text).toMatch(/newer than this build understands/);
    expect(text).toMatch(/Upgrade job-seeker/);
  });

  it("every other tool says the same, and the server keeps serving", async () => {
    expect(await callError(harness.client, "jobs_list")).toMatch(/Upgrade job-seeker/);
    const { tools } = await harness.client.listTools();
    expect(tools.map((t) => t.name)).toContain("status");
  });

  it("leaves the database untouched", () => {
    withDb(harness.home, (db) => {
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION + 1);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'jobs'").get()).toBeUndefined();
    });
  });
});
