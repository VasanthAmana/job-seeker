"use strict";
// LinkedIn URL builders. Pure module: strings in, strings out, no I/O.
// The filter parameter names (f_E, f_WT, f_TPR, f_JT) are LinkedIn's own,
// the same ones its Jobs UI puts in the address bar when you pick filters.

const ORIGIN = "https://www.linkedin.com";

// UNVERIFIED ROUTES: SAVED_JOBS_URL and JOB_ALERTS_URL were written without a
// signed-in session to check them against. They are LinkedIn's documented
// entry points as of writing; if a first live run lands somewhere unexpected,
// the page probe in main.js reports "LinkedIn needs you" instead of guessing,
// and the constant is corrected here.
const SAVED_JOBS_URL = `${ORIGIN}/my-items/saved-jobs/`;
const JOB_ALERTS_URL = `${ORIGIN}/jobs/search/?f_AL=true`;
const JOBS_HOME_URL = `${ORIGIN}/jobs/`;

const EXPERIENCE_LEVELS = {
  internship: "1",
  entry_level: "2",
  associate: "3",
  mid_senior: "4",
  director: "5",
  executive: "6",
};

const DATE_POSTED = {
  past_24_hours: "r86400",
  past_week: "r604800",
  past_month: "r2592000",
};

const JOB_TYPES = {
  full_time: "F",
  part_time: "P",
  contract: "C",
  temporary: "T",
  volunteer: "V",
  internship: "I",
};

// A LinkedIn Jobs search URL. Boolean operators (AND/OR/NOT, quotes) in
// `query` are passed through untouched: LinkedIn's own keyword box takes them.
function searchJobsUrl({
  query,
  location,
  remote,
  experienceLevels,
  datePosted,
  jobType,
  start = 0,
}) {
  const params = new URLSearchParams();
  if (query) params.set("keywords", query);
  if (location) params.set("location", location);
  if (remote === true) params.set("f_WT", "2"); // 1 on-site, 2 remote, 3 hybrid
  if (Array.isArray(experienceLevels) && experienceLevels.length > 0) {
    const codes = experienceLevels.map((l) => EXPERIENCE_LEVELS[l]).filter(Boolean);
    if (codes.length > 0) params.set("f_E", codes.join(","));
  }
  if (datePosted && DATE_POSTED[datePosted]) params.set("f_TPR", DATE_POSTED[datePosted]);
  if (jobType && JOB_TYPES[jobType]) params.set("f_JT", JOB_TYPES[jobType]);
  if (start > 0) params.set("start", String(start));
  return `${ORIGIN}/jobs/search/?${params.toString()}`;
}

// Accepts a numeric job id, a "urn:li:jobPosting:<id>" string, or any
// LinkedIn URL containing /jobs/view/<id>. Returns { jobId, url } or null.
function jobView(input) {
  if (typeof input !== "string" && typeof input !== "number") return null;
  const text = String(input).trim();
  let match = text.match(/(?:jobs\/view\/|jobPosting:|currentJobId=)(\d{4,})/);
  if (!match && /^\d{4,}$/.test(text)) match = [text, text];
  if (!match) return null;
  const jobId = match[1];
  return { jobId, url: `${ORIGIN}/jobs/view/${jobId}/` };
}

// People search. LinkedIn's people facets (current company, current title)
// use opaque facet URNs that cannot be built from plain text, so company and
// title are folded into the keyword query, which LinkedIn parses well.
function peopleSearchUrl({ query, company, title }) {
  const keywords = [query, title, company].filter(Boolean).join(" ");
  const params = new URLSearchParams();
  params.set("keywords", keywords);
  params.set("origin", "SWITCH_SEARCH_VERTICAL");
  return `${ORIGIN}/search/results/people/?${params.toString()}`;
}

module.exports = {
  ORIGIN,
  SAVED_JOBS_URL,
  JOB_ALERTS_URL,
  JOBS_HOME_URL,
  EXPERIENCE_LEVELS,
  DATE_POSTED,
  JOB_TYPES,
  searchJobsUrl,
  jobView,
  peopleSearchUrl,
};
