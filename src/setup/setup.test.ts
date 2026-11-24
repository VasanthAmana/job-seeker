/**
 * `job-seeker setup` and `setup --check` (design 12.6). Every test points
 * at temporary client configuration files: the user's real Claude Desktop
 * and Codex files are never read or written.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "../util/clock.js";
import { codexBlock, editClaudeConfig, editCodexConfig, readCodexBlock } from "./clients.js";
import { runCheck, runSetup, type SetupOptions } from "./setup.js";

const SERVER = { command: "/opt/node/bin/node", args: ["/opt/job-seeker/dist/cli.js", "mcp"], env: { JOB_SEEKER_HOME: "/tmp/js-demo" } };

let dir: string;
let lines: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-seeker-setup-"));
  lines = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function options(overrides: Partial<SetupOptions> = {}, answer = true): SetupOptions {
  return {
    dataDir: join(dir, "data"),
    env: { VITEST: "true" },
    clock: fixedClock("2026-11-02T09:00:00Z"),
    server: SERVER,
    claudeConfig: join(dir, "claude", "claude_desktop_config.json"),
    codexConfig: join(dir, "codex", "config.toml"),
    io: { log: (line) => lines.push(line), ask: async () => answer },
    ...overrides,
  };
}

describe("client configuration edits", () => {
  it("Claude Desktop: adds job-seeker and keeps every other server", () => {
    const current = JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" });
    const edit = editClaudeConfig(current, SERVER);
    expect(edit.changed).toBe(true);
    expect(JSON.parse(edit.text)).toEqual({
      mcpServers: { other: { command: "x" }, "job-seeker": { command: SERVER.command, args: SERVER.args, env: SERVER.env } },
      theme: "dark",
    });
    expect(editClaudeConfig(edit.text, SERVER).changed).toBe(false);
    expect(() => editClaudeConfig("{oops", SERVER)).toThrow(/not valid JSON/);
  });

  it("Codex: replaces only job-seeker's tables", () => {
    const current = '[model]\nname = "x"\n\n[mcp_servers.job-seeker]\ncommand = "old"\n\n[mcp_servers.job-seeker.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "y"\n';
    const edit = editCodexConfig(current, SERVER);
    expect(edit.before).toContain('command = "old"');
    expect(edit.text).toContain('[model]\nname = "x"');
    expect(edit.text).toContain('[mcp_servers.other]\ncommand = "y"');
    expect(edit.text).not.toContain('"old"');
    expect(readCodexBlock(edit.text)).toBe(codexBlock(SERVER));
    expect(editCodexConfig(edit.text, SERVER).changed).toBe(false);
    expect(codexBlock({ ...SERVER, command: "C:\\Program Files\\node.exe" })).toContain('command = "C:\\\\Program Files\\\\node.exe"');
  });
});

describe("setup", () => {
  it("creates the data directory, config.json and the database, and configures both clients", async () => {
    expect(await runSetup(options())).toBe(0);
    expect(existsSync(join(dir, "data", "config.json"))).toBe(true);
    expect(existsSync(join(dir, "data", "jobseeker.db"))).toBe(true);
    const claude = JSON.parse(readFileSync(join(dir, "claude", "claude_desktop_config.json"), "utf8"));
    expect(claude.mcpServers["job-seeker"].args).toEqual(SERVER.args);
    expect(readFileSync(join(dir, "codex", "config.toml"), "utf8")).toContain("[mcp_servers.job-seeker]");
    expect(lines.join("\n")).toMatch(/Restart Claude Desktop/);
  });

  it("shows each change and keeps a backup of each file it changes", async () => {
    mkdirSync(join(dir, "claude"));
    writeFileSync(join(dir, "claude", "claude_desktop_config.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    await runSetup(options());
    const backups = readdirSync(join(dir, "claude")).filter((f) => f.includes(".job-seeker-backup-"));
    expect(backups).toEqual(["claude_desktop_config.json.job-seeker-backup-20261102T090000Z"]);
    expect(lines.some((l) => l.includes("new:") && l.includes("job-seeker"))).toBe(true);
    expect(lines.some((l) => l.includes("now:   (no job-seeker entry)"))).toBe(true);
  });

  it("is idempotent", async () => {
    await runSetup(options());
    lines = [];
    expect(await runSetup(options())).toBe(0);
    expect(lines.filter((l) => l.includes("already configured"))).toHaveLength(2);
  });

  it("changes nothing the user declines", async () => {
    expect(await runSetup(options({}, false))).toBe(1);
    expect(existsSync(join(dir, "data"))).toBe(false);
    expect(existsSync(join(dir, "claude"))).toBe(false);
  });

  it("leaves a client file it cannot parse alone", async () => {
    mkdirSync(join(dir, "claude"));
    writeFileSync(join(dir, "claude", "claude_desktop_config.json"), "{not json");
    expect(await runSetup(options())).toBe(1);
    expect(readFileSync(join(dir, "claude", "claude_desktop_config.json"), "utf8")).toBe("{not json");
  });

  it("refuses a data directory inside a git work tree", async () => {
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    expect(await runSetup(options({ dataDir: join(dir, "repo", "data") }))).toBe(1);
    expect(lines.join("\n")).toMatch(/git work tree/);
  });

  it("never reaches for the real client files from a test without explicit paths", async () => {
    await runSetup(options({ claudeConfig: null, codexConfig: null }));
    expect(lines.join("\n")).not.toMatch(/Claude Desktop|Codex/);
  });
});

describe("setup --check", () => {
  it("reports what is missing, then that everything is in place", async () => {
    const before = runCheck(options());
    expect(before.find((i) => i.part === "data directory")?.ok).toBe(false);
    expect(before.find((i) => i.part === "Claude Desktop")?.detail).toMatch(/run job-seeker setup/);
    await runSetup(options());
    const after = runCheck(options());
    for (const part of ["data directory", "config.json", "database", "Claude Desktop", "Codex"]) {
      expect(after.find((i) => i.part === part)?.ok, part).toBe(true);
    }
  });
});
