import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TOOLS, validateArgs } = require("../src/tools.js");
const urls = require("../src/urls.js");

const GUIDE_QUERY =
  '("AI strategy" OR "AI transformation" OR "business transformation" OR "digital transformation" OR "strategic initiatives" OR "chief of staff" OR innovation) NOT (engineer OR engineering OR developer OR scientist OR architect OR "machine learning")';

test("catalogue: every tool has name, description and a closed object schema", () => {
  assert.ok(TOOLS.length >= 7);
  for (const tool of TOOLS) {
    assert.match(tool.name, /^linkedin_[a-z_]+$/);
    assert.ok(tool.description.length > 20);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  // The five spec tools are present.
  for (const name of [
    "linkedin_search_jobs",
    "linkedin_get_job",
    "linkedin_list_job_alerts",
    "linkedin_list_saved_jobs",
    "linkedin_search_people",
  ]) {
    assert.ok(TOOLS.some((t) => t.name === name), name);
  }
});

test("catalogue: no messaging, connecting or applying tools exist", () => {
  for (const tool of TOOLS) {
    assert.doesNotMatch(tool.name, /message|connect|apply|invite|follow|export/i);
  }
});

test("catalogue: page-reading tools warn that content is untrusted", () => {
  for (const tool of TOOLS) {
    if (tool.name === "linkedin_status") continue;
    assert.match(tool.description, /untrusted/i, tool.name);
  }
});

test("validateArgs: search jobs with the guide's filters", () => {
  const r = validateArgs("linkedin_search_jobs", {
    query: GUIDE_QUERY,
    location: "Denver Metropolitan Area",
    experience_levels: ["director", "executive"],
  });
  assert.equal(r.ok, true);
  assert.equal(r.args.limit, 10); // default applied
  assert.equal(r.args.query, GUIDE_QUERY);
});

test("validateArgs: rejects bad enums, bad types, unknown keys", () => {
  assert.equal(validateArgs("linkedin_search_jobs", { query: "x", experience_levels: ["guru"] }).ok, false);
  assert.equal(validateArgs("linkedin_search_jobs", { query: "x", limit: 0 }).ok, false);
  assert.equal(validateArgs("linkedin_search_jobs", { query: "x", limit: 51 }).ok, false);
  assert.equal(validateArgs("linkedin_search_jobs", { query: "x", stealth: true }).ok, false);
  assert.equal(validateArgs("linkedin_search_jobs", {}).ok, false); // query required
  assert.equal(validateArgs("no_such_tool", {}).ok, false);
});

test("validateArgs: get_job needs job_id or url", () => {
  assert.equal(validateArgs("linkedin_get_job", {}).ok, false);
  assert.equal(validateArgs("linkedin_get_job", { job_id: "4023456789" }).ok, true);
  assert.equal(validateArgs("linkedin_get_job", { url: "https://www.linkedin.com/jobs/view/4023456789/" }).ok, true);
});

test("validateArgs: the one write (save_job) refuses without confirm: true", () => {
  const refused = validateArgs("linkedin_save_job", { job_id: "4023456789" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /confirm: true/);
  assert.match(refused.error, /Nothing was changed/);
  const refusedFalse = validateArgs("linkedin_save_job", { job_id: "4023456789", confirm: false });
  assert.equal(refusedFalse.ok, false);
  assert.equal(validateArgs("linkedin_save_job", { job_id: "4023456789", confirm: true }).ok, true);
});

test("urls: search URL carries the guide's query and LinkedIn's own filters", () => {
  const url = urls.searchJobsUrl({
    query: GUIDE_QUERY,
    location: "United States",
    remote: true,
    experienceLevels: ["director", "executive"],
    datePosted: "past_week",
    jobType: "full_time",
    start: 25,
  });
  assert.ok(url.startsWith("https://www.linkedin.com/jobs/search/?"));
  const params = new URL(url).searchParams;
  assert.equal(params.get("keywords"), GUIDE_QUERY); // boolean passed through untouched
  assert.equal(params.get("location"), "United States");
  assert.equal(params.get("f_WT"), "2");
  assert.equal(params.get("f_E"), "5,6"); // Director + Executive
  assert.equal(params.get("f_TPR"), "r604800");
  assert.equal(params.get("f_JT"), "F");
  assert.equal(params.get("start"), "25");
});

test("urls: Denver alert shape (no remote filter, no start when 0)", () => {
  const url = urls.searchJobsUrl({
    query: GUIDE_QUERY,
    location: "Denver Metropolitan Area",
    experienceLevels: ["director", "executive"],
  });
  const params = new URL(url).searchParams;
  assert.equal(params.get("f_WT"), null);
  assert.equal(params.get("start"), null);
});

test("urls: jobView accepts ids, urns and URLs, rejects junk", () => {
  assert.deepEqual(urls.jobView("4023456789"), {
    jobId: "4023456789",
    url: "https://www.linkedin.com/jobs/view/4023456789/",
  });
  assert.equal(urls.jobView("urn:li:jobPosting:4023456789").jobId, "4023456789");
  assert.equal(
    urls.jobView("https://www.linkedin.com/jobs/view/4023456789/?trackingId=abc").jobId,
    "4023456789",
  );
  assert.equal(urls.jobView("not a job"), null);
});

test("urls: people search folds company and title into keywords", () => {
  const url = urls.peopleSearchUrl({ query: "recruiter", company: "Woodgrove Bank", title: "technical" });
  const params = new URL(url).searchParams;
  assert.equal(params.get("keywords"), "recruiter technical Woodgrove Bank");
  assert.ok(url.startsWith("https://www.linkedin.com/search/results/people/?"));
});
