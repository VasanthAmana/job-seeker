/**
 * Spec for core/ranking, translated from tests/test_rank_state.py (19).
 *
 * The state file becomes the jobs and job_scores tables by design (design
 * 5.2, 8), so `apply` is `applyJudgements`, `sweep` is `sweepDeadlines`
 * and `candidates` is `rankCandidates`; the assertions are the same. The
 * StateError cases (a truncated, missing or non-object seen_jobs.json) move
 * to the legacy import's suite, the only place that still reads that file;
 * the lazy-config cases become the engine's "a bad config.json never stops
 * the server" case.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeCtx, type TestContext } from "../../../test/support/core.js";
import { setApplicationState } from "../applications.js";
import { getJobRow, ingest, rankCandidates, sweepDeadlines } from "../jobs.js";
import { applyJudgements } from "./judgement.js";
import { band, overallScore, score10, ScoreError } from "./score.js";

const WEIGHTS = { domain: 0.3, leadership: 0.25, behavioral: 0.15, career: 0.3 };

let ctx: TestContext;
beforeEach(() => {
  ctx = makeCtx();
});
afterEach(() => ctx.close());

function entry(title: string, company: string, url: string, extra: Record<string, unknown> = {}) {
  return { title, company, url, ...extra };
}

/** Store entries and return their job ids, in order. */
function write(entries: Array<Record<string, unknown>>): string[] {
  const result = ingest(ctx, entries, { connector: "linkedin-alerts" });
  return entries.map((e) => getJobRow(ctx, result.added[entries.indexOf(e)] as string)?.id as string);
}

function result(jobId: string, overrides: Record<string, unknown> = {}) {
  return {
    job_id: jobId,
    scores: { domain: 80, leadership: 70, behavioral: 60, career: 90 },
    location_verdict: "PASS",
    seniority_gate: "PASS",
    engineering_role: false,
    reason: "Strong AI-strategy scope at Director level.",
    strengths: ["enterprise AI roadmap ownership"],
    gaps: ["no banking domain named"],
    guard: "clean",
    ...overrides,
  };
}

const apply = (results: unknown[], today = "2026-11-02") => applyJudgements(ctx, results, { method: "assistant", today });

describe("score arithmetic", () => {
  it("weights, band and the 1-10 scale", () => {
    const score = overallScore({ domain: 80, leadership: 70, behavioral: 60, career: 90 }, WEIGHTS);
    // 80*.3 + 70*.25 + 60*.15 + 90*.3 = 24 + 17.5 + 9 + 27 = 77.5 -> 78
    expect(score).toBe(78);
    expect(band(score)).toBe("Strong Fit");
    expect(score10(score)).toBe(7.8);
  });

  it("rejects a missing dimension, an out-of-range score and a boolean", () => {
    expect(() => overallScore({ domain: 80, leadership: 70, behavioral: 60 }, WEIGHTS)).toThrow(ScoreError);
    expect(() => overallScore({ domain: 101, leadership: 70, behavioral: 60, career: 90 }, WEIGHTS)).toThrow(ScoreError);
    expect(() => overallScore({ domain: true, leadership: 70, behavioral: 60, career: 90 }, WEIGHTS)).toThrow(ScoreError);
  });

  it("accepts explicit weights", () => {
    expect(overallScore({ only: 80 }, { only: 1.0 })).toBe(80);
  });

  it("does not drop a half-point to float error", () => {
    // 59.5 must round to 60 (Good Fit), not 59 (Moderate Fit).
    expect(overallScore({ a: 59.5 }, { a: 1 })).toBe(60);
    expect(overallScore({ a: 85, b: 34 }, { a: 0.5, b: 0.5 })).toBe(60);
  });
});

describe("applyJudgements (rank_state apply)", () => {
  it("ranks and scores", () => {
    const [id] = write([entry("Director, AI Strategy", "Acme", "https://a.example/1")]);
    const out = apply([result(id as string)]);
    expect(out.errors).toEqual([]);
    expect(out.ranked).toHaveLength(1);
    expect(out.vetoed).toHaveLength(0);
    const row = out.ranked[0] as Record<string, unknown>;
    expect(row.score).toBe(78);
    expect(row.score_10).toBe(7.8);
    expect(row.verdict).toBe("Strong Fit");
    expect(row.reason).toBe("Strong AI-strategy scope at Director level.");
    expect(row.seniority_gate).toBe("PASS");
    expect(row.engineering_role).toBe(false);
    const stored = ctx.db.prepare("SELECT method, score FROM job_scores WHERE job_id = ? AND method = 'assistant'").get(id as string);
    expect(stored).toEqual({ method: "assistant", score: 78 });
  });

  it("a seniority FAIL vetoes", () => {
    const [id] = write([entry("AI Strategy Manager", "Acme", "https://a.example/1")]);
    const out = apply([result(id as string, { seniority_gate: "FAIL", reason: "Manager-level IC role, below the Director target." })]);
    expect(out.ranked).toHaveLength(0);
    expect(out.vetoed).toHaveLength(1);
    expect((out.vetoed[0] as Record<string, unknown>).seniority_gate).toBe("FAIL");
  });

  it("an engineering role vetoes even with a high score", () => {
    const [id] = write([entry("Machine Learning Engineer", "Acme", "https://a.example/1")]);
    const out = apply([
      result(id as string, { engineering_role: true, scores: { domain: 95, leadership: 90, behavioral: 90, career: 95 } }),
    ]);
    expect(out.ranked).toHaveLength(0);
    const vetoed = out.vetoed[0] as Record<string, unknown>;
    expect(vetoed.engineering_role).toBe(true);
    expect(vetoed.score as number).toBeGreaterThanOrEqual(90);
  });

  it("a seniority FLAG stays ranked", () => {
    const [id] = write([entry("Senior Manager, AI Strategy", "Acme", "https://a.example/1")]);
    const out = apply([result(id as string, { seniority_gate: "FLAG" })]);
    expect(out.ranked).toHaveLength(1);
    expect((out.ranked[0] as Record<string, unknown>).seniority_gate).toBe("FLAG");
  });

  it("bad gate values and types, and unknown jobs, are errors", () => {
    const [id] = write([entry("Director, AI Strategy", "Acme", "https://a.example/1")]);
    expect(apply([result(id as string, { seniority_gate: "MEH" })]).errors).toHaveLength(1);
    expect(apply([result(id as string, { engineering_role: "yes" })]).errors).toHaveLength(1);
    const out = apply([result("no_such_key")]);
    expect(out.errors[0]?.job_id).toBe("no_such_key");
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM job_scores WHERE method = 'assistant'").get()).toEqual({ n: 0 });
  });

  it("an unknown status is an error, not a missing score", () => {
    const [id] = write([entry("Director, AI Strategy", "Acme", "https://a.example/1")]);
    expect(apply([{ job_id: id, status: "rankd" }]).errors[0]?.error).toMatch(/unknown status/);
  });

  it("expires on an expired status and on a passed deadline", () => {
    const ids = write([
      entry("Director, AI Strategy", "Acme", "https://a.example/1", { deadline: "2026-10-01" }),
      entry("VP Transformation", "Beta", "https://b.example/2"),
    ]);
    const out = apply([result(ids[0] as string), { job_id: ids[1], status: "expired" }]);
    expect(out.expired).toHaveLength(2);
    expect(getJobRow(ctx, ids[0] as string)?.status).toBe("expired");
    expect(getJobRow(ctx, ids[1] as string)?.status).toBe("expired");
  });

  it("retries an unreachable posting, then gives up after 3 attempts over 48 hours", () => {
    const [id] = write([entry("Director, AI Strategy", "Acme", "https://a.example/1")]);
    const unreachable = [{ job_id: id, status: "unreachable", fetch_error: "403 after curl retry" }];
    const t0 = new Date("2026-11-02T09:00:00Z");
    const run = (now: Date) => applyJudgements(ctx, unreachable, { method: "assistant", now, today: "2026-11-02" });
    expect((run(t0).unreachable[0] as Record<string, unknown>).fetch_attempts).toBe(1);
    // Third attempt but only hours later: still retrying (48h floor).
    run(t0);
    let out = run(t0);
    expect(out.unreachable).toHaveLength(1);
    expect(out.gave_up).toHaveLength(0);
    // Fourth attempt after 48h: gives up to expired.
    out = run(new Date(t0.getTime() + 49 * 3600 * 1000));
    expect(out.gave_up).toHaveLength(1);
    const stored = getJobRow(ctx, id as string);
    expect(stored?.status).toBe("expired");
    expect(stored?.expired_reason).toBe("unreachable");
  });

  it("a judgement never lifts a rule veto", () => {
    ctx.settings.ranking.rules.exclude = ["engineer"];
    const [id] = write([entry("Data Engineer", "Acme", "https://a.example/1")]);
    const out = apply([result(id as string, { scores: { domain: 100, leadership: 100, behavioral: 100, career: 100 } })]);
    expect(out.ranked).toHaveLength(0);
    expect((out.vetoed[0] as Record<string, unknown>).rule_vetoed).toBe(true);
  });
});

describe("sweepDeadlines (rank_state sweep)", () => {
  it("expires passed deadlines and reports closing ones", () => {
    const ids = write([
      entry("Old Role", "Acme", "https://a.example/1", { deadline: "2026-10-01" }),
      entry("Closing Role", "Beta", "https://b.example/2", { deadline: "2026-11-05" }),
      entry("Open Role", "Gamma", "https://c.example/3", { deadline: "2026-12-31" }),
      entry("No Deadline", "Delta", "https://d.example/4"),
    ]);
    // A deadline that is not a date is stored as given and never guessed at.
    ctx.db.prepare("UPDATE jobs SET deadline = 'ASAP' WHERE id = ?").run(
      write([entry("Bad Deadline", "Epsilon", "https://e.example/5")])[0] as string,
    );
    const out = sweepDeadlines(ctx, { today: "2026-11-02", write: true });
    expect(out.newly_expired.map((r) => r.job_id)).toEqual([ids[0]]);
    expect(out.closing_soon.map((r) => r.job_id)).toEqual([ids[1]]);
    expect(out.unparseable_deadlines[0]?.deadline).toBe("ASAP");
    expect(getJobRow(ctx, ids[0] as string)?.status).toBe("expired");
    expect(getJobRow(ctx, ids[3] as string)?.status).toBe("active");
  });
});

describe("rankCandidates (rank_state candidates)", () => {
  it("filters by status and excludes jobs with an application", () => {
    const ids = write([
      entry("Director, AI Strategy", "Acme", "https://a.example/1"),
      entry("VP Transformation", "Beta", "https://b.example/2"),
      entry("Old", "Gamma", "https://c.example/3"),
    ]);
    setApplicationState(ctx, ids[1] as string, "applied");
    apply([result(ids[2] as string)]);
    const out = rankCandidates(ctx);
    expect(out.eligible).toBe(1);
    expect(out.excluded_by_application).toBe(1);
    expect(out.selected[0]?.job_id).toBe(ids[0]);
    expect(out.selected[0]?.sources).toEqual(["linkedin-alerts"]);
  });
});
