import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const capture = require("../src/capture.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lmcp-capture-"));
}

test("captureDir: env override wins, otherwise a 'captures' sibling of the user-data dir", () => {
  assert.equal(
    capture.captureDir({ LINKEDIN_MCP_CAPTURE_DIR: "/custom/dir" }, "/home/me/.config/linkedin-mcp"),
    "/custom/dir",
  );
  assert.equal(
    capture.captureDir({}, "/home/me/.config/linkedin-mcp"),
    path.join("/home/me/.config/linkedin-mcp", "captures"),
  );
});

test("shouldCapture: zero-result search/saved-jobs/alerts and a title-less job detail all trigger", () => {
  assert.equal(capture.shouldCapture("linkedin_search_jobs", { count: 0, jobs: [] }), true);
  assert.equal(capture.shouldCapture("linkedin_search_jobs", { count: 3, jobs: [{}] }), false);
  assert.equal(capture.shouldCapture("linkedin_list_saved_jobs", { count: 0, jobs: [] }), true);
  assert.equal(capture.shouldCapture("linkedin_list_saved_jobs", { count: 1, jobs: [{}] }), false);
  assert.equal(capture.shouldCapture("linkedin_list_job_alerts", { count: 0, alerts: [] }), true);
  assert.equal(capture.shouldCapture("linkedin_list_job_alerts", { count: 2, alerts: [{}] }), false);
  assert.equal(capture.shouldCapture("linkedin_get_job", { title: "" }), true);
  assert.equal(capture.shouldCapture("linkedin_get_job", { title: "Director, AI Strategy" }), false);
  assert.equal(capture.shouldCapture("linkedin_status", {}), false);
});

test("writeCapture: writes html, screenshot and a metadata json naming the path", () => {
  const dir = tmpDir();
  const now = () => Date.parse("2026-11-04T12:00:00Z");
  const meta = capture.writeCapture({
    dir,
    toolName: "linkedin_search_jobs",
    url: "https://www.linkedin.com/jobs/search/?keywords=test",
    html: "<html><body>no job cards</body></html>",
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    now,
  });

  assert.equal(fs.readFileSync(meta.html, "utf8"), "<html><body>no job cards</body></html>");
  assert.ok(fs.readFileSync(meta.screenshot).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
  assert.equal(meta.tool, "linkedin_search_jobs");
  assert.equal(meta.url, "https://www.linkedin.com/jobs/search/?keywords=test");
  assert.equal(meta.capturedAt, "2026-11-04T12:00:00.000Z");
  assert.equal(meta.dir, dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test("captureIfTriggered: a zero-result search captures HTML+screenshot+URL+timestamp and names the path", async () => {
  const dir = tmpDir();
  let getPageCalls = 0;
  const payload = { count: 0, jobs: [], warnings: ["no job cards found with any known selector"] };
  const result = await capture.captureIfTriggered({
    toolName: "linkedin_search_jobs",
    payload,
    dir,
    getPage: async () => {
      getPageCalls += 1;
      return {
        url: "https://www.linkedin.com/jobs/search/?keywords=ai+strategy",
        html: "<html><body>no job cards</body></html>",
        png: Buffer.from("fake-png"),
      };
    },
    now: () => Date.parse("2026-11-04T12:00:00Z"),
  });

  assert.equal(getPageCalls, 1);
  assert.equal(result.triggered, true);
  assert.equal(result.url, "https://www.linkedin.com/jobs/search/?keywords=ai+strategy");
  assert.equal(result.capturedAt, "2026-11-04T12:00:00.000Z");
  assert.ok(fs.existsSync(result.html));
  assert.ok(fs.existsSync(result.screenshot));
  assert.equal(fs.readFileSync(result.html, "utf8"), "<html><body>no job cards</body></html>");
  assert.ok(fs.readFileSync(result.screenshot).equals(Buffer.from("fake-png")));
});

test("captureIfTriggered: a failed parse on get_job also captures", async () => {
  const dir = tmpDir();
  const result = await capture.captureIfTriggered({
    toolName: "linkedin_get_job",
    payload: { title: "", description: "", warnings: ["job title not found (selectors unverified)"] },
    dir,
    getPage: async () => ({
      url: "https://www.linkedin.com/jobs/view/4023456789/",
      html: "<html><body>re-skinned page</body></html>",
      png: Buffer.from("png-bytes"),
    }),
  });
  assert.equal(result.triggered, true);
  assert.ok(fs.existsSync(result.html));
  assert.ok(fs.existsSync(result.screenshot));
});

test("captureIfTriggered: a successful parse triggers no capture and never calls getPage", async () => {
  const dir = tmpDir();
  let getPageCalls = 0;
  const getPage = async () => {
    getPageCalls += 1;
    return { url: "x", html: "x", png: Buffer.alloc(0) };
  };

  assert.equal(
    await capture.captureIfTriggered({
      toolName: "linkedin_search_jobs",
      payload: { count: 2, jobs: [{ jobId: "1" }, { jobId: "2" }] },
      dir,
      getPage,
    }),
    null,
  );
  assert.equal(
    await capture.captureIfTriggered({
      toolName: "linkedin_get_job",
      payload: { title: "Director, AI Strategy" },
      dir,
      getPage,
    }),
    null,
  );

  assert.equal(getPageCalls, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("captureIfTriggered: a capture failure is reported, not thrown", async () => {
  const result = await capture.captureIfTriggered({
    toolName: "linkedin_search_jobs",
    payload: { count: 0, jobs: [] },
    dir: "/dev/null/not-a-real-dir",
    getPage: async () => ({ url: "x", html: "x", png: Buffer.alloc(0) }),
  });
  assert.equal(result.triggered, true);
  assert.ok(result.error);
});
