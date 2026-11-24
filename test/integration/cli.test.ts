/**
 * The CLI as the user runs it: the built `job-seeker` against temporary
 * data directories. Covers the CLI cases of tests/test_rank_state.py (a
 * bad state file exits non-zero with a clear message), the repeatable
 * `import-legacy`, `secrets` with the encrypted-file backend (never the
 * real keychain), `setup --check`, `pipeline open --no-open` and
 * `demo init`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLI_PATH, FAKE_NOW, runCli } from "../mcp/harness.js";
import { DEMO } from "../mcp/fixtures.js";

let dir: string;
let home: string;
let keyEnv: Record<string, string>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-seeker-cli-"));
  home = join(dir, "home");
  keyEnv = { JOB_SEEKER_SECRETS_BACKEND: "file", JOB_SEEKER_SECRET_KEY_FILE: join(dir, "keys", "secret.key") };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("import-legacy", () => {
  it("imports, and a second run imports nothing new", () => {
    const first = runCli(home, ["import-legacy", "--from", join(DEMO, "legacy"), "--json"]);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout).totals).toEqual({ jobs: 14, applications: 9 });
    const second = runCli(home, ["import-legacy", "--from", join(DEMO, "legacy"), "--json"]);
    expect(JSON.parse(second.stdout).seen_jobs).toMatchObject({ imported: 0, already_imported: 8 });
  });

  it("exits non-zero with a clear message on a truncated seen_jobs.json", () => {
    mkdirSync(join(dir, "old", "state"), { recursive: true });
    writeFileSync(join(dir, "old", "state", "seen_jobs.json"), '{"seen": {truncated');
    const result = runCli(home, ["import-legacy", "--from", join(dir, "old")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not valid JSON/);
  });

  it("exits non-zero with a clear message on a missing seen_jobs.json", () => {
    const result = runCli(home, ["import-legacy", "--seen-jobs", join(dir, "missing_seen_jobs.json")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not found/);
  });

  it("refuses a data directory inside a git work tree", () => {
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    const result = runCli(join(dir, "repo", "data"), ["status"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/git work tree/);
  });
});

describe("secrets", () => {
  const withStdin = (args: string[], input: string) =>
    spawnSync(process.execPath, [CLI_PATH, ...args], {
      env: { ...getDefaultEnvironment(), JOB_SEEKER_HOME: home, JOB_SEEKER_NOW: FAKE_NOW, ...keyEnv },
      input,
      encoding: "utf8",
    });

  it("set reads the value from stdin; list shows names only; delete removes it", () => {
    const set = withStdin(["secrets", "set", "adzuna.app_key"], "fictional-secret-value\n");
    expect(set.status).toBe(0);
    expect(set.stdout).toMatch(/Stored adzuna.app_key in the encrypted secrets file/);
    const list = runCli(home, ["secrets", "list"], keyEnv);
    expect(list.stdout).toContain("adzuna.app_key  (file)");
    expect(list.stdout).not.toContain("fictional-secret-value");
    expect(runCli(home, ["secrets", "delete", "adzuna.app_key"], keyEnv).stdout).toMatch(/Deleted/);
    expect(runCli(home, ["secrets", "list"], keyEnv).stdout).toMatch(/No secrets stored/);
  });
});

describe("setup, pipeline and demo", () => {
  it("setup --check reports what is missing without changing anything", () => {
    const result = runCli(home, ["setup", "--check", "--no-clients", "--json"]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as { items: Array<{ part: string; ok: boolean }> };
    expect(report.items.find((i) => i.part === "data directory")?.ok).toBe(false);
    expect(existsSync(home)).toBe(false);
  });

  it("setup --yes --no-clients creates the data directory, then --check passes", () => {
    expect(runCli(home, ["setup", "--yes", "--no-clients"]).status).toBe(0);
    const check = runCli(home, ["setup", "--check", "--no-clients", "--json"]);
    expect(JSON.parse(check.stdout).ok).toBe(true);
  });

  it("pipeline open --no-open writes the page and prints its path", () => {
    runCli(home, ["import-legacy", "--from", join(DEMO, "legacy")]);
    const result = runCli(home, ["pipeline", "open", "--no-open"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(join(home, "reports", "pipeline.html"));
  });

  it("demo init fills a fresh data directory with fictional data, and refuses a used one", () => {
    const demo = join(dir, "demo");
    const result = runCli(home, ["demo", "init", "--home", demo, "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ jobs: 16, applications: 9, postings_added: 2, postings_merged: 1 });
    expect(runCli(home, ["demo", "init", "--home", demo]).stderr).toMatch(/already exists/);
  });
});
