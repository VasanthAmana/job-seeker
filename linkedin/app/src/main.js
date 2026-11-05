"use strict";
// linkedin-mcp: the Electron main process.
//
// The shape of Zook, narrowed to one site and a read-mostly tool set:
//   - ONE BrowserWindow on ONE persistent partition (persist:linkedin-mcp).
//     The user signs into LinkedIn by hand, once; the session lives in the
//     partition for as long as LinkedIn allows.
//   - The app NEVER types, stores or reads a LinkedIn password, OTP or 2FA
//     code, and NEVER answers a bot check. There is no code path that fills a
//     form. When a page shows a sign-in or a challenge, the tool returns
//     "LinkedIn needs you", the window comes to the front, and a human takes
//     over.
//   - Page work goes through the Pacer: one request at a time, a random
//     seconds-long gap between page loads, a per-hour cap, session cache.
//   - The only write is linkedin_save_job, gated by confirm: true.
//   - MCP tools are served on a 0600 UNIX socket; bin/linkedin-mcp relays
//     stdio for Claude Code.

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, Menu, session, shell } = require("electron");

const { userDataDir, socketPath } = require("./paths");
const urls = require("./urls");
const extractors = require("./extractors");
const { Pacer, PaceCapError } = require("./pacing");
const { SessionCache } = require("./cache");
const { table, renderToolResult } = require("./format");
const tools = require("./tools");
const { startMcpServer } = require("./server");
const capture = require("./capture");

const PARTITION = "persist:linkedin-mcp";
const LINKEDIN_HOSTS = /(^|\.)linkedin\.com$/i;

const MAX_LOADS_PER_HOUR = Number.parseInt(process.env.LINKEDIN_MCP_MAX_LOADS_PER_HOUR || "40", 10);
const SEARCH_PAGE_SIZE = 25; // LinkedIn renders ~25 jobs per search page
const SETTLE_MS = 1500; // let the page paint before reading it

const pacer = new Pacer({ maxLoadsPerHour: MAX_LOADS_PER_HOUR });
const cache = new SessionCache({ ttlMs: 600_000 });
const CAPTURE_DIR = capture.captureDir(process.env, userDataDir());

let win = null;
let mcp = null;
let lastProbe = { state: "unknown", url: "", reason: "no page probed yet" };

class NeedsYouError extends Error {
  constructor(reason, url) {
    super(
      `LinkedIn needs you: ${reason}. The linkedin-mcp window is on screen now - ` +
        `finish the step there by hand, then retry. The app never types a password, ` +
        `OTP or 2FA code and never answers a security check.`,
    );
    this.name = "NeedsYouError";
    this.url = url || "";
  }
}

// ---------------------------------------------------------------------------
// Page driving
// ---------------------------------------------------------------------------

async function evalInPage(fn, arg) {
  return win.webContents.executeJavaScript(extractors.callSource(fn, arg), true);
}

async function probeCurrentPage() {
  try {
    const probe = await evalInPage(extractors.probePage);
    lastProbe = probe;
    return probe;
  } catch (err) {
    lastProbe = { state: "signed_out", url: "", reason: "page not reachable: " + err.message };
    return lastProbe;
  }
}

function demandAttention(probe) {
  if (win) {
    win.show();
    win.focus();
    win.webContents
      .executeJavaScript(
        `document.title = "⚠ LinkedIn needs you - " + document.title; "ok";`,
        true,
      )
      .catch(() => {});
  }
  throw new NeedsYouError(probe.reason, probe.url);
}

// Load a URL through the pacer, wait for the page to settle, and refuse to
// read anything but a healthy signed-in page.
async function loadSignedInPage(url) {
  return pacer.run(async () => {
    await win.webContents.loadURL(url);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const probe = await probeCurrentPage();
    if (probe.state !== "ok") demandAttention(probe);
    return probe;
  });
}

// Step 1 of the LinkedIn-markup-changed fix: on a zero-result/failed-parse
// payload, save the page already loaded for this call (no extra navigation,
// no extra page load, so it never touches the pacer's budget). Returns the
// value to attach to the tool's response as `capture` (null if not
// triggered), so where a capture went is visible in the result, not just the
// logs.
async function captureFromLivePage(toolName, payload) {
  return capture.captureIfTriggered({
    toolName,
    payload,
    dir: CAPTURE_DIR,
    getPage: async () => ({
      url: win.webContents.getURL(),
      html: await win.webContents.executeJavaScript("document.documentElement.outerHTML", true),
      png: (await win.webContents.capturePage()).toPNG(),
    }),
  });
}

// ---------------------------------------------------------------------------
// Tool handlers (each returns an MCP result: { content: [...] })
// ---------------------------------------------------------------------------

function ok(payload, tableText) {
  return { content: renderToolResult(payload, tableText) };
}

async function cached(name, args, produce) {
  const key = SessionCache.key(name, args);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const result = await produce();
  cache.set(key, result);
  return result;
}

async function searchJobs(args) {
  const limit = args.limit || 10;
  const jobs = [];
  const warnings = [];
  let start = 0;
  let pagesLoaded = 0;
  while (jobs.length < limit) {
    const url = urls.searchJobsUrl({
      query: args.query,
      location: args.location,
      remote: args.remote,
      experienceLevels: args.experience_levels,
      datePosted: args.date_posted === "any" ? undefined : args.date_posted,
      jobType: args.job_type,
      start,
    });
    await loadSignedInPage(url);
    pagesLoaded += 1;
    await pacer.run(() => evalInPage(extractors.scrollResultsList), { billable: false });
    const page = await pacer.run(() => evalInPage(extractors.extractJobCards, { limit: 25 }), {
      billable: false,
    });
    warnings.push(...(page.warnings || []));
    if (!page.jobs || page.jobs.length === 0) break;
    for (const job of page.jobs) {
      if (jobs.length >= limit) break;
      if (!jobs.some((j) => j.jobId === job.jobId)) jobs.push(job);
    }
    if (page.jobs.length < SEARCH_PAGE_SIZE) break; // a short page is the last page
    start += SEARCH_PAGE_SIZE;
  }
  const payload = { query: args.query, filters: args, count: jobs.length, jobs, warnings };
  payload.capture = await captureFromLivePage("linkedin_search_jobs", payload);
  const rows = jobs.map((j) => [
    j.title,
    j.company,
    j.location + (j.workplaceType ? ` (${j.workplaceType})` : ""),
    j.posted,
    j.applicants ? `${j.applicants} appl.` : "",
    j.jobId,
  ]);
  return ok(payload, table(["TITLE", "COMPANY", "LOCATION", "POSTED", "APPLICANTS", "JOB ID"], rows));
}

async function getJob(args) {
  const ref = urls.jobView(args.job_id || args.url);
  if (!ref) throw new Error("could not parse a LinkedIn job id from the input");
  await loadSignedInPage(ref.url);
  const detail = await pacer.run(() => evalInPage(extractors.extractJobDetail), { billable: false });
  detail.capture = await captureFromLivePage("linkedin_get_job", detail);
  const descPreview = detail.description.length > 600 ? detail.description.slice(0, 600) + "…" : detail.description;
  const text = [
    `${detail.title} — ${detail.company}`,
    `${detail.location}${detail.workplaceType ? " (" + detail.workplaceType + ")" : ""} · ${detail.posted}${
      detail.applicants ? " · " + detail.applicants + " applicants" : ""
    }`,
    `Seniority: ${detail.seniorityLevel || "?"} · Employment: ${detail.employmentType || "?"} · Apply: ${detail.applyType}`,
    detail.hiringTeam.length > 0
      ? `Hiring team: ${detail.hiringTeam.map((h) => `${h.name} (${h.headline}) ${h.profileUrl}`).join("; ")}`
      : "",
    "",
    descPreview,
  ]
    .filter((l) => l !== "")
    .join("\n");
  return ok(detail, text);
}

async function listJobAlerts() {
  await loadSignedInPage(urls.JOB_ALERTS_URL);
  const data = await pacer.run(() => evalInPage(extractors.extractJobAlerts), { billable: false });
  data.capture = await captureFromLivePage("linkedin_list_job_alerts", data);
  const rows = data.alerts.map((a) => [
    a.query,
    a.detail,
    a.enabled === null ? "?" : a.enabled ? "on" : "off",
  ]);
  return ok(data, table(["ALERT QUERY", "DETAIL", "ENABLED"], rows, { maxColWidth: 60 }));
}

async function listSavedJobs(args) {
  await loadSignedInPage(urls.SAVED_JOBS_URL);
  const data = await pacer.run(() => evalInPage(extractors.extractSavedJobs, { limit: args.limit || 25 }), {
    billable: false,
  });
  data.capture = await captureFromLivePage("linkedin_list_saved_jobs", data);
  const rows = data.jobs.map((j) => [j.title, j.company, j.location, j.jobId]);
  return ok(data, table(["TITLE", "COMPANY", "LOCATION", "JOB ID"], rows));
}

async function searchPeople(args) {
  const url = urls.peopleSearchUrl({ query: args.query, company: args.company, title: args.title });
  await loadSignedInPage(url);
  const data = await pacer.run(() => evalInPage(extractors.extractPeople, { limit: args.limit || 10 }), {
    billable: false,
  });
  const rows = data.people.map((p) => [p.name, p.headline, p.location, p.profileUrl]);
  return ok(data, table(["NAME", "HEADLINE", "LOCATION", "PROFILE"], rows, { maxColWidth: 44 }));
}

async function saveJob(args) {
  // validateArgs has already enforced confirm === true; belt and braces here
  // because this is the build's only write.
  if (args.confirm !== true) {
    throw new Error("refused: confirm: true is required. Nothing was changed.");
  }
  const ref = urls.jobView(args.job_id || args.url);
  if (!ref) throw new Error("could not parse a LinkedIn job id from the input");
  await loadSignedInPage(ref.url);
  const click = await pacer.run(() => evalInPage(extractors.clickSaveJob), { billable: false });
  let saved = null;
  if (click.clicked) {
    await new Promise((r) => setTimeout(r, 1200));
    const state = await pacer.run(() => evalInPage(extractors.readSaveState), { billable: false });
    saved = state.saved;
  }
  const payload = { jobId: ref.jobId, url: ref.url, clicked: click.clicked, saved, note: click.reason || "" };
  const text =
    click.reason === "job is already saved"
      ? `Job ${ref.jobId} was already saved.`
      : click.clicked
        ? `Clicked Save for job ${ref.jobId}; LinkedIn now shows: ${saved === true ? "saved" : saved === false ? "NOT saved" : "unknown"}.`
        : `Could not save job ${ref.jobId}: ${click.reason}. Nothing was changed.`;
  return ok(payload, text);
}

function status() {
  const payload = {
    app: "linkedin-mcp",
    socket: socketPath(),
    window: win ? (win.isVisible() ? "visible" : "hidden") : "none",
    linkedin: lastProbe,
    pace: pacer.stats(),
    cacheEntries: cache.size,
  };
  const text = [
    `socket: ${payload.socket}`,
    `linkedin: ${lastProbe.state}${lastProbe.reason ? " (" + lastProbe.reason + ")" : ""}`,
    `page loads this hour: ${payload.pace.loadsInLastHour}/${payload.pace.maxLoadsPerHour}`,
    `cache entries: ${payload.cacheEntries}`,
  ].join("\n");
  return ok(payload, text);
}

const HANDLERS = {
  linkedin_search_jobs: (args) => cached("linkedin_search_jobs", args, () => searchJobs(args)),
  linkedin_get_job: (args) => cached("linkedin_get_job", args, () => getJob(args)),
  linkedin_list_job_alerts: (args) => cached("linkedin_list_job_alerts", args, () => listJobAlerts(args)),
  linkedin_list_saved_jobs: (args) => cached("linkedin_list_saved_jobs", args, () => listSavedJobs(args)),
  linkedin_search_people: (args) => cached("linkedin_search_people", args, () => searchPeople(args)),
  linkedin_save_job: (args) => saveJob(args), // a write is never cached
  linkedin_status: () => Promise.resolve(status()),
};

async function callTool(name, rawArgs) {
  const check = tools.validateArgs(name, rawArgs);
  if (!check.ok) {
    return { content: [{ type: "text", text: "error: " + check.error }], isError: true };
  }
  try {
    return await HANDLERS[name](check.args);
  } catch (err) {
    const prefix = err instanceof NeedsYouError ? "" : err instanceof PaceCapError ? "" : "error: ";
    return { content: [{ type: "text", text: prefix + err.message }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

function hardenSession(ses) {
  // The site gets no special permissions, ever.
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // Read as an ordinary Chrome, not as "Electron": strip the Electron token.
  const ua = ses.getUserAgent().replace(/\s*Electron\/\S+/, "");
  ses.setUserAgent(ua);
}

function isLinkedInUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && LINKEDIN_HOSTS.test(u.hostname);
  } catch (err) {
    return false;
  }
}

function createWindow() {
  const ses = session.fromPartition(PARTITION);
  hardenSession(ses);

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "linkedin-mcp",
    backgroundColor: "#0a66c2",
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);

  // Keep the window inside LinkedIn. Any other destination opens in the
  // system browser, where the app's session cannot follow it.
  win.webContents.on("will-navigate", (event, target) => {
    if (!isLinkedInUrl(target)) {
      event.preventDefault();
      if (target.startsWith("https://")) shell.openExternal(target);
    }
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith("https://")) shell.openExternal(target);
    return { action: "deny" };
  });
  win.on("closed", () => {
    win = null;
  });

  win.loadURL(urls.JOBS_HOME_URL);
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        {
          label: "Show linkedin-mcp",
          accelerator: "CmdOrCtrl+1",
          click: () => {
            if (win) {
              win.show();
              win.focus();
            }
          },
        },
        { type: "separator" },
        {
          label: "Sign out of LinkedIn (clear this app's session only)",
          click: async () => {
            await session.fromPartition(PARTITION).clearStorageData();
            cache.clear();
            lastProbe = { state: "unknown", url: "", reason: "session cleared" };
            if (win) win.loadURL(urls.JOBS_HOME_URL);
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      role: "editMenu",
    },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "togglefullscreen" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Keep Chromium's profile (and with it the persist:linkedin-mcp partition)
  // inside the same per-OS user-data directory the MCP endpoint paths use.
  app.setPath("userData", userDataDir());
  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    const dataDir = userDataDir();
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dataDir, 0o700);
    } catch (err) {
      /* best effort */
    }

    buildMenu();
    createWindow();

    mcp = await startMcpServer({
      socketPath: socketPath(),
      catalogue: tools.TOOLS,
      callTool,
    });
    console.log(`linkedin-mcp: MCP socket at ${mcp.socketPath} (mode 0600)`);
  });

  app.on("window-all-closed", () => {
    // Keep running with no window on macOS? No: this app exists to serve the
    // tools, and the tools need the page. Quit when the window closes.
    app.quit();
  });

  app.on("quit", () => {
    if (mcp) mcp.close();
  });
}
