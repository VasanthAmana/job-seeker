/**
 * `job-seeker demo init` (execution plan section 3): a separate data
 * directory filled with fictional data, so a person can repeat a phase's
 * scenario by hand in a real client without touching a real account. Phase
 * 1's demo is the fictional legacy state plus three fictional postings,
 * one of which carries a prompt injection.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { EngineError } from "../core/context.js";
import { Engine } from "../engine/engine.js";
import { assertOutsideGit, defaultDataDir } from "../store/dataDir.js";
import type { Clock } from "../util/clock.js";

export const DEMO_FIXTURES = fileURLToPath(new URL("../../fixtures/demo/", import.meta.url));

export function defaultDemoDir(env: NodeJS.ProcessEnv = process.env): string {
  return `${defaultDataDir(env)}-demo`;
}

export function demoInit(dataDir: string, env: NodeJS.ProcessEnv, clock?: Clock) {
  assertOutsideGit(dataDir);
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0) {
    throw new EngineError(`${dataDir} already exists and is not empty; remove it first or choose another folder with --home`);
  }
  const engine = new Engine({ dataDir, env, clock });
  try {
    engine.context(); // creates the directory and the database
    engine.close();
    copyFileSync(join(DEMO_FIXTURES, "config.json"), join(dataDir, "config.json"));
    const imported = engine.call("legacy_import", { from: join(DEMO_FIXTURES, "legacy") }, { surface: "internal" }) as {
      totals: { jobs: number; applications: number };
    };
    const records = JSON.parse(readFileSync(join(DEMO_FIXTURES, "postings.json"), "utf8")) as unknown[];
    const ingested = engine.call("jobs_ingest", { connector: "demo-postings", records }, { surface: "internal" }) as {
      added: string[];
      merged: string[];
    };
    const status = engine.call("status", {}, { surface: "internal" }) as { jobs: { total: number }; applications: { total: number } };
    return {
      data_dir: dataDir,
      jobs: status.jobs.total,
      applications: status.applications.total,
      legacy_jobs: imported.totals.jobs,
      postings_added: ingested.added.length,
      postings_merged: ingested.merged.length,
    };
  } finally {
    engine.close();
  }
}
