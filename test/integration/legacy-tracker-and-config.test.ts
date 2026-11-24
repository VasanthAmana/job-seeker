/**
 * Regressions: tracker rows with a blank role for one company import as one
 * job and application; a bare tracker date never becomes an application
 * timestamp; a long-lived Engine picks up config.json edits.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Engine } from "../../src/engine/engine.js";
import { fixedClock } from "../../src/util/clock.js";
import { FAKE_NOW, runCli } from "../mcp/harness.js";

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-seeker-legacy-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function engine(): Engine {
  return new Engine({ dataDir: home, clock: fixedClock(FAKE_NOW), env: { JOB_SEEKER_NOW: FAKE_NOW } });
}

function importTracker(csv: string) {
  const path = join(dir, "tracker.csv");
  writeFileSync(path, csv);
  const result = runCli(home, ["import-legacy", "--tracker", path, "--json"]);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as { totals: { jobs: number; applications: number } };
}

describe("import-legacy tracker rows", () => {
  it("imports several blank-role rows for one company as one job and application", () => {
    const result = importTracker(
      ["date,company,role,status,notes", "2025-01-02,Acme,,Applied,", "2025-01-09,Acme,,Interview,", "2025-01-20,Acme,,Rejected,"].join("\n"),
    );
    expect(result.totals).toEqual({ jobs: 1, applications: 1 });
  });

  it("orders an application with a bare tracker date by import time, keeping the date in the note", () => {
    importTracker(["date,company,role,status,notes", "2025,Acme,VP AI,Applied,", "2024-06-01,Beta,Director AI,Applied,"].join("\n"));
    const e = engine();
    try {
      const list = e.call("applications_list", {}, { surface: "cli" }) as { results: Array<{ company: string; updated_at: string; job_id: string }> };
      expect(list.results.map((a) => a.company)).toEqual(["Acme", "Beta"]);
      const acme = list.results[0]!;
      expect(acme.updated_at).toBe(new Date(FAKE_NOW).toISOString());
      const app = e.call("application_get", { job_id: acme.job_id }, { surface: "cli" });
      expect(JSON.stringify(app)).toContain("legacy date: 2025");
    } finally {
      e.close();
    }
  });
});

describe("Engine settings", () => {
  it("picks up config.json edits without a restart", () => {
    importTracker(["date,company,role,status,notes", "2025-01-02,Acme,VP AI Strategy,Applied,", "2025-01-03,Beta,Office Manager,Applied,"].join("\n"));
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify({ ranking: { top_n: 5 } }));
    const e = engine();
    try {
      type List = { top_n: number; results: Array<{ company: string; score: number | null }> };
      const before = e.call("jobs_list", {}, { surface: "cli" }) as List;
      expect(before.top_n).toBe(5);
      writeFileSync(config, JSON.stringify({ ranking: { top_n: 1, rules: { titles: ["AI Strategy"] } } }));
      const after = e.call("jobs_list", {}, { surface: "cli" }) as List;
      expect(after.top_n).toBe(1);
      expect(after.results.map((j) => j.company)).toEqual(["Acme"]);
      const acmeBefore = before.results.find((j) => j.company === "Acme")?.score;
      expect(after.results[0]?.score).not.toBe(acmeBefore);
    } finally {
      e.close();
    }
  });
});
