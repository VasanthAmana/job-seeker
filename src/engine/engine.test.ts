/**
 * The Engine API contract (design 4): one schema file per operation and
 * one operation per schema file, generated types that match the schemas,
 * argument validation that names what is wrong, and a lazily opened data
 * directory, so a bad config.json or database never stops a server from
 * starting (the lazy-config cases of tests/test_rank_state.py).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngineError } from "../core/context.js";
import { fixedClock } from "../util/clock.js";
import { Engine } from "./engine.js";
import { OPERATIONS } from "./operations.js";
import { schemaNames } from "./schemas.js";

let dir: string;
let engine: Engine;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-seeker-engine-"));
  engine = new Engine({ dataDir: join(dir, "home"), clock: fixedClock("2026-11-02T09:00:00Z"), env: { VITEST: "true" } });
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the operation table", () => {
  it("has exactly one schema file per operation", () => {
    expect(OPERATIONS.map((o) => o.name).sort()).toEqual(schemaNames());
  });

  it("keeps secrets off MCP", () => {
    const mcp = engine.operations("mcp").map((o) => o.name);
    expect(mcp.filter((n) => n.startsWith("secrets"))).toEqual([]);
    expect(mcp).not.toContain("legacy_import");
    expect(mcp).not.toContain("jobs_ingest");
  });

  it("has generated types that match the schemas", async () => {
    const { generate } = (await import("../../scripts/gen-engine-types.mjs")) as { generate(): Promise<string> };
    const current = readFileSync(fileURLToPath(new URL("./types.gen.ts", import.meta.url)), "utf8");
    expect(current).toBe(await generate());
  });
});

describe("calls", () => {
  it("names an unknown argument and a missing one", () => {
    expect(() => engine.call("status", { verbose: true }, { surface: "mcp" })).toThrow("status: unknown argument: verbose");
    expect(() => engine.call("job_get", {}, { surface: "mcp" })).toThrow("job_get: missing argument: job_id");
  });

  it("refuses an operation outside the caller's surface", () => {
    expect(() => engine.call("secrets_list", {}, { surface: "mcp" })).toThrow("unknown tool: secrets_list");
  });

  it("feeds events in cursor order", () => {
    engine.call("profile_add_statement", { text: "I lead a fictional team." }, { surface: "mcp" });
    const feed = engine.call("events_list", {}, { surface: "internal" }) as { results: Array<{ cursor: number; type: string }>; next_cursor: number };
    expect(feed.results.map((e) => e.type)).toContain("profile.source_imported");
    const later = engine.call("events_list", { after: feed.next_cursor }, { surface: "internal" }) as { results: unknown[] };
    expect(later.results).toEqual([]);
  });
});

describe("a data directory that cannot be opened", () => {
  it("a malformed config.json is a clear error per call, not a crash at start", () => {
    engine.context();
    engine.close();
    writeFileSync(join(dir, "home", "config.json"), JSON.stringify({ ranking: { weights: { domain: "a lot" } } }));
    const fresh = new Engine({ dataDir: join(dir, "home"), env: { VITEST: "true" } });
    expect(() => fresh.call("status", {}, { surface: "mcp" })).toThrow(EngineError);
    expect(() => fresh.call("status", {}, { surface: "mcp" })).toThrow(/ranking\.weights\.domain must be a number/);
    fresh.close();
  });
});
