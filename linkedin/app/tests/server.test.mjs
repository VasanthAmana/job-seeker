import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { startMcpServer } = require("../src/server.js");
const { TOOLS, validateArgs } = require("../src/tools.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(HERE, "..", "bin", "linkedin-mcp.js");

function testEndpoint() {
  const tag = `linkedin-mcp-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\${tag}`;
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lmcp-")), "mcp.sock");
}

// A tiny MCP client over the real stdio relay: spawns bin/linkedin-mcp.js and
// speaks newline-delimited JSON-RPC on its stdio, exactly as Claude Code does.
function connectViaShim(endpoint) {
  const child = spawn(process.execPath, [SHIM], {
    env: { ...process.env, LINKEDIN_MCP_SOCKET: endpoint },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const close = () => child.kill();
  return { call, close, child };
}

async function withServer(t, callTool) {
  const endpoint = testEndpoint();
  const server = await startMcpServer({
    socketPath: endpoint,
    catalogue: TOOLS,
    callTool,
  });
  t.after(async () => {
    await server.close();
  });
  return endpoint;
}

test("the real MCP server on a real endpoint, through the real shim", async (t) => {
  const endpoint = await withServer(t, async (name, args) => {
    const check = validateArgs(name, args);
    if (!check.ok) return { content: [{ type: "text", text: "error: " + check.error }], isError: true };
    return {
      content: [
        { type: "text", text: "TITLE  COMPANY\nfake    row" },
        { type: "text", text: JSON.stringify({ untrusted_page_content: { echo: check.args } }) },
      ],
    };
  });

  const client = connectViaShim(endpoint);
  t.after(() => client.close());

  const init = await client.call("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.serverInfo.name, "linkedin-mcp");
  assert.ok(init.capabilities.tools);

  const list = await client.call("tools/list", {});
  const names = list.tools.map((tool) => tool.name);
  assert.deepEqual(names, TOOLS.map((tool) => tool.name));
  const search = list.tools.find((tool) => tool.name === "linkedin_search_jobs");
  assert.equal(search.inputSchema.required[0], "query");

  const result = await client.call("tools/call", {
    name: "linkedin_search_jobs",
    arguments: { query: "AI strategy", location: "Denver Metropolitan Area" },
  });
  assert.equal(result.content.length, 2);
  assert.match(result.content[0].text, /fake/);
  const payload = JSON.parse(result.content[1].text);
  assert.equal(payload.untrusted_page_content.echo.limit, 10); // default applied

  const bad = await client.call("tools/call", { name: "linkedin_save_job", arguments: { job_id: "1234" } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /confirm: true/);

  await client.call("ping", {});
  await assert.rejects(client.call("bogus/method", {}), /method not found/);
});

test("handler exceptions surface as MCP error results, not protocol errors", async (t) => {
  const endpoint = await withServer(t, async () => {
    throw new Error("LinkedIn needs you: LinkedIn is showing a security check");
  });
  const client = connectViaShim(endpoint);
  t.after(() => client.close());
  const result = await client.call("tools/call", { name: "linkedin_status", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /LinkedIn needs you/);
});

test("a POSIX socket is created 0600 in a 0700 directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits do not apply to Windows named pipes");
    return;
  }
  const endpoint = await withServer(t, async () => ({ content: [] }));
  const stat = fs.statSync(endpoint);
  assert.equal(stat.mode & 0o777, 0o600);
  const dirStat = fs.statSync(path.dirname(endpoint));
  assert.equal(dirStat.mode & 0o777, 0o700);
});

test("the shim exits cleanly with a clear message when the app is not running", async (t) => {
  const missing =
    process.platform === "win32"
      ? `\\\\.\\pipe\\linkedin-mcp-test-missing-${process.pid}`
      : path.join(os.tmpdir(), `lmcp-missing-${process.pid}`, "mcp.sock");
  const child = spawn(process.execPath, [SHIM], {
    env: { ...process.env, LINKEDIN_MCP_SOCKET: missing },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /not running/);
});
