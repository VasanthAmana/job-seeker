#!/usr/bin/env node
import "./warnings.js";

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Engine } from "./engine/engine.js";
import { serveStdio } from "./mcp/server.js";
import { defaultDemoDir, demoInit } from "./setup/demo.js";
import { runCheck, runSetup, serverEnv, type SetupIO } from "./setup/setup.js";
import { resolveDataDir } from "./store/dataDir.js";
import { clockFromEnv } from "./util/clock.js";
import { VERSION } from "./version.js";

const USAGE = `job-seeker ${VERSION}

Usage: job-seeker <command> [options]

Commands:
  mcp                       Serve MCP over stdio (the server Claude Desktop and Codex launch)
  setup [--check] [--yes]   Create the data directory and config.json, and add job-seeker
                            to Claude Desktop and Codex (showing each change, keeping backups)
  doctor                    Same as setup --check
  status [--json]           Show job-seeker's state
  import-legacy --from DIR  Import the predecessor's state/seen_jobs.json, state/last_run.json
                            and tracker.csv (repeatable; also --seen-jobs, --last-run, --tracker)
  pipeline open [--no-open] Regenerate the pipeline page and open it
  secrets set NAME          Store a secret (reads the value from the terminal or stdin)
  secrets list              List stored secret names (never values)
  secrets delete NAME       Delete a stored secret
  demo init [--home DIR]    Create a separate data directory with fictional demo data
  --version                 Print the version
  --help                    Show this help

The data directory is JOB_SEEKER_HOME when set, else the platform default.
`;

const CLI_PATH = fileURLToPath(import.meta.url);

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function engine(env: NodeJS.ProcessEnv = process.env): Engine {
  return new Engine({ dataDir: resolveDataDir(env), env });
}

function call(name: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): unknown {
  const e = engine(env);
  try {
    return e.call(name, input, { surface: "cli" });
  } finally {
    e.close();
  }
}

function setupIO(yes: boolean): SetupIO & { close(): void } {
  const interactive = Boolean(process.stdin.isTTY);
  const rl = interactive && !yes ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  return {
    log: out,
    async ask(question: string) {
      if (yes) {
        out(`${question} yes (--yes)`);
        return true;
      }
      if (!rl) {
        out(`${question} no (not a terminal; run with --yes to accept every step)`);
        return false;
      }
      const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
    close() {
      rl?.close();
    },
  };
}

async function setupCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      check: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      "claude-config": { type: "string" },
      "codex-config": { type: "string" },
      "no-clients": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const env = process.env;
  const dataDir = resolveDataDir(env);
  const io = setupIO(values.yes);
  const options = {
    dataDir,
    env,
    clock: clockFromEnv(env),
    server: { command: process.execPath, args: [CLI_PATH, "mcp"], env: serverEnv(dataDir, env) },
    claudeConfig: values["claude-config"] ?? null,
    codexConfig: values["codex-config"] ?? null,
    noClients: values["no-clients"],
    io,
  };
  try {
    if (values.check) {
      const items = runCheck(options);
      if (values.json) out(JSON.stringify({ ok: items.every((i) => i.ok), items }, null, 2));
      else for (const item of items) out(`${item.ok ? "ok  " : "todo"}  ${item.part}: ${item.detail}`);
      return items.every((i) => i.ok) ? 0 : 1;
    }
    return await runSetup(options);
  } finally {
    io.close();
  }
}

function statusCommand(args: string[]): number {
  const { values } = parseArgs({ args, options: { json: { type: "boolean", default: false } }, strict: true });
  const status = call("status", {}) as {
    version: string;
    data_dir: string;
    jobs: { total: number; by_status: Record<string, number> };
    applications: { total: number; by_state: Record<string, number> };
    profile: { current_version: number | null; sources: number };
    waiting_for_you: Array<{ reason: string; open_what: string }>;
    pending_approvals: number;
    service: { state: string };
  };
  if (values.json) {
    out(JSON.stringify(status, null, 2));
    return 0;
  }
  const by = (record: Record<string, number>) => Object.entries(record).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
  out(`job-seeker ${status.version}`);
  out(`Data directory: ${status.data_dir}`);
  out(`Jobs: ${status.jobs.total} (${by(status.jobs.by_status)})`);
  out(`Applications: ${status.applications.total} (${by(status.applications.by_state)})`);
  out(`Profile: ${status.profile.current_version === null ? "no version yet" : `version ${status.profile.current_version}`}, ${status.profile.sources} sources`);
  out(`Waiting for you: ${status.waiting_for_you.length ? status.waiting_for_you.map((s) => `${s.reason} (${s.open_what})`).join("; ") : "nothing"}`);
  out(`Pending approvals: ${status.pending_approvals}`);
  out(`Background service: ${status.service.state}`);
  return 0;
}

function importCommand(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      "seen-jobs": { type: "string" },
      "last-run": { type: "string" },
      tracker: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const input: Record<string, unknown> = {};
  if (values.from) input.from = values.from;
  if (values["seen-jobs"]) input.seen_jobs = values["seen-jobs"];
  if (values["last-run"]) input.last_run = values["last-run"];
  if (values.tracker) input.tracker = values.tracker;
  const result = call("legacy_import", input) as {
    seen_jobs: { read: number; imported: number; already_imported: number; merged_duplicates: number; invalid?: number };
    tracker: { read: number; imported: number; already_imported: number; matched_jobs: number; new_jobs: number; unmapped_statuses: string[] };
    shortlist: { read: number; imported: number; already_imported: number; skipped_with_application: number; unknown_keys: number };
    totals: { jobs: number; applications: number };
  };
  if (values.json) {
    out(JSON.stringify(result, null, 2));
    return 0;
  }
  const s = result.seen_jobs;
  const t = result.tracker;
  const l = result.shortlist;
  out(`seen_jobs.json: ${s.read} read, ${s.imported} new jobs, ${s.merged_duplicates} merged into existing jobs, ${s.already_imported} already imported${s.invalid ? `, ${s.invalid} without a title or company` : ""}`);
  out(`tracker.csv: ${t.read} rows read, ${t.imported} imported (${t.matched_jobs} matched to jobs, ${t.new_jobs} new jobs), ${t.already_imported} already imported`);
  if (t.unmapped_statuses.length) out(`  statuses recorded as found: ${t.unmapped_statuses.join(", ")}`);
  out(`last_run.json shortlist: ${l.read} read, ${l.imported} shortlisted, ${l.skipped_with_application} already had an application, ${l.already_imported} already imported`);
  out(`Now: ${result.totals.jobs} jobs, ${result.totals.applications} applications.`);
  return 0;
}

function openFile(path: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [path]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", path]] : ["xdg-open", [path]];
  spawn(command as string, args as string[], { stdio: "ignore", detached: true }).unref();
}

function pipelineCommand(args: string[]): number {
  const [sub, ...rest] = args;
  if (sub !== "open") {
    process.stderr.write("job-seeker: usage: job-seeker pipeline open [--no-open]\n");
    return 2;
  }
  const { values } = parseArgs({ args: rest, options: { "no-open": { type: "boolean", default: false } }, strict: true });
  const result = call("pipeline_page", {}) as { path: string };
  out(result.path);
  if (!values["no-open"]) openFile(result.path);
  return 0;
}

async function readSecretValue(name: string): Promise<string> {
  if (process.stdin.isTTY) {
    process.stdout.write(`Value for ${name} (not shown): `);
    return new Promise((resolve, reject) => {
      const stdin = process.stdin;
      let value = "";
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off("data", onData);
            process.stdout.write("\n");
            resolve(value);
            return;
          }
          if (ch === "\u0003") {
            stdin.setRawMode(false);
            reject(new Error("cancelled"));
            return;
          }
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else value += ch;
        }
      };
      stdin.on("data", onData);
    });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function secretsCommand(args: string[]): Promise<number> {
  const [sub, name] = args;
  if (sub === "list") {
    const result = call("secrets_list", {}) as { results: Array<{ name: string; backend: string }> };
    if (!result.results.length) out("No secrets stored.");
    for (const r of result.results) out(`${r.name}  (${r.backend})`);
    return 0;
  }
  if ((sub === "set" || sub === "delete") && name) {
    if (sub === "delete") {
      const result = call("secrets_delete", { name }) as { deleted: boolean };
      out(result.deleted ? `Deleted ${name}.` : `No secret named ${name}.`);
      return result.deleted ? 0 : 1;
    }
    const value = await readSecretValue(name);
    const result = call("secrets_set", { name, value }) as { backend: string; replaced: boolean };
    out(`${result.replaced ? "Replaced" : "Stored"} ${name} in the ${result.backend === "keychain" ? "OS keychain" : "encrypted secrets file"}.`);
    return 0;
  }
  process.stderr.write("job-seeker: usage: job-seeker secrets set NAME | secrets list | secrets delete NAME\n");
  return 2;
}

function demoCommand(args: string[]): number {
  const [sub, ...rest] = args;
  if (sub !== "init") {
    process.stderr.write("job-seeker: usage: job-seeker demo init [--home DIR]\n");
    return 2;
  }
  const { values } = parseArgs({ args: rest, options: { home: { type: "string" }, json: { type: "boolean", default: false } }, strict: true });
  const dir = values.home ? resolveDataDir({ JOB_SEEKER_HOME: values.home }) : defaultDemoDir();
  const result = demoInit(dir, process.env);
  if (values.json) {
    out(JSON.stringify(result, null, 2));
    return 0;
  }
  out(`Demo data directory: ${result.data_dir}`);
  out(`${result.jobs} fictional jobs, ${result.applications} applications.`);
  out(`To point Claude Desktop and Codex at it: JOB_SEEKER_HOME="${result.data_dir}" job-seeker setup`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "mcp":
      await serveStdio();
      return 0;
    case "setup":
      return setupCommand(rest);
    case "doctor":
      return setupCommand(["--check", ...rest]);
    case "status":
      return statusCommand(rest);
    case "import-legacy":
      return importCommand(rest);
    case "pipeline":
      return pipelineCommand(rest);
    case "secrets":
      return secretsCommand(rest);
    case "demo":
      return demoCommand(rest);
    case "--version":
    case "-v":
      out(VERSION);
      return 0;
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    case undefined:
      process.stderr.write(USAGE);
      return 2;
    default:
      process.stderr.write(`job-seeker: unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`job-seeker: ${message}\n`);
    process.exitCode = 1;
  },
);
