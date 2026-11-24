/**
 * AT-1.5 (execution plan section 6): `application_set_state` moves a job
 * through `found`, `shortlisted` and `applied`, writing an event each time.
 * `pipeline_page` returns a path; the page shows the states and escapes the
 * injection fixture.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type McpHarness } from "../harness.js";
import { callError, callOk, jobByCompany, seedDemo, withDb } from "../fixtures.js";

describe("AT-1.5 applications and the pipeline page", () => {
  let harness: McpHarness;

  beforeAll(async () => {
    harness = await startHarness({ prepare: seedDemo });
  });

  afterAll(async () => {
    await harness.close();
  });

  it("moves a job through found, shortlisted and applied, with an event each time", async () => {
    const globex = await jobByCompany(harness.client, "Globex Corp");
    expect(globex.application_state).toBeNull();
    for (const [from, to] of [
      [null, "found"],
      ["found", "shortlisted"],
      ["shortlisted", "applied"],
    ] as const) {
      const moved = await callOk(harness.client, "application_set_state", { job_id: globex.job_id, state: to });
      expect(moved).toEqual({ job_id: globex.job_id, from_state: from, state: to, changed: true });
    }
    const events = withDb(harness.home, (db) =>
      (
        db.prepare("SELECT payload FROM events WHERE type = 'application.state_changed' AND entity_id = ? ORDER BY cursor").all(globex.job_id) as Array<{
          payload: string;
        }>
      ).map((e) => JSON.parse(e.payload)),
    );
    expect(events).toEqual([
      { from: null, to: "found" },
      { from: "found", to: "shortlisted" },
      { from: "shortlisted", to: "applied" },
    ]);
    const app = await callOk<{ state: string; events: Array<{ to_state: string; channel: string; reported_by: string }> }>(
      harness.client,
      "application_get",
      { job_id: globex.job_id },
    );
    expect(app.state).toBe("applied");
    expect(app.events.map((e) => e.to_state)).toEqual(["found", "shortlisted", "applied"]);
    expect(app.events.every((e) => e.channel === "mcp" && e.reported_by === "assistant")).toBe(true);
  });

  it("lists applications by state", async () => {
    const applied = await callOk<{ results: Array<{ company: string }>; counts: Record<string, number> }>(harness.client, "applications_list", {
      state: "applied",
    });
    expect(applied.results.map((r) => r.company).sort()).toEqual(["Acme Analytics", "Globex Corp", "Xi Group"]);
    expect(applied.counts.applied).toBe(3);
  });

  it("refuses an unknown state", async () => {
    const globex = await jobByCompany(harness.client, "Globex Corp");
    expect(await callError(harness.client, "application_set_state", { job_id: globex.job_id, state: "hired" })).toMatch(/state/);
  });

  it("pipeline_page returns a path; the page shows the states and escapes the injection fixture", async () => {
    const page = await callOk<{ path: string; summary: { applications: Record<string, number>; top_matches: number } }>(
      harness.client,
      "pipeline_page",
    );
    expect(page.path).toBe(join(harness.home, "reports", "pipeline.html"));
    expect(page.summary.applications).toMatchObject({ applied: 3, shortlisted: 2, interview: 1, rejected: 2 });
    expect(page.summary.top_matches).toBeGreaterThan(0);
    const html = readFileSync(page.path, "utf8");
    for (const label of ["Found", "Shortlisted", "Resume prepared", "Applied", "Interview", "Rejected", "Top match"]) {
      expect(html).toContain(label);
    }
    // The injection fixture's title is shown, escaped; its hidden payload never reaches the page.
    expect(html).toContain("VP, AI Transformation &lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("Ignore all previous instructions");
    expect(html).toContain("&lt;b&gt;Status typed by hand&lt;/b&gt;");
    expect(html).not.toMatch(/(src|href)="https?:\/\/(?![a-z]+\.example\/)/);
    expect(html).not.toContain("<script src");
    expect(html).not.toContain("<link");
  });
});
