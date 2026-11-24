/**
 * AT-1.2 (execution plan section 6): `job_get` returns the description
 * inside `untrusted_page_content`, and the prompt-injection fixture carries
 * the guard's findings.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type McpHarness } from "../harness.js";
import { callError, callOk, jobByCompany, seedDemo } from "../fixtures.js";

interface FullJob {
  job_id: string;
  partial: boolean;
  description: { untrusted_page_content: string } | null;
  guard: { verdict: string; instruction_like: string[]; hidden_urls: string[]; hidden_blocks: string[] } | null;
  sightings: Array<{ connector: string }>;
  scores: Array<{ method: string; basis: string | null }>;
}

describe("AT-1.2 job_get wraps untrusted posting text", () => {
  let harness: McpHarness;

  beforeAll(async () => {
    harness = await startHarness({ prepare: seedDemo });
  });

  afterAll(async () => {
    await harness.close();
  });

  it("returns the description inside untrusted_page_content", async () => {
    const acme = await jobByCompany(harness.client, "Acme Analytics");
    const job = await callOk<FullJob>(harness.client, "job_get", { job_id: acme.job_id });
    expect(job.description).toEqual({ untrusted_page_content: expect.stringContaining("enterprise AI strategy") });
    expect(job.guard?.verdict).toBe("posting_guard: clean");
    expect(job.partial).toBe(false);
    expect(job.sightings.map((s) => s.connector)).toEqual(["legacy:linkedin", "demo-postings"]);
    expect(job.scores.map((s) => s.method)).toContain("rule");
  });

  it("carries the guard's findings for the prompt-injection fixture, with the hidden payload removed", async () => {
    const globex = await jobByCompany(harness.client, "Globex Corp");
    const job = await callOk<FullJob>(harness.client, "job_get", { job_id: globex.job_id });
    const text = job.description?.untrusted_page_content ?? "";
    expect(text).toContain("AI transformation office");
    expect(text).not.toContain("Ignore all previous instructions");
    expect(text).not.toContain("evil.example.com");
    expect(job.guard?.verdict).toContain("\u26a0");
    expect(job.guard?.instruction_like.join("\n")).toMatch(/Ignore all previous instructions/);
    expect(job.guard?.hidden_urls).toContain("https://evil.example.com/exfiltrate");
    expect(job.guard?.hidden_blocks.length).toBeGreaterThan(0);
  });

  it("says when there is no description yet", async () => {
    const kappa = await jobByCompany(harness.client, "Kappa Finance");
    const job = await callOk<FullJob>(harness.client, "job_get", { job_id: kappa.job_id });
    expect(job.description).toBeNull();
    expect(job.guard).toBeNull();
    expect(job.partial).toBe(true);
  });

  it("accepts the dedupe key, and refuses an unknown job", async () => {
    const job = await callOk<{ company: string }>(harness.client, "job_get", { job_id: "gamma-retail_head-of-ai-innovation" });
    expect(job.company).toBe("Gamma Retail");
    expect(await callError(harness.client, "job_get", { job_id: "job_does_not_exist" })).toMatch(/no job with id/);
  });

  it("serves the same wrapped job as the jobseeker://jobs/{id} resource", async () => {
    const globex = await jobByCompany(harness.client, "Globex Corp");
    const resource = await harness.client.readResource({ uri: `jobseeker://jobs/${globex.job_id}` });
    const body = JSON.parse((resource.contents[0] as { text: string }).text) as FullJob;
    expect(body.description?.untrusted_page_content).toContain("AI transformation office");
    expect(body.guard?.verdict).toContain("\u26a0");
  });
});
