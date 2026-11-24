/**
 * Spec for settings, translated from tests/test_config.py (17). The
 * predecessor's Gmail account cases, repository-relative paths and the
 * JOBSEEK_CONFIG override change by design: mailboxes become connector
 * bindings in phase 8, state lives in the database, and config.json sits in
 * the data directory (design 5.1). They are rewritten here as the cases
 * that replace them.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigError, DEFAULTS, loadSettings, loadSettingsFile } from "./settings.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-seeker-settings-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (value: unknown) => {
  const path = join(dir, "config.json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
};

describe("settings (test_config)", () => {
  it("a missing file returns the defaults, as a copy", () => {
    const settings = loadSettingsFile(join(dir, "nope.json"));
    expect(settings).toEqual(DEFAULTS);
    expect(settings).not.toBe(DEFAULTS);
    settings.ranking.weights.domain = 9;
    expect(DEFAULTS.ranking.weights.domain).toBe(0.3);
  });

  it("a partial override merges, not replaces", () => {
    const settings = loadSettingsFile(write({ ranking: { top_n: 3 } }));
    expect(settings.ranking.top_n).toBe(3);
    expect(settings.ranking.weights).toEqual(DEFAULTS.ranking.weights);
    expect(settings.ai).toEqual(DEFAULTS.ai);
  });

  it("a nested override merges one level deep", () => {
    const settings = loadSettingsFile(write({ ranking: { rules: { titles: ["AI strategy"] } } }));
    expect(settings.ranking.rules.titles).toEqual(["AI strategy"]);
    expect(settings.ranking.rules.weights).toEqual(DEFAULTS.ranking.rules.weights);
    expect(settings.ranking.candidate_limit).toBe(DEFAULTS.ranking.candidate_limit);
  });

  it("malformed JSON is an error", () => {
    expect(() => loadSettingsFile(write("{not json"))).toThrow(ConfigError);
  });

  it("a non-object top level is an error", () => {
    expect(() => loadSettingsFile(write(["not", "an", "object"]))).toThrow(ConfigError);
  });

  it("a non-numeric weight is an error", () => {
    expect(() => loadSettingsFile(write({ ranking: { weights: { domain: "a lot" } } }))).toThrow(ConfigError);
  });

  it("a weights value that is not an object is an error", () => {
    expect(() => loadSettingsFile(write({ ranking: { weights: 3 } }))).toThrow(ConfigError);
  });

  it("a non-positive top_n is an error", () => {
    expect(() => loadSettingsFile(write({ ranking: { top_n: 0 } }))).toThrow(ConfigError);
  });

  it("rule lists must be arrays of strings", () => {
    expect(() => loadSettingsFile(write({ ranking: { rules: { exclude: "engineer" } } }))).toThrow(ConfigError);
  });

  it("an unknown secrets backend is an error", () => {
    expect(() => loadSettingsFile(write({ secrets: { backend: "plaintext" } }))).toThrow(ConfigError);
  });

  it("loadSettings reads config.json from the data directory", () => {
    write({ ranking: { top_n: 7 } });
    expect(loadSettings(dir).ranking.top_n).toBe(7);
  });

  it("the shipped demo config is valid and loadable", () => {
    const demo = fileURLToPath(new URL("../../fixtures/demo/config.json", import.meta.url));
    const settings = loadSettingsFile(demo);
    expect(settings.ranking.top_n).toBeGreaterThan(0);
    expect(settings.ranking.rules.titles.length).toBeGreaterThan(0);
  });
});
