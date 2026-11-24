/**
 * AT-1.1 (execution plan section 6): after importing the fictional legacy
 * fixtures, `status` reports the counts. `jobs_list` returns jobs ranked by
 * rule score, each naming its sources and score method; vetoed jobs are
 * excluded and `top_n` is respected.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type McpHarness } from "../harness.js";
import { callOk, importLegacyFixtures, ingestDemoPostings, jobByCompany, withDb, writeDemoConfig, type JobRow } from "../fixtures.js";

interface Status {
  jobs: { total: number; by_status: Record<string, number>; sightings: number };
  applications: { total: number; by_state: Record<string, number> };
  legacy_import: { seen_jobs: number; tracker_rows: number; shortlist: number } | null;
  waiting_for_you: unknown[];
  pending_approvals: number;
}

describe("AT-1.1 ranked jobs over imported legacy fixtures", () => {
  let harness: McpHarness;
  let importOutput = "";

  beforeAll(async () => {
    harness = await startHarness({
      prepare: (home) => {
        writeDemoConfig(home);
        importOutput = importLegacyFixtures(home);
        ingestDemoPostings(home);
      },
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  it("the CLI import reports what it read", () => {
    expect(importOutput).toMatch(/seen_jobs\.json: 8 read, 8 new jobs/);
    expect(importOutput).toMatch(/tracker\.csv: 8 rows read, 8 imported \(2 matched to jobs, 6 new jobs\)/);
    expect(importOutput).toMatch(/statuses recorded as found: mystery/);
  });

  it("status reports the counts", async () => {
    const status = await callOk<Status>(harness.client, "status");
    // 8 seen jobs + 6 jobs only the tracker knew + 2 new postings (the third merged into Acme).
    expect(status.jobs.total).toBe(16);
    expect(status.jobs.by_status).toEqual({ active: 14, expired: 1, skipped: 1 });
    expect(status.applications.total).toBe(9);
    expect(status.applications.by_state).toEqual({
      applied: 2,
      found: 1,
      interview: 1,
      rejected: 2,
      resume_prepared: 1,
      shortlisted: 2,
    });
    expect(status.legacy_import).toMatchObject({ seen_jobs: 8, tracker_rows: 8, shortlist: 2 });
    expect(status.waiting_for_you).toEqual([]);
    expect(status.pending_approvals).toBe(0);
  });

  it("jobs_list ranks by rule score, naming sources and score method", async () => {
    const list = await callOk<{ top_n: number; count: number; vetoed: number; results: JobRow[] }>(harness.client, "jobs_list", { top_n: 20 });
    const scores = list.results.map((j) => j.score as number);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    for (const job of list.results) {
      expect(job.score_method).toBe("rule");
      expect(job.sources.length).toBeGreaterThan(0);
    }
    const acme = list.results.find((j) => j.company === "Acme Analytics");
    expect(acme?.sources).toEqual(["legacy:linkedin", "demo-postings"]);
    expect(list.results[0]?.company).toBe("Acme Analytics");
  });

  it("vetoed jobs are excluded", async () => {
    const list = await callOk<{ vetoed: number; results: JobRow[] }>(harness.client, "jobs_list", { top_n: 50 });
    const companies = list.results.map((j) => j.company);
    // An engineering role, a seniority miss, a location miss and a salary below the floor.
    for (const vetoed of ["Delta Robotics", "Epsilon Bank", "Zeta Logistics", "Pi Software"]) {
      expect(companies).not.toContain(vetoed);
    }
    expect(list.vetoed).toBe(4);
    const delta = await jobByCompany(harness.client, "Delta Robotics");
    expect(delta.vetoed).toBe(true);
    // Expired, skipped and rejected jobs are not current matches either.
    for (const gone of ["Eta Media", "Theta Labs", "Lambda Insurance", "Mu Consulting"]) {
      expect(companies).not.toContain(gone);
    }
  });

  it("top_n is respected, and defaults to ranking.top_n", async () => {
    const three = await callOk<{ count: number; results: JobRow[] }>(harness.client, "jobs_list", { top_n: 3 });
    expect(three.results).toHaveLength(3);
    expect(three.count).toBe(3);
    const fallback = await callOk<{ top_n: number; results: JobRow[] }>(harness.client, "jobs_list");
    expect(fallback.top_n).toBe(5);
    expect(fallback.results).toHaveLength(5);
  });

  it("the shortlist filter lists shortlisted applications", async () => {
    const shortlist = await callOk<{ results: JobRow[] }>(harness.client, "jobs_list", { shortlist: true });
    expect(shortlist.results.map((j) => j.company).sort()).toEqual(["Gamma Retail", "Iota Energy"]);
  });

  it("every job has a stored rule score, and the predecessor's scores are kept", () => {
    withDb(harness.home, (db) => {
      const unscored = db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE id NOT IN (SELECT job_id FROM job_scores WHERE method = 'rule')")
        .get() as { n: number };
      expect(unscored.n).toBe(0);
      const legacy = db.prepare("SELECT COUNT(*) AS n FROM job_scores WHERE basis = 'legacy_import'").get() as { n: number };
      expect(legacy.n).toBe(5);
    });
  });
});
