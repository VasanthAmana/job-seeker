"use strict";
// A minimal MCP server on a local-only endpoint (Zook's marketseries
// pattern, made cross-platform): newline-delimited JSON-RPC, exactly the
// bytes MCP stdio framing uses, so the bin/linkedin-mcp.js shim can relay
// stdio <-> endpoint verbatim.
//
//   - macOS / Linux: a 0600 UNIX socket inside a 0700 directory - only the
//     owner's user can reach it.
//   - Windows: a named pipe (\\.\pipe\linkedin-mcp-<user>), reachable on the
//     local machine only; chmod/unlink steps are POSIX-only and skipped.
//   - No TCP port is opened, ever.
//   - Implemented: initialize, ping, notifications (ignored), tools/list,
//     tools/call. Unknown methods get -32601.
//   - No Electron dependency: tests run this server on a real socket and talk
//     to it through the real shim.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "linkedin-mcp", version: "0.1.0" };

// callTool(name, args) -> { content: [...], isError?: bool }
function startMcpServer({ socketPath: sock, catalogue, callTool, onConnection } = {}) {
  const isWindowsPipe = sock.startsWith("\\\\.\\pipe\\");
  if (!isWindowsPipe) {
    fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(path.dirname(sock), 0o700);
    } catch (err) {
      /* best effort */
    }
    try {
      fs.unlinkSync(sock); // stale socket from a crashed run
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
  }

  const connections = new Set();
  const server = net.createServer((conn) => {
    connections.add(conn);
    conn.on("close", () => connections.delete(conn));
    if (onConnection) onConnection(conn);
    conn.setEncoding("utf8");
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) handleLine(line, conn);
      }
    });
  });

  function send(conn, message) {
    if (!conn.destroyed) conn.write(JSON.stringify(message) + "\n");
  }

  async function handleLine(line, conn) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      send(conn, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    // Notifications (no id) need no response.
    if (msg.id === undefined || msg.id === null) return;
    const reply = (result) => send(conn, { jsonrpc: "2.0", id: msg.id, result });
    const fail = (code, message) => send(conn, { jsonrpc: "2.0", id: msg.id, error: { code, message } });

    try {
      switch (msg.method) {
        case "initialize": {
          const requested = msg.params && typeof msg.params.protocolVersion === "string"
            ? msg.params.protocolVersion
            : PROTOCOL_VERSION;
          reply({
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          });
          return;
        }
        case "ping":
          reply({});
          return;
        case "tools/list":
          reply({
            tools: catalogue.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          });
          return;
        case "tools/call": {
          const params = msg.params || {};
          const result = await callTool(params.name, params.arguments || {});
          reply(result);
          return;
        }
        default:
          fail(-32601, `method not found: ${msg.method}`);
      }
    } catch (err) {
      // A handler exception becomes an MCP error RESULT (not a protocol
      // error), so the calling model can read and act on it.
      reply({
        content: [
          { type: "text", text: "error: " + String(err && err.message ? err.message : err) },
        ],
        isError: true,
      });
    }
  }

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(sock, () => {
      server.removeListener("error", reject);
      if (!isWindowsPipe) {
        try {
          fs.chmodSync(sock, 0o600);
        } catch (err) {
          /* best effort */
        }
      }
      resolve({
        socketPath: sock,
        close: () =>
          new Promise((done) => {
            // server.close() alone waits for open connections; a relay client
            // holds one for as long as Claude Code keeps it. Drop them.
            for (const conn of connections) conn.destroy();
            server.close(() => {
              if (!isWindowsPipe) {
                try {
                  fs.unlinkSync(sock);
                } catch (err) {
                  /* already gone */
                }
              }
              done();
            });
          }),
      });
    });
  });
}

module.exports = { startMcpServer, PROTOCOL_VERSION, SERVER_INFO };
