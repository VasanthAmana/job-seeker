/**
 * Translated from tests/test_state_lock.py: two writers racing on the same
 * store must not lose each other's updates. The predecessor needed a file
 * lock around its load-mutate-replace cycle; the engine relies on SQLite
 * transactions (design 3, Concurrency), so the race is run for real: two
 * processes ingest into one database at the same time, and both writers'
 * jobs survive.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Engine } from "../../src/engine/engine.js";

const ENGINE = pathToFileURL(fileURLToPath(new URL("../../dist/engine/engine.js", import.meta.url))).href;

const WRITER = `
const { Engine } = await import(process.argv[1]);
const [home, tag] = [process.argv[2], process.argv[3]];
const engine = new Engine({ dataDir: home, env: {} });
for (let i = 0; i < 25; i++) {
  engine.call("jobs_ingest", {
    connector: "writer-" + tag,
    records: [{ title: "Title " + tag + " " + i, company: "Company " + tag, url: "https://" + tag + ".example/jobs/" + i }],
  }, { surface: "internal" });
}
engine.close();
`;

function writer(home: string, tag: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", WRITER, ENGINE, home, tag], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(code) : reject(new Error(`writer ${tag} exited ${code}: ${stderr}`))));
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-seeker-race-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("concurrent writers (test_state_lock)", () => {
  it("two processes ingesting into one database both keep every job", async () => {
    const home = join(dir, "home");
    // Create and migrate the database first, as setup does.
    const engine = new Engine({ dataDir: home, env: {} });
    engine.context();
    engine.close();

    await Promise.all([writer(home, "a"), writer(home, "b")]);

    const check = new Engine({ dataDir: home, env: {} });
    try {
      const status = check.call("status", {}, { surface: "internal" }) as { jobs: { total: number; sightings: number } };
      expect(status.jobs.total).toBe(50);
      expect(status.jobs.sightings).toBe(50);
    } finally {
      check.close();
    }
  });
});
