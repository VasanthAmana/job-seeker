"use strict";
// In-page extractor functions (Jeeves/Zook "guest" pattern).
//
// Every function below is SELF-CONTAINED: no imports, no closures, no
// references outside its own body and the page globals (window, document,
// location). main.js serialises one with fn.toString() and runs it inside the
// signed-in LinkedIn page via webContents.executeJavaScript; the tests run
// the exact same source inside jsdom. Each function is written to NEVER
// throw: a page it does not understand yields empty results plus a warning,
// not an exception.
//
// DOM selectors are UNVERIFIED until the first real signed-in run (see
// README): LinkedIn re-skins often, so every lookup has fallbacks and a total
// miss reports what it could not find. Page text is untrusted DATA - callers
// wrap results as {"untrusted_page_content": ...} (src/server.js).

// Runs `fn` source with `arg` as its single argument. Shared by main.js
// (against the live page) and tests (against jsdom), so both execute the
// identical code path.
function callSource(fn, arg) {
  return `(${fn.toString()})(${JSON.stringify(arg === undefined ? {} : arg)})`;
}

// ---------------------------------------------------------------------------
// Page probe: what state is the loaded page in?
// Returns { state: "ok" | "signed_out" | "challenge", url, reason }.
// ---------------------------------------------------------------------------
function probePage() {
  try {
    const url = String(window.location.href);
    let path = "";
    try {
      path = window.location.pathname || "";
    } catch (e) {
      path = "";
    }
    const bodyText = (document.body && document.body.textContent ? document.body.textContent : "").slice(0, 4000);

    // A bot check or security challenge. We never answer these.
    const hasCaptcha = !!document.querySelector(
      'iframe[src*="captcha"], iframe[src*="challenge"], #captcha, .captcha-container, [data-captcha]',
    );
    const challengePath = /\/checkpoint\/challenge|\/checkpoint\/lg|\/uas\/challenge/.test(path);
    const challengeText = /security verification|verify you are a real person|unusual traffic|let's do a quick security check/i.test(
      bodyText,
    );
    if (challengePath || hasCaptcha) {
      return { state: "challenge", url, reason: "LinkedIn is showing a security check" };
    }
    if (challengeText && !document.querySelector("[data-job-id], #global-nav, header nav")) {
      return { state: "challenge", url, reason: "LinkedIn is showing a security check" };
    }

    // Signed out: a login form, the auth wall LinkedIn shows guests, or a
    // login URL.
    const loginForm = !!document.querySelector(
      "input#session_key, input[name=session_key], form.login__form, .authwall, .join-form",
    );
    const loginPath = /^\/(uas\/login|login|checkpoint\/rp)/.test(path);
    if (loginForm || loginPath) {
      return { state: "signed_out", url, reason: "LinkedIn is asking for a sign-in" };
    }
    return { state: "ok", url, reason: "" };
  } catch (err) {
    return { state: "signed_out", url: "", reason: "probe failed: " + String(err && err.message ? err.message : err) };
  }
}

// ---------------------------------------------------------------------------
// Jobs search results page (/jobs/search/?keywords=...).
// arg: { limit }. Returns { count, jobs: [...], warnings: [...] }.
// ---------------------------------------------------------------------------
function extractJobCards(arg) {
  const out = { count: 0, jobs: [], warnings: [] };
  try {
    const limit = arg && arg.limit ? arg.limit : 25;
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

    const nodes = Array.from(
      document.querySelectorAll("[data-job-id], li[data-occludable-job-id], [data-entity-urn*='jobPosting']"),
    );
    const seen = {};
    for (const node of nodes) {
      if (out.jobs.length >= limit) break;
      const card =
        node.closest && node.closest("li")
          ? node.closest("li")
          : node;
      const root = node.getAttribute && (node.getAttribute("data-job-id") || node.getAttribute("data-occludable-job-id"))
        ? node
        : card;
      const idAttr =
        (node.getAttribute && (node.getAttribute("data-job-id") || node.getAttribute("data-occludable-job-id"))) ||
        (() => {
          const urn = node.getAttribute && node.getAttribute("data-entity-urn");
          const m = urn && urn.match(/jobPosting:(\d+)/);
          return m ? m[1] : "";
        })();
      const link = card.querySelector ? card.querySelector("a[href*='/jobs/view/']") : null;
      const href = link ? link.getAttribute("href") || "" : "";
      const hrefMatch = href.match(/jobs\/view\/(\d+)/);
      const jobId = idAttr || (hrefMatch ? hrefMatch[1] : "");
      if (!jobId || seen[jobId]) continue;
      seen[jobId] = true;

      const titleEl = card.querySelector
        ? card.querySelector(
            ".job-card-list__title, .job-card-job-title, .artdeco-entity-lockup__title a, a[href*='/jobs/view/']",
          )
        : null;
      const title = clean(titleEl && (titleEl.getAttribute("aria-label") || titleEl.textContent));

      const companyEl = card.querySelector
        ? card.querySelector(
            ".job-card-container__primary-description, .job-card-container__company-name, .artdeco-entity-lockup__subtitle",
          )
        : null;
      const company = clean(companyEl && companyEl.textContent);

      const locEls = card.querySelectorAll
        ? Array.from(
            card.querySelectorAll(".job-card-container__metadata-item, .artdeco-entity-lockup__caption li"),
          )
        : [];
      const locText = clean(locEls.map((el) => el.textContent).join(" ")).slice(0, 200);
      let location = locText;
      let workplaceType = "";
      const wt = locText.match(/\((Remote|Hybrid|On-site|Onsite)\)/i);
      if (wt) {
        workplaceType = wt[1].toLowerCase() === "onsite" ? "on-site" : wt[1].toLowerCase();
        location = clean(locText.replace(wt[0], ""));
      }

      const timeEl = card.querySelector ? card.querySelector("time") : null;
      const posted = clean(timeEl && timeEl.textContent);
      const postedAt = timeEl && timeEl.getAttribute ? timeEl.getAttribute("datetime") || "" : "";

      let applicants = "";
      if (card.querySelectorAll) {
        const meta = Array.from(card.querySelectorAll("li, span"));
        for (const el of meta) {
          const t = clean(el.textContent);
          const m = t.match(/^([\d,]+)\s+applicants?$/i);
          if (m) {
            applicants = m[1];
            break;
          }
        }
      }

      out.jobs.push({
        jobId,
        title,
        company,
        location,
        workplaceType,
        posted,
        postedAt,
        applicants,
        url: "https://www.linkedin.com/jobs/view/" + jobId + "/",
      });
    }
    out.count = out.jobs.length;
    if (out.count === 0) {
      const bodyText = document.body && document.body.textContent ? document.body.textContent : "";
      if (/no matching jobs|no results/i.test(bodyText)) {
        out.warnings.push("LinkedIn reported no matching jobs for these filters");
      } else {
        out.warnings.push(
          "no job cards found with any known selector (selectors unverified - LinkedIn may have changed its markup)",
        );
      }
    }
  } catch (err) {
    out.warnings.push("extractor error: " + String(err && err.message ? err.message : err));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full job posting page (/jobs/view/<id>/).
// Returns the posting's structured fields.
// ---------------------------------------------------------------------------
function extractJobDetail() {
  const out = {
    jobId: "",
    url: String(window.location.href).split("?")[0],
    title: "",
    company: "",
    companyUrl: "",
    location: "",
    workplaceType: "",
    posted: "",
    applicants: "",
    seniorityLevel: "",
    employmentType: "",
    jobFunction: "",
    industries: "",
    applyType: "unknown",
    hiringTeam: [],
    description: "",
    warnings: [],
  };
  try {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const idMatch = out.url.match(/jobs\/view\/(\d+)/);
    if (idMatch) out.jobId = idMatch[1];

    const pick = (sels) => {
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el) return el;
      }
      return null;
    };

    const titleEl = pick([
      ".job-details-jobs-unified-top-card__job-title h1",
      ".job-details-jobs-unified-top-card__job-title",
      ".jobs-unified-top-card__job-title",
      "h1",
    ]);
    out.title = clean(titleEl && titleEl.textContent);

    const companyEl = pick([
      ".job-details-jobs-unified-top-card__company-name a",
      ".jobs-unified-top-card__company-name a",
      ".jobs-top-card__company-url",
      "a[href*='/company/']",
    ]);
    out.company = clean(companyEl && companyEl.textContent);
    out.companyUrl = companyEl && companyEl.getAttribute ? companyEl.getAttribute("href") || "" : "";

    const tertiaryEl = pick([
      ".job-details-jobs-unified-top-card__tertiary-description-container",
      ".jobs-unified-top-card__subtitle-primary-grouping",
      ".jobs-unified-top-card__primary-description",
    ]);
    const tertiary = clean(tertiaryEl && tertiaryEl.textContent);
    if (tertiary) {
      // Shape: "<location> · <posted> · <applicants> applicants" (order varies).
      const am = tertiary.match(/([\d,]+)\s+applicants?/i);
      if (am) out.applicants = am[1];
      const parts = tertiary.split("·").map((p) => clean(p)).filter(Boolean);
      for (const p of parts) {
        if (/applicants?/i.test(p)) continue;
        if (/ago|today|just now|week|month/i.test(p) && !out.posted) {
          out.posted = p;
          continue;
        }
        if (!out.location) out.location = p;
      }
    }

    const wtEl = pick([
      ".jobs-unified-top-card__workplace-type",
      ".job-details-jobs-unified-top-card__workplace-type",
    ]);
    out.workplaceType = clean(wtEl && wtEl.textContent).toLowerCase();

    const critItems = Array.from(
      document.querySelectorAll(
        ".jobs-description__job-criteria-item, .description__job-criteria-item, .job-criteria__item",
      ),
    );
    for (const item of critItems) {
      const label = clean(
        (item.querySelector(".jobs-description__job-criteria-subheader, .description__job-criteria-subheader, h3") || {})
          .textContent,
      ).toLowerCase();
      const value = clean(
        (item.querySelector(".jobs-description__job-criteria-text, .description__job-criteria-text, span") || {})
          .textContent,
      );
      if (/seniority/.test(label)) out.seniorityLevel = value;
      else if (/employment type/.test(label)) out.employmentType = value;
      else if (/job function/.test(label)) out.jobFunction = value;
      else if (/industr/.test(label)) out.industries = value;
    }

    const applyBtn = document.querySelector("button.jobs-apply-button, .jobs-apply-button");
    if (applyBtn) {
      const label = clean((applyBtn.getAttribute && applyBtn.getAttribute("aria-label")) || applyBtn.textContent);
      out.applyType = /easy apply/i.test(label) ? "easy_apply" : "external";
    }

    const posterName = document.querySelector(
      ".hirer-card__hirer-information .jobs-poster__name, .jobs-poster__name, .hirer-card__hirer-name",
    );
    if (posterName) {
      const role = document.querySelector(".hirer-card__hirer-job-title, .jobs-poster__headline");
      const linkEl = posterName.closest("a") || document.querySelector(".hirer-card a[href*='/in/']");
      out.hiringTeam.push({
        name: clean(posterName.textContent),
        headline: clean(role && role.textContent),
        profileUrl:
          linkEl && linkEl.getAttribute ? String(linkEl.getAttribute("href") || "").split("?")[0] : "",
      });
    }

    const descEl = pick(["#job-details", ".jobs-description__content", ".jobs-box__html-content", "article"]);
    out.description = clean(descEl && descEl.textContent).slice(0, 20000);

    if (!out.title) out.warnings.push("job title not found (selectors unverified)");
    if (!out.description) out.warnings.push("description body not found (selectors unverified)");
  } catch (err) {
    out.warnings.push("extractor error: " + String(err && err.message ? err.message : err));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Job alerts page (the account's saved searches with email/push alerts).
// Returns { count, alerts: [...], warnings: [...] }.
// ---------------------------------------------------------------------------
function extractJobAlerts() {
  const out = { count: 0, alerts: [], warnings: [] };
  try {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const cards = Array.from(
      document.querySelectorAll(
        ".job-alerts-card, .saved-search-card, [data-test-job-alerts-card], li.job-alerts__item",
      ),
    );
    for (const card of cards) {
      const titleEl = card.querySelector(
        ".job-alerts-card__title, .saved-search-card__title, h3, a[href*='/jobs/search/']",
      );
      // A bare "p" fallback would match the title first (document order), so
      // the subtitle prefers specific classes and otherwise takes the first
      // paragraph that is not the title.
      let subEl = card.querySelector(".job-alerts-card__subtitle, .saved-search-card__subtitle");
      if (!subEl) {
        const ps = Array.from(card.querySelectorAll("p"));
        subEl = ps.find((p) => p !== titleEl) || null;
      }
      const toggle = card.querySelector("input[type=checkbox], [role=switch], button[aria-checked]");
      let enabled = null;
      if (toggle) {
        if (typeof toggle.checked === "boolean") enabled = toggle.checked;
        else if (toggle.getAttribute && toggle.getAttribute("aria-checked") != null) {
          enabled = toggle.getAttribute("aria-checked") === "true";
        }
      }
      const linkEl = card.querySelector("a[href*='/jobs/search/']");
      let searchUrl = "";
      if (linkEl && linkEl.getAttribute) {
        const raw = linkEl.getAttribute("href") || "";
        // Keep the query string: it IS the saved search's filters.
        searchUrl = raw.startsWith("http") ? raw : raw ? "https://www.linkedin.com" + raw : "";
      }
      out.alerts.push({
        query: clean(titleEl && (titleEl.getAttribute("aria-label") || titleEl.textContent)),
        detail: clean(subEl && subEl.textContent),
        enabled,
        searchUrl,
      });
    }
    out.count = out.alerts.length;
    if (out.count === 0) {
      out.warnings.push(
        "no job-alert cards found with any known selector (selectors unverified - LinkedIn may have changed its markup)",
      );
    }
  } catch (err) {
    out.warnings.push("extractor error: " + String(err && err.message ? err.message : err));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Saved jobs page (/my-items/saved-jobs/).
// arg: { limit }. Returns { count, jobs: [...], warnings: [...] }.
// ---------------------------------------------------------------------------
function extractSavedJobs(arg) {
  const out = { count: 0, jobs: [], warnings: [] };
  try {
    const limit = arg && arg.limit ? arg.limit : 25;
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const cards = Array.from(
      document.querySelectorAll(".my-items-job-card, [data-chameleon-result-urn*='jobPosting'], .entity-result"),
    );
    const seen = {};
    for (const card of cards) {
      if (out.jobs.length >= limit) break;
      const linkEl = card.querySelector("a[href*='/jobs/view/']");
      const href = linkEl && linkEl.getAttribute ? linkEl.getAttribute("href") || "" : "";
      const m = href.match(/jobs\/view\/(\d+)/);
      const jobId = m ? m[1] : "";
      if (!jobId || seen[jobId]) continue;
      seen[jobId] = true;
      const titleEl = card.querySelector(
        ".entity-result__title a, .my-items-job-card__title a, a[href*='/jobs/view/']",
      );
      const companyEl = card.querySelector(
        ".entity-result__primary-subtitle, .my-items-job-card__company",
      );
      const locEl = card.querySelector(
        ".entity-result__secondary-subtitle, .my-items-job-card__location",
      );
      out.jobs.push({
        jobId,
        title: clean(titleEl && (titleEl.getAttribute("aria-label") || titleEl.textContent)),
        company: clean(companyEl && companyEl.textContent),
        location: clean(locEl && locEl.textContent),
        url: "https://www.linkedin.com/jobs/view/" + jobId + "/",
      });
    }
    out.count = out.jobs.length;
    if (out.count === 0) {
      const bodyText = document.body && document.body.textContent ? document.body.textContent : "";
      if (/haven't saved|no saved jobs/i.test(bodyText)) {
        out.warnings.push("the account has no saved jobs");
      } else {
        out.warnings.push(
          "no saved-job cards found with any known selector (selectors unverified - LinkedIn may have changed its markup)",
        );
      }
    }
  } catch (err) {
    out.warnings.push("extractor error: " + String(err && err.message ? err.message : err));
  }
  return out;
}

// ---------------------------------------------------------------------------
// People search results (/search/results/people/?keywords=...).
// READ-ONLY by design: names, headlines, profile URLs only. No connect, no
// message, no follow - those controls are never located here.
// arg: { limit }. Returns { count, people: [...], warnings: [...] }.
// ---------------------------------------------------------------------------
function extractPeople(arg) {
  const out = { count: 0, people: [], warnings: [] };
  try {
    const limit = arg && arg.limit ? arg.limit : 10;
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const cards = Array.from(
      document.querySelectorAll("li.reusable-search__result-container, .entity-result"),
    );
    const seen = {};
    for (const card of cards) {
      if (out.people.length >= limit) break;
      const linkEl = card.querySelector("a[href*='/in/']");
      const href = linkEl && linkEl.getAttribute ? linkEl.getAttribute("href") || "" : "";
      const m = href.match(/\/in\/([^/?]+)/);
      if (!m) continue;
      const slug = m[1];
      if (seen[slug]) continue;
      seen[slug] = true;
      const nameEl =
        card.querySelector(".entity-result__title-text a span[aria-hidden='true']") ||
        card.querySelector(".entity-result__title-text a") ||
        linkEl;
      const headlineEl = card.querySelector(".entity-result__primary-subtitle");
      const locEl = card.querySelector(".entity-result__secondary-subtitle");
      const name = clean(nameEl && (nameEl.getAttribute("aria-label") || nameEl.textContent)).replace(
        /\s*·\s*(1st|2nd|3rd).*$/,
        "",
      );
      if (!name) continue;
      out.people.push({
        name,
        headline: clean(headlineEl && headlineEl.textContent),
        location: clean(locEl && locEl.textContent),
        profileUrl: "https://www.linkedin.com/in/" + slug + "/",
      });
    }
    out.count = out.people.length;
    if (out.count === 0) {
      const bodyText = document.body && document.body.textContent ? document.body.textContent : "";
      if (/no results/i.test(bodyText)) {
        out.warnings.push("LinkedIn reported no people results for this query");
      } else {
        out.warnings.push(
          "no people results found with any known selector (selectors unverified - LinkedIn may have changed its markup)",
        );
      }
    }
  } catch (err) {
    out.warnings.push("extractor error: " + String(err && err.message ? err.message : err));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Save-button helpers for linkedin_save_job (the build's only write).
// clickSaveJob clicks the job page's Save button; readSaveState reads whether
// the job now shows as saved. Neither touches anything else on the page.
// ---------------------------------------------------------------------------
function clickSaveJob() {
  const out = { clicked: false, reason: "" };
  try {
    const btn =
      document.querySelector("button.jobs-save-button, .jobs-save-button button") ||
      Array.from(document.querySelectorAll("button")).find((b) => {
        const label = ((b.getAttribute && b.getAttribute("aria-label")) || b.textContent || "").trim();
        return /^save$|^save job|^unsave$|^saved$/i.test(label);
      });
    if (!btn) {
      out.reason = "no Save button found on this page (selectors unverified)";
      return out;
    }
    const label = ((btn.getAttribute && btn.getAttribute("aria-label")) || btn.textContent || "").trim();
    if (/^unsave$|^saved$/i.test(label) || btn.getAttribute("aria-pressed") === "true") {
      out.reason = "job is already saved";
      return out;
    }
    btn.click();
    out.clicked = true;
  } catch (err) {
    out.reason = String(err && err.message ? err.message : err);
  }
  return out;
}

function readSaveState() {
  const out = { saved: null, label: "" };
  try {
    const btn =
      document.querySelector("button.jobs-save-button, .jobs-save-button button") ||
      Array.from(document.querySelectorAll("button")).find((b) => {
        const label = ((b.getAttribute && b.getAttribute("aria-label")) || b.textContent || "").trim();
        return /^save$|^save job|^unsave$|^saved$/i.test(label);
      });
    if (!btn) return out;
    const label = ((btn.getAttribute && btn.getAttribute("aria-label")) || btn.textContent || "").trim();
    out.label = label;
    if (/^unsave$|^saved$/i.test(label) || btn.getAttribute("aria-pressed") === "true") out.saved = true;
    else if (/^save/i.test(label)) out.saved = false;
  } catch (err) {
    // leave saved: null
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gentle scroll of the jobs results list so lazy-rendered cards appear.
// Async: resolves after a few small human-like scroll steps. No network of
// its own beyond what the page does when scrolled.
// ---------------------------------------------------------------------------
function scrollResultsList() {
  return new Promise((resolve) => {
    try {
      const container =
        document.querySelector(".jobs-search-results-list") ||
        document.querySelector(".scaffold-layout__list-container") ||
        document.scrollingElement;
      if (!container) {
        resolve({ scrolled: false });
        return;
      }
      let step = 0;
      const steps = 4;
      const tick = () => {
        step += 1;
        const max = container.scrollHeight - container.clientHeight;
        const pos = Math.min(max, Math.round((max * step) / steps));
        if (typeof container.scrollTo === "function") container.scrollTo(0, pos);
        else container.scrollTop = pos;
        if (step < steps) setTimeout(tick, 450);
        else setTimeout(() => resolve({ scrolled: true }), 500);
      };
      tick();
    } catch (err) {
      resolve({ scrolled: false });
    }
  });
}

module.exports = {
  callSource,
  probePage,
  extractJobCards,
  extractJobDetail,
  extractJobAlerts,
  extractSavedJobs,
  extractPeople,
  clickSaveJob,
  readSaveState,
  scrollResultsList,
};
// NOTE: clickSaveJob and readSaveState deliberately duplicate the Save-button
// lookup inline. Every exported function must stay self-contained so its
// toString() runs alone inside the page; a shared helper would be undefined
// there.
