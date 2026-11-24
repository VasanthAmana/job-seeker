/**
 * The MCP acceptance harness (execution plan section 3), built in phase 0 and
 * used by every later phase.
 *
 * It spawns the real `job-seeker mcp` entry point (the compiled
 * `dist/cli.js`) over stdio with the official MCP TypeScript SDK client -
 * exactly as Claude Desktop and Codex launch it - and points
 * `JOB_SEEKER_HOME` at a fresh temporary directory so a scenario never
 * touches the user's data.
 *
 * Later phases add their fakes (fake clock, fake AI adapter, fake notifier,
 * fake Handyman endpoint, scripted Handyman, service-in-the-loop) to
 * {@link HarnessOptions} when they introduce them.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

/** The built CLI the harness spawns. Tests build first (`npm run pretest`). */
export const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

/**
 * How the test client presents itself. Phase 3's approval scenarios run
 * twice: once as a client that supports elicitation (answering with a
 * scripted reply) and once as one that does not (execution plan section 3).
 */
export interface ClientProfile {
  elicitation: boolean;
}

export const PLAIN_CLIENT: ClientProfile = { elicitation: false };

export interface HarnessOptions {
  profile?: ClientProfile;
  /** Extra environment for the server, such as JOB_SEEKER_NOW (the fake clock). */
  env?: Record<string, string>;
  /** Runs before the server starts, against the fresh data directory. */
  prepare?: (home: string) => void | Promise<void>;
}

/** The fake clock every scenario runs at unless it says otherwise. */
export const FAKE_NOW = "2026-11-02T09:00:00.000Z";

/** Run the built CLI against a data directory, as the user would in a terminal. */
export function runCli(home: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { ...getDefaultEnvironment(), JOB_SEEKER_HOME: home, JOB_SEEKER_NOW: FAKE_NOW, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export interface McpHarness {
  client: Client;
  /** The fresh temporary JOB_SEEKER_HOME the server was started with. */
  home: string;
  /** The protocol version negotiated during the handshake. */
  protocolVersion: string | undefined;
  /** Everything the server wrote to stderr (for diagnosing a failed spawn). */
  serverStderr(): string;
  close(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<McpHarness> {
  const profile = options.profile ?? PLAIN_CLIENT;
  const home = join(mkdtempSync(join(tmpdir(), "job-seeker-mcp-")), "home");
  await options.prepare?.(home);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, "mcp"],
    env: { ...getDefaultEnvironment(), JOB_SEEKER_HOME: home, JOB_SEEKER_NOW: FAKE_NOW, ...options.env },
    stderr: "pipe",
  });

  // The SDK negotiates the protocol version during connect() but does not
  // expose the result on the stdio client, so tap the initialize response at
  // the transport boundary to make the negotiation observable (AT-0.1).
  let protocolVersion: string | undefined;
  let innerOnMessage: ((message: unknown) => void) | undefined;
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    get: () => innerOnMessage,
    set: (handler: (message: unknown) => void) => {
      innerOnMessage = (message: unknown) => {
        const record = message as { result?: { protocolVersion?: unknown } };
        if (typeof record.result?.protocolVersion === "string") {
          protocolVersion = record.result.protocolVersion;
        }
        handler(message);
      };
    },
  });

  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const client = new Client(
    { name: "job-seeker-test-harness", version: "0.0.1" },
    { capabilities: profile.elicitation ? { elicitation: {} } : {} },
  );

  try {
    await client.connect(transport);
  } catch (error) {
    rmSync(join(home, ".."), { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`MCP harness failed to start the server: ${message}\nserver stderr:\n${stderr}`);
  }

  return {
    client,
    home,
    protocolVersion,
    serverStderr: () => stderr,
    close: async () => {
      await client.close();
      rmSync(join(home, ".."), { recursive: true, force: true });
    },
  };
}
