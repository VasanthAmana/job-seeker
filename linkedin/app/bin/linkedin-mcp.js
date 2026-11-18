#!/usr/bin/env node
// linkedin-mcp: the stdio relay Claude Code launches, on Windows and macOS:
//
//   claude mcp add linkedin -- node <path>/linkedin_mcp/bin/linkedin-mcp.js
//
// It relays stdin/stdout to the app's MCP endpoint (a UNIX socket on
// macOS/Linux, a named pipe on Windows) and holds nothing itself; the
// linkedin-mcp Electron app must be running. The endpoint is resolved exactly
// as src/paths.js resolves it, and LINKEDIN_MCP_SOCKET overrides it.
"use strict";
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

function endpoint() {
  if (process.env.LINKEDIN_MCP_SOCKET) return process.env.LINKEDIN_MCP_SOCKET;
  if (process.platform === "win32") {
    const user = String(process.env.USERNAME || process.env.USER || "user").replace(/[^a-zA-Z0-9_-]/g, "_");
    return `\\\\.\\pipe\\linkedin-mcp-${user}`;
  }
  const userData =
    process.env.LINKEDIN_MCP_USER_DATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "LinkedIn MCP")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "linkedin-mcp"));
  return path.join(userData, "run", "mcp.sock");
}

const socketPath = endpoint();
const conn = net.connect(socketPath);
conn.on("connect", () => {
  process.stdin.pipe(conn);
  conn.pipe(process.stdout);
});
conn.on("error", (err) => {
  process.stderr.write(
    `linkedin-mcp: the app is not running (no MCP endpoint at ${socketPath}: ${err.code || err.message}). Start it with \`npm start\` in the linkedin_mcp folder.\n`,
  );
  process.exit(1);
});
conn.on("close", () => process.exit(0));
process.stdin.on("end", () => conn.end());
