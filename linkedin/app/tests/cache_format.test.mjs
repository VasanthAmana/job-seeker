import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SessionCache } = require("../src/cache.js");
const { table, renderToolResult } = require("../src/format.js");
const paths = require("../src/paths.js");

test("SessionCache: hit within TTL, miss after TTL, arg order-insensitive keys", () => {
  let t = 0;
  const cache = new SessionCache({ ttlMs: 1000, now: () => t });
  const k1 = SessionCache.key("linkedin_search_jobs", { query: "a", limit: 10 });
  const k2 = SessionCache.key("linkedin_search_jobs", { limit: 10, query: "a" });
  assert.equal(k1, k2); // stable stringify sorts keys
  cache.set(k1, { jobs: [] });
  assert.deepEqual(cache.get(k2), { jobs: [] });
  t = 1001;
  assert.equal(cache.get(k1), undefined);
  assert.equal(cache.size, 0); // the expired entry was dropped on read
});

test("table: compact, aligned, truncated", () => {
  const text = table(
    ["TITLE", "JOB ID"],
    [
      ["Director, AI Strategy", "4023456789"],
      ["A very long job title that would otherwise wreck the layout of the table", "4023456790"],
    ],
    { maxColWidth: 30 },
  );
  const lines = text.split("\n");
  assert.equal(lines.length, 4); // header, separator, 2 rows
  assert.match(lines[0], /^TITLE/);
  assert.match(lines[1], /^-+/);
  assert.ok(lines[3].includes("…")); // long title truncated
  for (const line of lines) assert.ok(line.length <= 80, line);
});

test("table: empty rows still render a header", () => {
  const text = table(["A", "B"], []);
  assert.equal(text.split("\n").length, 2);
});

test("renderToolResult: table first, then JSON wrapped as untrusted page content", () => {
  const blocks = renderToolResult({ count: 0, jobs: [] }, "no rows");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "no rows");
  const parsed = JSON.parse(blocks[1].text);
  assert.deepEqual(Object.keys(parsed), ["untrusted_page_content"]);
});

test("paths: per-OS user-data dirs and endpoints", () => {
  const home = process.platform === "win32" ? "C:\\Users\\jane" : "/home/jane";
  assert.ok(paths.userDataDir({}, "darwin", home).includes("Library"));
  assert.ok(paths.userDataDir({}, "win32", home).includes("LinkedIn MCP"));
  assert.ok(paths.userDataDir({}, "linux", home).includes("linkedin-mcp"));
  // Named pipe on Windows, socket path on POSIX, env override on both. (The
  // separator below is the host's: paths.js uses the host path module, so a
  // Windows host asked for "darwin" paths still joins with backslashes - a
  // combination production never makes.)
  assert.match(paths.socketPath({}, "win32", home), /^\\\\\.\\pipe\\linkedin-mcp-/);
  assert.match(paths.socketPath({}, "darwin", home), /run[\\/]mcp\.sock$/);
  assert.equal(
    paths.socketPath({ LINKEDIN_MCP_SOCKET: "/tmp/x.sock" }, "darwin", home),
    "/tmp/x.sock",
  );
  // Pipe name is per-user so accounts on one machine never collide.
  assert.notEqual(
    paths.socketPath({ USERNAME: "jane" }, "win32", home),
    paths.socketPath({ USERNAME: "john" }, "win32", home),
  );
});
