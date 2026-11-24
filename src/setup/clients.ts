/**
 * The MCP configuration of Claude Desktop and Codex (design 12.6): where
 * each keeps it, what job-seeker's entry looks like, and how to change it
 * while leaving everything else in the file alone.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function claudeDesktopConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Claude", "claude_desktop_config.json");
}

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
}

export class ClientConfigError extends Error {
  override name = "ClientConfigError";
}

// ---------------------------------------------------------------- Claude Desktop (JSON)

export interface JsonEdit {
  before: unknown;
  after: ServerCommand;
  text: string;
  changed: boolean;
}

/** Claude Desktop's file with job-seeker's server entry set; other servers are untouched. */
export function editClaudeConfig(current: string | null, server: ServerCommand): JsonEdit {
  let doc: Record<string, unknown> = {};
  if (current !== null && current.trim()) {
    try {
      doc = JSON.parse(current) as Record<string, unknown>;
    } catch (error) {
      throw new ClientConfigError(`it is not valid JSON (${(error as Error).message}); fix or move it, then run setup again`);
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new ClientConfigError("its top level is not a JSON object");
  }
  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
  if (typeof servers !== "object" || Array.isArray(servers)) throw new ClientConfigError("its mcpServers is not an object");
  const before = servers["job-seeker"] ?? null;
  const entry: Record<string, unknown> = { command: server.command, args: server.args };
  if (Object.keys(server.env).length) entry.env = server.env;
  const changed = JSON.stringify(before) !== JSON.stringify(entry);
  const next = { ...doc, mcpServers: { ...servers, "job-seeker": entry } };
  return { before, after: server, text: `${JSON.stringify(next, null, 2)}\n`, changed };
}

export function readClaudeEntry(current: string | null): unknown {
  if (!current) return null;
  try {
    const doc = JSON.parse(current) as { mcpServers?: Record<string, unknown> };
    return doc.mcpServers?.["job-seeker"] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Codex (TOML)

const TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:job-seeker|"job-seeker")\s*(?:\.\s*env\s*)?\]\s*(?:#.*)?$/;
const HEADER = /^\s*\[/;

/** A TOML basic string: JSON's escaping is valid TOML for these values. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexBlock(server: ServerCommand): string {
  const lines = [
    "[mcp_servers.job-seeker]",
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(", ")}]`,
  ];
  if (Object.keys(server.env).length) {
    lines.push("", "[mcp_servers.job-seeker.env]");
    for (const [key, value] of Object.entries(server.env)) lines.push(`${key} = ${tomlString(value)}`);
  }
  return lines.join("\n");
}

/** The current job-seeker tables in a Codex config, or null. */
export function readCodexBlock(current: string | null): string | null {
  if (!current) return null;
  const lines = current.split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (TABLE.test(line)) inside = true;
    else if (HEADER.test(line)) inside = false;
    if (inside) out.push(line);
  }
  const text = out.join("\n").trim();
  return text || null;
}

/** Codex's file with job-seeker's tables replaced; every other line is kept. */
export function editCodexConfig(current: string | null, server: ServerCommand): { before: string | null; after: string; text: string; changed: boolean } {
  const block = codexBlock(server);
  const before = readCodexBlock(current);
  const kept: string[] = [];
  let inside = false;
  for (const line of (current ?? "").split(/\r?\n/)) {
    if (TABLE.test(line)) {
      inside = true;
      continue;
    }
    if (inside && HEADER.test(line)) inside = false;
    if (!inside) kept.push(line);
  }
  const head = kept.join("\n").replace(/\s+$/, "");
  const text = `${head ? `${head}\n\n` : ""}${block}\n`;
  return { before, after: block, text, changed: before !== block };
}
