/**
 * AT-1.3 (execution plan section 6): `jobs_search` matches on title,
 * company and location; an empty query is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type McpHarness } from "../harness.js";
import { callError, callOk, seedDemo, type JobRow } from "../fixtures.js";

type Found = { query: string; count: number; results: Array<JobRow & { location: string | null }> };

describe("AT-1.3 jobs_search", () => {
  let harness: McpHarness;

  beforeAll(async () => {
    harness = await startHarness({ prepare: seedDemo });
  });

  afterAll(async () => {
    await harness.close();
  });

  it("matches on the title", async () => {
    const found = await callOk<Found>(harness.client, "jobs_search", { query: "machine learning" });
    expect(found.results.map((j) => j.company)).toEqual(["Delta Robotics"]);
  });

  it("matches on the company, case-insensitively", async () => {
    const found = await callOk<Found>(harness.client, "jobs_search", { query: "GAMMA retail" });
    expect(found.count).toBe(1);
    expect(found.results[0]?.title).toBe("Head of AI Innovation");
  });

  it("matches on the location, including vetoed and expired jobs", async () => {
    const found = await callOk<Found>(harness.client, "jobs_search", { query: "denver" });
    expect(found.results.map((j) => j.company).sort()).toEqual(["Acme Analytics", "Delta Robotics", "Eta Media"]);
    expect(found.results.find((j) => j.company === "Delta Robotics")?.vetoed).toBe(true);
  });

  it("finds nothing for text that is in no job", async () => {
    const found = await callOk<Found>(harness.client, "jobs_search", { query: "underwater basket weaving" });
    expect(found).toEqual({ query: "underwater basket weaving", count: 0, results: [] });
  });

  it("refuses an empty query", async () => {
    expect(await callError(harness.client, "jobs_search", { query: "" })).toMatch(/jobs_search: .*query/);
    expect(await callError(harness.client, "jobs_search", { query: "   " })).toMatch(/non-empty/);
    expect(await callError(harness.client, "jobs_search", {})).toMatch(/missing argument: query/);
  });
});
