/**
 * The legacy import (design 5.4 item 4). Also carries the StateError cases
 * of tests/test_rank_state.py (a truncated, missing or non-object
 * seen_jobs.json gives a typed, catchable error with a clear message),
 * since this is the one place the new engine still reads that file.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeCtx, type TestContext } from "../../test/support/core.js";
import { getApplication, listApplications } from "../core/applications.js";
import { getJob, listJobs } from "../core/jobs.js";
import { importLegacy, LegacyStateError, parseCsv, readSeenJobs } from "./import.js";

const LEGACY = fileURLToPath(new URL("../../fixtures/demo/legacy/", import.meta.url));

let ctx: TestContext;
let scratch: string;
beforeEach(() => {
  ctx = makeCtx();
  scratch = mkdtempSync(join(tmpdir(), "job-seeker-legacy-"));
});
afterEach(() => {
  ctx.close();
  rmSync(scratch, { recursive: true, force: true });
});

const count = (sql: string) => (ctx.db.prepare(sql).get() as { n: number }).n;

describe("seen_jobs.json reading (rank_state StateError cases)", () => {
  it("a truncated file is a typed error saying it is not valid JSON", () => {
    const path = join(scratch, "seen_jobs.json");
    writeFileSync(path, '{"seen": {truncated');
    expect(() => readSeenJobs(path)).toThrow(LegacyStateError);
    expect(() => readSeenJobs(path)).toThrow(/not valid JSON/);
  });

  it("a missing file is a typed error saying it was not found", () => {
    expect(() => readSeenJobs(join(scratch, "nope.json"))).toThrow(/not found/);
  });

  it("a non-object document is a typed error", () => {
    const path = join(scratch, "seen_jobs.json");
    writeFileSync(path, JSON.stringify(["not", "an", "object"]));
    expect(() => readSeenJobs(path)).toThrow(/expected an object/);
  });

  it("nothing to import is refused with what to give", () => {
    expect(() => importLegacy(ctx, { from: scratch })).toThrow(/found nothing to import/);
    expect(() => importLegacy(ctx, { from: join(scratch, "missing") })).toThrow(/not found/);
  });
});

describe("importing the fictional predecessor state", () => {
  it("imports every seen job, tracker row and shortlist entry", () => {
    const result = importLegacy(ctx, { from: LEGACY });
    expect(result.seen_jobs).toEqual({ read: 8, imported: 8, already_imported: 0, merged_duplicates: 0, invalid: 0 });
    expect(result.tracker).toEqual({ read: 8, imported: 8, already_imported: 0, matched_jobs: 2, new_jobs: 6, unmapped_statuses: ["mystery"] });
    expect(result.shortlist).toEqual({ read: 2, imported: 1, already_imported: 0, skipped_with_application: 1, unknown_keys: 0 });
    expect(result.totals).toEqual({ jobs: 14, applications: 9 });
    expect(count("SELECT COUNT(*) AS n FROM job_sightings WHERE connector LIKE 'legacy:%'")).toBe(14);
  });

  it("maps the predecessor's statuses, keeping what it said in the note", () => {
    importLegacy(ctx, { from: LEGACY });
    const states = Object.fromEntries(listApplications(ctx).results.map((r) => [r.company, r.state]));
    expect(states).toEqual({
      "Acme Analytics": "applied",
      "Iota Energy": "shortlisted",
      "Kappa Finance": "interview",
      "Lambda Insurance": "rejected",
      "Beta Health": "resume_prepared",
      "Mu Consulting": "rejected",
      "Nu Corp": "found",
      "Xi Group": "applied",
      "Gamma Retail": "shortlisted",
    });
    const mu = listApplications(ctx).results.find((r) => r.company === "Mu Consulting") as { job_id: string };
    expect(getApplication(ctx, mu.job_id).events[0]?.note).toBe("legacy status: withdrawn");
    const acme = listApplications(ctx).results.find((r) => r.company === "Acme Analytics") as { job_id: string };
    expect(getApplication(ctx, acme.job_id).events[0]).toMatchObject({ at: "2026-10-21T00:00:00.000Z", channel: "import", reported_by: "import" });
  });

  it("keeps the predecessor's scores and vetoes, showing rule scores", () => {
    importLegacy(ctx, { from: LEGACY });
    const delta = getJob(ctx, "delta-robotics_machine-learning-engineer");
    expect(delta.vetoed).toBe(true);
    expect(delta.scores.find((s) => s.basis === "legacy_import")).toMatchObject({ method: "assistant", score: 91, vetoed: true });
    expect(listJobs(ctx, { top_n: 50 }).results.every((j) => j.score_method === "rule")).toBe(true);
  });

  it("is idempotent: a second run imports nothing new", () => {
    importLegacy(ctx, { from: LEGACY });
    const again = importLegacy(ctx, { from: LEGACY });
    expect(again.seen_jobs).toMatchObject({ imported: 0, already_imported: 8 });
    expect(again.tracker).toMatchObject({ imported: 0, already_imported: 8 });
    expect(again.shortlist).toMatchObject({ imported: 0, already_imported: 2 });
    expect(again.totals).toEqual({ jobs: 14, applications: 9 });
  });

  it("merges newly seen jobs and moves an application whose tracker status changed", () => {
    const copy = join(scratch, "legacy");
    mkdirSync(join(copy, "state"), { recursive: true });
    copyFileSync(join(LEGACY, "state", "seen_jobs.json"), join(copy, "state", "seen_jobs.json"));
    copyFileSync(join(LEGACY, "tracker.csv"), join(copy, "tracker.csv"));
    importLegacy(ctx, { from: copy });

    const seen = JSON.parse(readFileSync(join(copy, "state", "seen_jobs.json"), "utf8"));
    seen.seen["omega-works_vp-strategy"] = { title: "VP Strategy", company: "Omega Works", url: "https://omega.example/jobs/1", source: "indeed", status: "new" };
    writeFileSync(join(copy, "state", "seen_jobs.json"), JSON.stringify(seen));
    const tracker = readFileSync(join(copy, "tracker.csv"), "utf8").replace("Head of AI,permanent,online,interview", "Head of AI,permanent,online,offer");
    writeFileSync(join(copy, "tracker.csv"), tracker);

    const second = importLegacy(ctx, { from: copy });
    expect(second.seen_jobs).toMatchObject({ imported: 1, already_imported: 8 });
    expect(second.tracker).toMatchObject({ imported: 1, already_imported: 7, matched_jobs: 1 });
    const kappa = listApplications(ctx).results.find((r) => r.company === "Kappa Finance") as { job_id: string };
    expect(getApplication(ctx, kappa.job_id).events.map((e) => e.to_state)).toEqual(["interview", "offer"]);
  });

  it("refuses a tracker that is not UTF-8", () => {
    const path = join(scratch, "tracker.csv");
    writeFileSync(path, Buffer.from([0x64, 0x61, 0x74, 0x65, 0x0a, 0xff, 0xfe, 0x0a]));
    expect(() => importLegacy(ctx, { tracker: path })).toThrow(/not UTF-8/);
  });
});

describe("csv parsing", () => {
  it("reads quoted fields, doubled quotes, a BOM and short rows like csv.DictReader", () => {
    const rows = parseCsv('\ufeffa,b,c\r\n1,"two, ""quoted""",3\n4,5\n');
    expect(rows).toEqual([
      { a: "1", b: 'two, "quoted"', c: "3" },
      { a: "4", b: "5", c: "" },
    ]);
  });
});
