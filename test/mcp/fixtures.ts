/**
 * Scenario fixtures: the fictional demo data set (fixtures/demo), loaded the
 * way a user would: config.json written, `job-seeker import-legacy` run from
 * the CLI, and the fictional postings ingested through the Engine API (the
 * path connectors use from phase 2).
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { expect } from "vitest";

import { Engine } from "../../src/engine/engine.js";
import { openRaw, type Database } from "../../src/store/db.js";
import { fixedClock } from "../../src/util/clock.js";
import { FAKE_NOW, runCli } from "./harness.js";

export const DEMO = fileURLToPath(new URL("../../fixtures/demo/", import.meta.url));

export function writeDemoConfig(home: string): void {
  mkdirSync(home, { recursive: true });
  copyFileSync(join(DEMO, "config.json"), join(home, "config.json"));
}

export function importLegacyFixtures(home: string): string {
  const result = runCli(home, ["import-legacy", "--from", join(DEMO, "legacy")]);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
}

export function ingestDemoPostings(home: string): void {
  const engine = new Engine({ dataDir: home, clock: fixedClock(FAKE_NOW), env: { JOB_SEEKER_NOW: FAKE_NOW } });
  try {
    const records = JSON.parse(readFileSync(join(DEMO, "postings.json"), "utf8")) as unknown[];
    engine.call("jobs_ingest", { connector: "demo-postings", records }, { surface: "internal" });
  } finally {
    engine.close();
  }
}

/** The whole fictional data set: settings, the legacy import and the postings. */
export function seedDemo(home: string): void {
  writeDemoConfig(home);
  importLegacyFixtures(home);
  ingestDemoPostings(home);
}

export async function callOk<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  expect(result.isError, content[0]?.text).toBeFalsy();
  expect(JSON.parse(content[0]?.text ?? "null")).toEqual(result.structuredContent);
  return result.structuredContent as T;
}

export async function callError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
}

/** Read the scenario's database directly, for assertions on what was stored. */
export function withDb<T>(home: string, fn: (db: Database) => T): T {
  const db = openRaw(join(home, "jobseeker.db"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export interface JobRow {
  job_id: string;
  title: string;
  company: string;
  score: number | null;
  score_method: string | null;
  sources: string[];
  vetoed: boolean;
  application_state: string | null;
}

export async function jobByCompany(client: Client, company: string): Promise<JobRow> {
  const found = await callOk<{ results: JobRow[] }>(client, "jobs_search", { query: company });
  const job = found.results.find((j) => j.company === company);
  expect(job, `no job from ${company}`).toBeDefined();
  return job as JobRow;
}
