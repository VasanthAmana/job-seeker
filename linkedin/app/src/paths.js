"use strict";
// Path resolution for the app's user-data directory and the MCP endpoint.
// Pure module: no Electron, no fs side effects. Cross-platform:
//   - macOS / Linux: a 0600 UNIX socket inside a 0700 directory, reachable
//     only by the owner's user. No TCP port is ever opened.
//   - Windows: a named pipe (\\.\pipe\...), the native equivalent; Node's net
//     module speaks both from the same code path. The pipe name carries the
//     user name so two accounts on one machine never collide.
const os = require("node:os");
const path = require("node:path");

const APP_DIR_NAME = "LinkedIn MCP";

function userDataDir(env = process.env, platform = process.platform, homedir = os.homedir()) {
  if (env.LINKEDIN_MCP_USER_DATA) return env.LINKEDIN_MCP_USER_DATA;
  if (platform === "darwin") return path.join(homedir, "Library", "Application Support", APP_DIR_NAME);
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(homedir, "AppData", "Roaming"), APP_DIR_NAME);
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir, ".config"), "linkedin-mcp");
}

function pipeName(env = process.env) {
  const user = String(env.USERNAME || env.USER || "user").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `\\\\.\\pipe\\linkedin-mcp-${user}`;
}

// The MCP endpoint: a filesystem socket path on POSIX, a named pipe on
// Windows. LINKEDIN_MCP_SOCKET overrides either (tests use this).
function socketPath(env = process.env, platform = process.platform, homedir = os.homedir()) {
  if (env.LINKEDIN_MCP_SOCKET) return env.LINKEDIN_MCP_SOCKET;
  if (platform === "win32") return pipeName(env);
  return path.join(userDataDir(env, platform, homedir), "run", "mcp.sock");
}

module.exports = { userDataDir, socketPath, pipeName, APP_DIR_NAME };
