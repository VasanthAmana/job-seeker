import test from "node:test";
import assert from "node:assert/strict";
import { loadFixture, evalInWindow, extractors } from "./helpers.mjs";

// Parser tests against saved fixture HTML. No live LinkedIn, ever: these
// fixtures are hand-written snapshots of LinkedIn's markup shape.

test("probePage: a signed-in jobs page is ok", async () => {
  const dom = loadFixture("search_results.html", "https://www.linkedin.com/jobs/search/?keywords=ai");
  const probe = await evalInWindow(dom, extractors.probePage);
  assert.equal(probe.state, "ok");
});

test("probePage: a login page is signed_out", async () => {
  const dom = loadFixture("login.html", "https://www.linkedin.com/login");
  const probe = await evalInWindow(dom, extractors.probePage);
  assert.equal(probe.state, "signed_out");
});

test("probePage: a captcha page is challenge (never answered)", async () => {
  const dom = loadFixture("challenge.html", "https://www.linkedin.com/checkpoint/challenge/abc");
  const probe = await evalInWindow(dom, extractors.probePage);
  assert.equal(probe.state, "challenge");
});

test("extractJobCards: parses title, company, location, workplace, posted, applicants, id, url", async () => {
  const dom = loadFixture("search_results.html", "https://www.linkedin.com/jobs/search/?keywords=ai");
  const out = await evalInWindow(dom, extractors.extractJobCards, { limit: 25 });
  assert.equal(out.count, 3);

  const [first, second, third] = out.jobs;
  assert.deepEqual(first, {
    jobId: "4023456789",
    title: "Director, AI Strategy",
    company: "Woodgrove Bank",
    location: "Denver, CO",
    workplaceType: "hybrid",
    posted: "3 days ago",
    postedAt: "2026-10-30",
    applicants: "27",
    url: "https://www.linkedin.com/jobs/view/4023456789/",
  });
  assert.equal(second.workplaceType, "remote");
  assert.equal(second.location, "United States");
  assert.equal(second.applicants, ""); // "Over 100 applicants" is not a count
  assert.equal(third.workplaceType, ""); // no workplace tag on this card
  assert.equal(third.posted, "1 week ago");
  // Canonical URLs carry no tracking parameters.
  for (const job of out.jobs) {
    assert.ok(!job.url.includes("trackingId"), job.url);
    assert.match(job.url, /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/$/);
  }
});

test("extractJobCards: dedupes nested nodes and honours limit", async () => {
  const dom = loadFixture("search_results.html", "https://www.linkedin.com/jobs/search/");
  const out = await evalInWindow(dom, extractors.extractJobCards, { limit: 2 });
  assert.equal(out.count, 2);
  const ids = out.jobs.map((j) => j.jobId);
  assert.equal(new Set(ids).size, ids.length);
});

test("extractJobCards: an empty page reports a warning, not a crash", async () => {
  const dom = loadFixture("saved_jobs.html", "https://www.linkedin.com/jobs/search/");
  const out = await evalInWindow(dom, extractors.extractJobCards, { limit: 25 });
  assert.equal(out.count, 0);
  assert.ok(out.warnings.length > 0);
});

test("extractJobDetail: parses the full posting", async () => {
  const dom = loadFixture(
    "job_detail.html",
    "https://www.linkedin.com/jobs/view/4023456789/?trackingId=x",
  );
  const out = await evalInWindow(dom, extractors.extractJobDetail);
  assert.equal(out.jobId, "4023456789");
  assert.equal(out.url, "https://www.linkedin.com/jobs/view/4023456789/");
  assert.equal(out.title, "Director, AI Strategy");
  assert.equal(out.company, "Woodgrove Bank");
  assert.equal(out.location, "Denver, CO");
  assert.equal(out.workplaceType, "hybrid");
  assert.equal(out.posted, "3 days ago");
  assert.equal(out.applicants, "27");
  assert.equal(out.seniorityLevel, "Director");
  assert.equal(out.employmentType, "Full-time");
  assert.equal(out.jobFunction, "Strategy/Planning");
  assert.equal(out.industries, "Banking");
  assert.equal(out.applyType, "easy_apply");
  assert.equal(out.hiringTeam.length, 1);
  assert.equal(out.hiringTeam[0].name, "Jane Doe");
  assert.match(out.hiringTeam[0].headline, /Recruiter/);
  assert.equal(out.hiringTeam[0].profileUrl, "https://www.linkedin.com/in/jane-doe-recruiter/");
  assert.match(out.description, /lead enterprise AI transformation/);
  assert.equal(out.warnings.length, 0);
});

test("extractJobAlerts: parses alert query, detail, enabled state", async () => {
  const dom = loadFixture("job_alerts.html", "https://www.linkedin.com/jobs/search/?f_AL=true");
  const out = await evalInWindow(dom, extractors.extractJobAlerts);
  assert.equal(out.count, 2);
  assert.match(out.alerts[0].query, /AI strategy/);
  assert.match(out.alerts[0].detail, /Denver Metropolitan Area/);
  assert.equal(out.alerts[0].enabled, true);
  assert.equal(out.alerts[1].enabled, false);
  assert.match(out.alerts[1].detail, /Remote/);
});

test("extractSavedJobs: parses saved jobs", async () => {
  const dom = loadFixture("saved_jobs.html", "https://www.linkedin.com/my-items/saved-jobs/");
  const out = await evalInWindow(dom, extractors.extractSavedJobs, { limit: 25 });
  assert.equal(out.count, 2);
  assert.equal(out.jobs[0].jobId, "4023456789");
  assert.equal(out.jobs[0].title, "Director, AI Strategy");
  assert.equal(out.jobs[1].company, "Northwind Energy");
});

test("extractPeople: names, headlines, profile URLs only - never connect/message", async () => {
  const dom = loadFixture(
    "people_results.html",
    "https://www.linkedin.com/search/results/people/?keywords=recruiter",
  );
  const out = await evalInWindow(dom, extractors.extractPeople, { limit: 10 });
  assert.equal(out.count, 2);
  assert.equal(out.people[0].name, "Jane Doe");
  assert.match(out.people[0].headline, /Woodgrove Bank/);
  assert.equal(out.people[0].profileUrl, "https://www.linkedin.com/in/jane-doe-recruiter/");
  assert.equal(out.people[1].name, "John Smith");
  // The result shape carries no action handles: just the four read-only fields.
  for (const person of out.people) {
    assert.deepEqual(Object.keys(person).sort(), ["headline", "location", "name", "profileUrl"]);
  }
});

test("clickSaveJob + readSaveState: clicks an unsaved Save button, reports state", async () => {
  const dom = loadFixture("job_detail.html", "https://www.linkedin.com/jobs/view/4023456789/");
  let clicks = 0;
  const btn = dom.window.document.querySelector("button.jobs-save-button");
  btn.addEventListener("click", () => {
    clicks += 1;
    btn.setAttribute("aria-label", "Unsave"); // LinkedIn flips the label after save
  });
  const click = await evalInWindow(dom, extractors.clickSaveJob);
  assert.equal(click.clicked, true);
  assert.equal(clicks, 1);
  const state = await evalInWindow(dom, extractors.readSaveState);
  assert.equal(state.saved, true);
});

test("clickSaveJob: already-saved job is not clicked again", async () => {
  const dom = loadFixture("job_detail.html", "https://www.linkedin.com/jobs/view/4023456789/");
  dom.window.document.querySelector("button.jobs-save-button").setAttribute("aria-label", "Unsave");
  const click = await evalInWindow(dom, extractors.clickSaveJob);
  assert.equal(click.clicked, false);
  assert.match(click.reason, /already saved/);
});

test("scrollResultsList: resolves on a page with a results list", async () => {
  const dom = loadFixture("search_results.html", "https://www.linkedin.com/jobs/search/");
  const out = await evalInWindow(dom, extractors.scrollResultsList);
  assert.equal(out.scrolled, true);
});
