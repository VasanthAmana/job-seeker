"use strict";
// Step 1 of the two-step fix for LinkedIn re-skinning its markup: when a
// search/read tool comes back empty or fails to parse, save what the page
// actually looked like - HTML, a screenshot, the URL and a timestamp - so a
// later task can rebuild the reader against real captures instead of guesses.
//
// This module is pure and Electron-free: `shouldCapture` and `writeCapture`
// are plain functions tests call directly against fixtures. The one
// Electron-specific step - reading the ALREADY-loaded page's HTML and taking
// a screenshot, with no navigation or extra page load - is injected as
// `getPage` so main.js stays the only place that touches webContents.

const fs = require("node:fs");
const path = require("node:path");

// LINKEDIN_MCP_CAPTURE_DIR overrides; default is a sibling of the app's own
// user-data dir (same non-repo local-state convention as session storage).
function captureDir(env = process.env, userDataDir = "") {
  if (env.LINKEDIN_MCP_CAPTURE_DIR) return env.LINKEDIN_MCP_CAPTURE_DIR;
  return path.join(userDataDir, "captures");
}

// Did this tool's result come back empty or fail to parse? Mirrors the
// zero-result / empty-parse checks the extractors already compute, without
// touching the reader/selector logic itself (out of scope for this task).
function shouldCapture(toolName, payload) {
  if (!payload) return false;
  switch (toolName) {
    case "linkedin_search_jobs":
    case "linkedin_list_saved_jobs":
    case "linkedin_list_job_alerts":
      return (payload.count || 0) === 0;
    case "linkedin_get_job":
      return !payload.title;
    default:
      return false;
  }
}

function slug(name) {
  return String(name || "capture").replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Writes html + screenshot(png) + a metadata json into `dir`. Pure fs, no
// network, no Electron. Returns the metadata written.
function writeCapture({ dir, toolName, url, html, png, now = () => Date.now() }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    /* best effort */
  }
  const capturedAt = new Date(now()).toISOString();
  const base = `${capturedAt.replace(/[:.]/g, "-")}-${slug(toolName)}`;
  const htmlPath = path.join(dir, `${base}.html`);
  const screenshotPath = path.join(dir, `${base}.png`);
  const metaPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(htmlPath, html || "", "utf8");
  fs.writeFileSync(screenshotPath, png || Buffer.alloc(0));
  const meta = { tool: toolName, url: url || "", capturedAt, dir, html: htmlPath, screenshot: screenshotPath };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

// Orchestrates the above: if the result warrants it, grabs the already-loaded
// page via `getPage()` (Electron-specific, injected) and writes the capture.
// Never throws: a capture failure is reported in the result, not fatal to the
// tool call it rode in on.
async function captureIfTriggered({ toolName, payload, dir, getPage, now }) {
  if (!shouldCapture(toolName, payload)) return null;
  try {
    const { url, html, png } = await getPage();
    return { triggered: true, ...writeCapture({ dir, toolName, url, html, png, now }) };
  } catch (err) {
    return { triggered: true, error: String(err && err.message ? err.message : err) };
  }
}

module.exports = { captureDir, shouldCapture, writeCapture, captureIfTriggered };
