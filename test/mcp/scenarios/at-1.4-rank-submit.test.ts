/**
 * AT-1.4 (execution plan section 6): `rank_submit` refuses out-of-range or
 * malformed scores, stores valid ones as method `assistant`, and a gate
 * veto still holds.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type McpHarness } from "../harness.js";
import { callError, callOk, jobByCompany, seedDemo, withDb, type JobRow } from "../fixtures.js";

interface Submitted {
  ranked: Array<{ job_id: string; score: number; score_method: string }>;
  vetoed: Array<{ job_id: string; score: number; rule_vetoed: boolean; engineering_role: boolean }>;
  errors: Array<{ job_id: string; error: string }>;
}

const GOOD = { domain: 90, leadership: 85, behavioral: 80, career: 95 };

describe("AT-1.4 rank_submit", () => {
  let harness: McpHarness;

  beforeAll(async () => {
    harness = await startHarness({ prepare: seedDemo });
  });

  afterAll(async () => {
    await harness.close();
  });

  const assistantRows = (jobId: string) =>
    withDb(harness.home, (db) =>
      db.prepare("SELECT method, score, basis FROM job_scores WHERE job_id = ? AND method = 'assistant' AND basis IS NULL").all(jobId),
    );

  it("refuses an out-of-range score and stores nothing for it", async () => {
    const gamma = await jobByCompany(harness.client, "Gamma Retail");
    const out = await callOk<Submitted>(harness.client, "rank_submit", {
      scores: [{ job_id: gamma.job_id, scores: { ...GOOD, domain: 101 } }],
    });
    expect(out.errors).toEqual([{ job_id: gamma.job_id, error: "score 'domain' must be finite and between 0 and 100" }]);
    expect(assistantRows(gamma.job_id)).toEqual([]);
  });

  it("refuses malformed scores", async () => {
    const gamma = await jobByCompany(harness.client, "Gamma Retail");
    const missing = await callOk<Submitted>(harness.client, "rank_submit", {
      scores: [{ job_id: gamma.job_id, scores: { domain: 80, leadership: 70 } }],
    });
    expect(missing.errors[0]?.error).toMatch(/missing or non-numeric score 'behavioral'/);
    const wrongType = await callOk<Submitted>(harness.client, "rank_submit", {
      scores: [{ job_id: gamma.job_id, scores: { ...GOOD, career: "high" } }],
    });
    expect(wrongType.errors[0]?.error).toMatch(/non-numeric score 'career'/);
    const badGate = await callOk<Submitted>(harness.client, "rank_submit", {
      scores: [{ job_id: gamma.job_id, scores: GOOD, seniority_gate: "MAYBE" }],
    });
    expect(badGate.errors[0]?.error).toMatch(/unknown seniority_gate/);
    expect(await callError(harness.client, "rank_submit", { scores: [{ job_id: gamma.job_id, scores: "high" }] })).toMatch(/scores/);
    expect(await callError(harness.client, "rank_submit", { scores: [] })).toMatch(/rank_submit/);
    expect(assistantRows(gamma.job_id)).toEqual([]);
  });

  it("stores a valid score as method assistant, and jobs_list then shows it", async () => {
    const gamma = await jobByCompany(harness.client, "Gamma Retail");
    const out = await callOk<Submitted>(harness.client, "rank_submit", {
      scores: [{ job_id: gamma.job_id, scores: GOOD, reason: "Innovation portfolio at the right scope.", guard: "posting_guard: clean" }],
    });
    expect(out.errors).toEqual([]);
    // 90*.3 + 85*.25 + 80*.15 + 95*.3 = 27 + 21.25 + 12 + 28.5 = 88.75 -> 89
    expect(out.ranked).toEqual([expect.objectContaining({ job_id: gamma.job_id, score: 89, score_method: "assistant" })]);
    expect(assistantRows(gamma.job_id)).toEqual([{ method: "assistant", score: 89, basis: null }]);
    const list = await callOk<{ results: JobRow[] }>(harness.client, "jobs_list", { top_n: 50 });
    expect(list.results.find((j) => j.company === "Gamma Retail")).toMatchObject({ score: 89, score_method: "assistant" });
    expect(list.results.filter((j) => j.company !== "Gamma Retail").every((j) => j.score_method === "rule")).toBe(true);
  });

  it("a rule-gate veto still holds, whatever the judgement says", async () => {
    const delta = await jobByCompany(harness.client, "Delta Robotics");
    const out = await callOk<Submitted>(harness.client, "rank_submit", {
      scores: [{ job_id: delta.job_id, scores: { domain: 100, leadership: 100, behavioral: 100, career: 100 }, engineering_role: false }],
    });
    expect(out.ranked).toEqual([]);
    expect(out.vetoed[0]).toMatchObject({ job_id: delta.job_id, score: 100, rule_vetoed: true });
    const list = await callOk<{ results: JobRow[] }>(harness.client, "jobs_list", { top_n: 50 });
    expect(list.results.map((j) => j.company)).not.toContain("Delta Robotics");
  });

  it("a judgement's own veto holds too", async () => {
    const acme = await jobByCompany(harness.client, "Acme Analytics");
    const out = await callOk<Submitted>(harness.client, "rank_submit", {
      scores: [{ job_id: acme.job_id, scores: GOOD, engineering_role: true }],
    });
    expect(out.vetoed[0]).toMatchObject({ job_id: acme.job_id, engineering_role: true, rule_vetoed: false });
    const list = await callOk<{ results: JobRow[] }>(harness.client, "jobs_list", { top_n: 50 });
    expect(list.results.map((j) => j.company)).not.toContain("Acme Analytics");
  });
});
