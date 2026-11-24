/**
 * `job-seeker setup`, first cut (design 12.6, execution plan section 6):
 * creates the data directory and `config.json`, refusing one inside a git
 * work tree, and writes the MCP configuration for Claude Desktop and Codex,
 * showing each change, asking before it, and keeping a backup of each file.
 * `setup --check` reports the state of each part and changes nothing.
 *
 * Later phases add Handyman, Tectonic, the LaunchAgent, the AI adapter and
 * the default schedules to the same command.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_FILE, ConfigError, loadSettings } from "../core/settings.js";
import { assertOutsideGit, DataDirError, defaultDataDir } from "../store/dataDir.js";
import { NewerDatabaseError, openDatabase, LATEST_SCHEMA_VERSION } from "../store/db.js";
import type { Clock } from "../util/clock.js";
import {
  claudeDesktopConfigPath,
  ClientConfigError,
  codexConfigPath,
  editClaudeConfig,
  editCodexConfig,
  readClaudeEntry,
  readCodexBlock,
  type ServerCommand,
} from "./clients.js";

export const CONFIG_TEMPLATE = {
  _comment:
    "job-seeker settings. Until criteria sets arrive, ranking.rules is what the rule ranker scores jobs against: target titles, keywords, domains, seniority levels (director, head, vp, chief, manager, senior), title terms to exclude, locations (use \"Remote\" for remote work) and a salary floor.",
  ranking: {
    top_n: 5,
    rules: {
      titles: [],
      keywords: [],
      domains: [],
      seniority: [],
      exclude: [],
      locations: [],
      salary_min: null,
    },
  },
};

export interface SetupIO {
  log(line: string): void;
  /** Ask a yes/no question; resolves true for yes. */
  ask(question: string): Promise<boolean>;
}

export interface SetupOptions {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  /** The command clients should run to start `job-seeker mcp`. */
  server: ServerCommand;
  /** Override the client configuration files (tests and unusual installs). */
  claudeConfig?: string | null;
  codexConfig?: string | null;
  /** Skip the client configuration step. */
  noClients?: boolean;
  io: SetupIO;
}

function stamp(clock: Clock): string {
  return clock.now().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** The client config paths, unless this is a test run without explicit paths. */
function clientPaths(options: SetupOptions): { claude: string | null; codex: string | null } {
  if (options.noClients) return { claude: null, codex: null };
  const testRun = Boolean(options.env.VITEST);
  return {
    claude: options.claudeConfig ?? (testRun ? null : claudeDesktopConfigPath(options.env)),
    codex: options.codexConfig ?? (testRun ? null : codexConfigPath(options.env)),
  };
}

/** The env a client must pass so the server finds this data directory. */
export function serverEnv(dataDir: string, env: NodeJS.ProcessEnv): Record<string, string> {
  return dataDir === defaultDataDir(env) ? {} : { JOB_SEEKER_HOME: dataDir };
}

function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function backup(path: string, clock: Clock): string | null {
  if (!existsSync(path)) return null;
  const target = `${path}.job-seeker-backup-${stamp(clock)}`;
  copyFileSync(path, target);
  return target;
}

async function configureClient(
  options: SetupOptions,
  label: string,
  path: string,
  edit: (current: string | null) => { before: unknown; text: string; changed: boolean; shown: string },
): Promise<"configured" | "unchanged" | "declined" | "failed"> {
  const { io } = options;
  let plan: ReturnType<typeof edit>;
  try {
    plan = edit(readOrNull(path));
  } catch (error) {
    io.log(`  ${label}: not changed - ${path}: ${(error as Error).message}`);
    return "failed";
  }
  if (!plan.changed) {
    io.log(`  ${label}: already configured (${path})`);
    return "unchanged";
  }
  io.log(`  ${label}: ${path}`);
  io.log(`    now:   ${plan.before === null ? "(no job-seeker entry)" : JSON.stringify(plan.before)}`);
  for (const line of plan.shown.split("\n")) io.log(`    new:   ${line}`);
  if (!(await io.ask(`Write job-seeker's MCP entry into ${label}'s configuration?`))) {
    io.log(`  ${label}: left unchanged`);
    return "declined";
  }
  mkdirSync(dirname(path), { recursive: true });
  const saved = backup(path, options.clock);
  writeFileSync(path, plan.text, "utf8");
  io.log(`  ${label}: written${saved ? `; the previous file is kept as ${saved}` : ""}`);
  return "configured";
}

export async function runSetup(options: SetupOptions): Promise<number> {
  const { io, dataDir } = options;
  io.log(`job-seeker setup`);
  io.log(`Data directory: ${dataDir}`);
  try {
    assertOutsideGit(dataDir);
  } catch (error) {
    io.log(`  ${(error as DataDirError).message}`);
    return 1;
  }

  if (!existsSync(dataDir)) {
    if (!(await io.ask(`Create the data directory ${dataDir}?`))) {
      io.log("  Nothing changed.");
      return 1;
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    io.log("  created");
  } else {
    io.log("  exists");
  }

  const configPath = join(dataDir, CONFIG_FILE);
  if (!existsSync(configPath)) {
    if (await io.ask(`Create ${CONFIG_FILE} with the default settings?`)) {
      writeFileSync(configPath, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      io.log(`  ${CONFIG_FILE}: created; set ranking.rules to describe the jobs you want`);
    }
  } else {
    try {
      loadSettings(dataDir);
      io.log(`  ${CONFIG_FILE}: valid`);
    } catch (error) {
      io.log(`  ${CONFIG_FILE}: ${(error as ConfigError).message}`);
      return 1;
    }
  }

  try {
    const { db, previousVersion, backupPath } = openDatabase({ dataDir, clock: options.clock });
    db.close();
    io.log(
      previousVersion === LATEST_SCHEMA_VERSION
        ? `  database: schema version ${LATEST_SCHEMA_VERSION}`
        : `  database: migrated from version ${previousVersion} to ${LATEST_SCHEMA_VERSION}${backupPath ? ` (backup: ${backupPath})` : ""}`,
    );
  } catch (error) {
    io.log(`  database: ${(error as Error).message}`);
    return 1;
  }

  const paths = clientPaths(options);
  let failed = false;
  if (paths.claude || paths.codex) io.log("MCP clients:");
  if (paths.claude) {
    const result = await configureClient(options, "Claude Desktop", paths.claude, (current) => {
      const edit = editClaudeConfig(current, options.server);
      return { ...edit, shown: JSON.stringify({ "job-seeker": JSON.parse(edit.text).mcpServers["job-seeker"] }) };
    });
    failed ||= result === "failed";
    if (result === "configured") io.log("  Restart Claude Desktop so it starts job-seeker.");
  }
  if (paths.codex) {
    const result = await configureClient(options, "Codex", paths.codex, (current) => {
      const edit = editCodexConfig(current, options.server);
      return { ...edit, shown: edit.after };
    });
    failed ||= result === "failed";
  }
  io.log(failed ? "Setup finished with problems (see above)." : "Setup finished. Run `job-seeker setup --check` at any time to see the state.");
  return failed ? 1 : 0;
}

export interface CheckItem {
  part: string;
  ok: boolean;
  detail: string;
}

export function runCheck(options: SetupOptions): CheckItem[] {
  const items: CheckItem[] = [];
  const { dataDir, env } = options;
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  items.push({
    part: "node",
    ok: major > 22 || (major === 22 && minor >= 13),
    detail: `Node.js ${process.versions.node} (job-seeker needs 22.13 or later)`,
  });
  let dirOk = true;
  try {
    assertOutsideGit(dataDir);
  } catch (error) {
    dirOk = false;
    items.push({ part: "data directory", ok: false, detail: (error as Error).message });
  }
  if (dirOk) {
    items.push({
      part: "data directory",
      ok: existsSync(dataDir),
      detail: existsSync(dataDir) ? dataDir : `${dataDir} does not exist yet: run job-seeker setup`,
    });
  }
  const configPath = join(dataDir, CONFIG_FILE);
  if (!existsSync(configPath)) {
    items.push({ part: "config.json", ok: false, detail: `${configPath} does not exist yet: run job-seeker setup` });
  } else {
    try {
      loadSettings(dataDir);
      items.push({ part: "config.json", ok: true, detail: configPath });
    } catch (error) {
      items.push({ part: "config.json", ok: false, detail: (error as Error).message });
    }
  }
  if (dirOk && existsSync(join(dataDir, "jobseeker.db"))) {
    try {
      const { db, previousVersion } = openDatabase({ dataDir, clock: options.clock, readOnly: true });
      db.close();
      items.push({
        part: "database",
        ok: previousVersion === LATEST_SCHEMA_VERSION,
        detail:
          previousVersion === LATEST_SCHEMA_VERSION
            ? `schema version ${previousVersion}`
            : `schema version ${previousVersion}; job-seeker migrates it to ${LATEST_SCHEMA_VERSION} on next use, after a backup`,
      });
    } catch (error) {
      items.push({ part: "database", ok: false, detail: error instanceof NewerDatabaseError ? error.message : (error as Error).message });
    }
  } else if (dirOk) {
    items.push({ part: "database", ok: false, detail: "no database yet: run job-seeker setup" });
  }
  const paths = clientPaths(options);
  const want = JSON.stringify({ command: options.server.command, args: options.server.args, ...(Object.keys(options.server.env).length ? { env: options.server.env } : {}) });
  if (paths.claude) {
    const entry = readClaudeEntry(readOrNull(paths.claude));
    items.push({
      part: "Claude Desktop",
      ok: entry !== null && JSON.stringify(entry) === want,
      detail:
        entry === null
          ? `no job-seeker entry in ${paths.claude}: run job-seeker setup`
          : JSON.stringify(entry) === want
            ? `configured in ${paths.claude}`
            : `job-seeker entry in ${paths.claude} differs from this install: run job-seeker setup`,
    });
  }
  if (paths.codex) {
    const block = readCodexBlock(readOrNull(paths.codex));
    const expected = editCodexConfig(null, options.server).after;
    items.push({
      part: "Codex",
      ok: block === expected,
      detail:
        block === null
          ? `no job-seeker entry in ${paths.codex}: run job-seeker setup`
          : block === expected
            ? `configured in ${paths.codex}`
            : `job-seeker entry in ${paths.codex} differs from this install: run job-seeker setup`,
    });
  }
  items.push({
    part: "secrets",
    ok: true,
    detail:
      env.JOB_SEEKER_SECRETS_BACKEND === "file"
        ? "encrypted file (JOB_SEEKER_SECRETS_BACKEND=file)"
        : "OS keychain when available, else an encrypted file whose key sits outside the data directory",
  });
  return items;
}

export { ClientConfigError, serverEnv as clientEnv };
