/**
 * `job-seeker import-legacy` (design 5.4 item 4): read the predecessor's
 * `state/seen_jobs.json`, `state/last_run.json` and `tracker.csv` into the
 * database, recording what was imported. It is repeatable and idempotent
 * until phase 8: each run merges newly seen jobs and tracker rows and skips
 * what it already imported.
 *
 * - Every seen job becomes a job (or merges into the job it duplicates),
 *   with a `legacy:<source>` sighting. Its predecessor score, which the
 *   posting-scorer agent made, is kept as an `assistant` score marked
 *   `legacy_import`: its gate vetoes still hold, but the shown score is the
 *   rule score until a new judgement is made.
 * - Every tracker row becomes an application on its job (a new job when no
 *   stored job matches), with the predecessor's status mapped onto the new
 *   states. A row whose status changed since the last import moves the
 *   application on.
 * - The last run's shortlist becomes `shortlisted` applications for jobs
 *   that have none yet.
 *
 * The files are only read. Nothing is written outside the data directory.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { transaction } from "../store/db.js";
import { parseIsoDate, isoDate } from "../util/clock.js";
import { norm, sha256 } from "../util/text.js";
import { setApplicationState, type ApplicationState } from "../core/applications.js";
import { emitEvent, EngineError, nowIso, type CoreContext } from "../core/context.js";
import { auditSeen } from "../core/dedupe/jobKey.js";
import { canonicalizeUrl } from "../core/dedupe/urlCanon.js";
import { addSighting, findExisting, insertJob, scoreJobByRules } from "../core/jobs.js";

/** Marks an imported event whose tracker date was not a full day; its `at` is the import time. */
export const LEGACY_DATE_NOTE = "legacy date: ";

export class LegacyStateError extends EngineError {
  override name = "LegacyStateError";
  constructor(message: string) {
    super(message, "legacy_state");
  }
}

/** The predecessor's tracker statuses, mapped onto the application states. */
export const STATUS_MAP: Record<string, ApplicationState> = {
  found: "found",
  prospect: "shortlisted",
  shortlisted: "shortlisted",
  drafted: "resume_prepared",
  resume_prepared: "resume_prepared",
  applied: "applied",
  interview: "interview",
  offer: "offer",
  hired: "offer",
  rejected: "rejected",
  no_response: "rejected",
  "no response": "rejected",
  withdrawn: "rejected",
  offer_declined: "rejected",
  "offer declined": "rejected",
};

const SEEN_STATUS: Record<string, string> = {
  new: "active",
  ranked: "active",
  skipped: "skipped",
  expired: "expired",
  unreachable: "unreachable",
};

export interface LegacyPaths {
  seen_jobs: string | null;
  last_run: string | null;
  tracker: string | null;
}

export function resolveLegacyPaths(input: { from?: string; seen_jobs?: string; last_run?: string; tracker?: string }): LegacyPaths {
  const base = input.from ? resolve(input.from) : null;
  const pick = (explicit: string | undefined, relative: string): string | null => {
    if (explicit) {
      const path = resolve(explicit);
      if (!existsSync(path)) throw new LegacyStateError(`${path} not found`);
      return path;
    }
    if (!base) return null;
    const path = join(base, relative);
    return existsSync(path) ? path : null;
  };
  if (base && !existsSync(base)) throw new LegacyStateError(`${base} not found`);
  const paths = {
    seen_jobs: pick(input.seen_jobs, join("state", "seen_jobs.json")),
    last_run: pick(input.last_run, join("state", "last_run.json")),
    tracker: pick(input.tracker, "tracker.csv"),
  };
  if (!paths.seen_jobs && !paths.last_run && !paths.tracker) {
    throw new LegacyStateError(
      "found nothing to import: give --from <the predecessor's folder> (holding state/seen_jobs.json and tracker.csv), or --seen-jobs / --tracker / --last-run",
    );
  }
  return paths;
}

/** The predecessor's seen-jobs map. Port of rank_state.load_state's checks. */
export function readSeenJobs(path: string): Record<string, Record<string, unknown>> {
  if (!existsSync(path)) throw new LegacyStateError(`${path} not found - run the predecessor's run-alerts ingest first`);
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new LegacyStateError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  const seen = doc && typeof doc === "object" && !Array.isArray(doc) && "seen" in doc ? (doc as { seen: unknown }).seen : doc;
  if (!seen || typeof seen !== "object" || Array.isArray(seen)) throw new LegacyStateError(`${path}: expected an object of job entries`);
  return seen as Record<string, Record<string, unknown>>;
}

/** RFC 4180 CSV with a header row, like Python's csv.DictReader over utf-8-sig. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const body = text.replace(/^\ufeff/, "");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }
  const rows = records.filter((r) => !(r.length === 1 && r[0] === ""));
  const header = rows.shift() ?? [];
  return rows.map((r) => {
    const out: Record<string, string> = {};
    header.forEach((name, i) => {
      if (name) out[name] = r[i] ?? "";
    });
    return out;
  });
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function alreadyImported(ctx: CoreContext, kind: string, key: string): string | null | undefined {
  const row = ctx.db.prepare("SELECT job_id FROM legacy_imports WHERE kind = ? AND legacy_key = ?").get(kind, key) as { job_id: string | null } | undefined;
  return row === undefined ? undefined : row.job_id;
}

function record(ctx: CoreContext, kind: string, key: string, jobId: string | null): void {
  ctx.db.prepare("INSERT INTO legacy_imports (kind, legacy_key, job_id, imported_at) VALUES (?, ?, ?, ?)").run(kind, key, jobId, nowIso(ctx));
}

function sourceName(value: unknown): string {
  const text = String(value ?? "unknown").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `legacy:${text || "unknown"}`;
}

function importSeen(ctx: CoreContext, seen: Record<string, Record<string, unknown>>) {
  const counts = { read: 0, imported: 0, already_imported: 0, merged_duplicates: 0, invalid: 0 };
  for (const [key, entry] of Object.entries(seen)) {
    counts.read++;
    if (alreadyImported(ctx, "seen_job", key) !== undefined) {
      counts.already_imported++;
      continue;
    }
    if (!entry || typeof entry !== "object" || !str(entry.title) || !str(entry.company)) {
      counts.invalid++;
      record(ctx, "seen_job", key, null);
      continue;
    }
    const rawUrl = str(entry.url);
    const url = rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : null;
    const firstSeen = parseIsoDate(entry.first_seen) ?? isoDate(ctx.clock.now());
    const match = findExisting(ctx, url ? canonicalizeUrl(url) : null, entry.company, entry.title);
    let jobId: string;
    if (match) {
      jobId = match.id;
      counts.merged_duplicates++;
    } else {
      jobId = insertJob(ctx, {
        title: str(entry.title) as string,
        company: str(entry.company) as string,
        url,
        location: str(entry.location),
        deadline: str(entry.deadline),
        posted_at: str(entry.posted_date),
        partial: true,
        first_seen: firstSeen,
        status: SEEN_STATUS[String(entry.status)] ?? "active",
      });
      if (entry.status === "unreachable" || Number.isInteger(entry.fetch_attempts)) {
        ctx.db
          .prepare("UPDATE jobs SET fetch_attempts = ?, first_unreachable = ?, last_fetch_error = ?, expired_reason = ? WHERE id = ?")
          .run(
            Number.isInteger(entry.fetch_attempts) ? (entry.fetch_attempts as number) : null,
            str(entry.first_unreachable),
            str(entry.last_fetch_error),
            str(entry.expired_reason),
            jobId,
          );
      }
      counts.imported++;
    }
    addSighting(ctx, jobId, {
      connector: sourceName(entry.source),
      rawUrl: rawUrl,
      seenAt: `${firstSeen}T00:00:00.000Z`,
      record: JSON.stringify({ schema: "legacy.seen_job", key, entry }),
    });
    if (typeof entry.rank_score === "number" && entry.rank_score >= 0 && entry.rank_score <= 100) {
      storeLegacyScore(ctx, jobId, entry);
    }
    scoreJobByRules(ctx, jobId);
    record(ctx, "seen_job", key, jobId);
  }
  return counts;
}

/** Keep the predecessor's score as an assistant judgement marked legacy_import. */
function storeLegacyScore(ctx: CoreContext, jobId: string, entry: Record<string, unknown>): void {
  const score = Math.round(entry.rank_score as number);
  const gates = {
    location_verdict: ["PASS", "FAIL", "FLAG"].includes(String(entry.location_verdict)) ? String(entry.location_verdict) : "PASS",
    seniority_gate: ["PASS", "FAIL", "FLAG"].includes(String(entry.seniority_gate)) ? String(entry.seniority_gate) : "PASS",
    engineering_role: entry.engineering_role === true,
  };
  const vetoed = gates.location_verdict === "FAIL" || gates.seniority_gate === "FAIL" || gates.engineering_role;
  ctx.db
    .prepare(
      `INSERT INTO job_scores (job_id, profile_version, criteria_version, method, score, band, gates, vetoed, dimensions, reason, strengths, gaps, guard, basis, scored_at)
       VALUES (?, NULL, NULL, 'assistant', ?, ?, ?, ?, '{}', ?, ?, ?, ?, 'legacy_import', ?)`,
    )
    .run(
      jobId,
      score,
      typeof entry.rank_verdict === "string" ? entry.rank_verdict : "",
      JSON.stringify(gates),
      vetoed ? 1 : 0,
      typeof entry.reason === "string" ? entry.reason.slice(0, 200) : null,
      JSON.stringify(Array.isArray(entry.strengths) ? entry.strengths.map(String).slice(0, 3) : []),
      JSON.stringify(Array.isArray(entry.gaps) ? entry.gaps.map(String).slice(0, 3) : []),
      typeof entry.guard === "string" ? entry.guard.slice(0, 200) : null,
      typeof entry.rank_date === "string" && parseIsoDate(entry.rank_date) ? `${entry.rank_date}T00:00:00.000Z` : nowIso(ctx),
    );
}

function importTracker(ctx: CoreContext, rows: Array<Record<string, string>>) {
  const counts = { read: 0, imported: 0, already_imported: 0, matched_jobs: 0, new_jobs: 0, unmapped_statuses: [] as string[] };
  for (const row of rows) {
    counts.read++;
    const company = str(row.company);
    const role = str(row.role) ?? str(row.title);
    const rawStatus = (row.status ?? "").trim();
    const key = sha256([row.date ?? "", norm(company), norm(role), rawStatus.toLowerCase()].join("|")).slice(0, 24);
    if (alreadyImported(ctx, "tracker_row", key) !== undefined) {
      counts.already_imported++;
      continue;
    }
    if (!company) {
      record(ctx, "tracker_row", key, null);
      continue;
    }
    const sourceUrl = str(row.source) && /^https?:\/\//i.test(row.source as string) ? (row.source as string).trim() : null;
    const date = (row.date ?? "").trim();
    const fullDate = parseIsoDate(date);
    const title = role ?? "(untitled role)";
    let job = findExisting(ctx, sourceUrl ? canonicalizeUrl(sourceUrl) : null, company, title);
    if (job) counts.matched_jobs++;
    else {
      const id = insertJob(ctx, {
        title,
        company,
        url: sourceUrl,
        deadline: str(row.deadline),
        partial: true,
        first_seen: fullDate ?? isoDate(ctx.clock.now()),
      });
      addSighting(ctx, id, {
        connector: "legacy:tracker",
        rawUrl: sourceUrl,
        record: JSON.stringify({ schema: "legacy.tracker_row", row }),
        seenAt: fullDate ? `${fullDate}T00:00:00.000Z` : undefined,
      });
      scoreJobByRules(ctx, id);
      counts.new_jobs++;
      job = { id } as NonNullable<typeof job>;
    }
    const deadline = parseIsoDate(row.deadline);
    if (deadline) ctx.db.prepare("UPDATE jobs SET deadline = COALESCE(deadline, ?) WHERE id = ?").run(deadline, job.id);
    const mapped = STATUS_MAP[rawStatus.toLowerCase()];
    if (!mapped && !counts.unmapped_statuses.includes(rawStatus)) counts.unmapped_statuses.push(rawStatus);
    const noteParts = [
      str(row.notes),
      mapped && rawStatus.toLowerCase() === mapped ? null : `legacy status: ${rawStatus || "(blank)"}`,
      date && !fullDate ? `${LEGACY_DATE_NOTE}${date}` : null,
    ];
    setApplicationState(ctx, job.id, mapped ?? "found", {
      reported_by: "import",
      channel: "import",
      note: noteParts.filter(Boolean).join(" - ") || null,
      at: fullDate ? `${fullDate}T00:00:00.000Z` : nowIso(ctx),
    });
    record(ctx, "tracker_row", key, job.id);
    counts.imported++;
  }
  return counts;
}

function importShortlist(ctx: CoreContext, path: string) {
  const counts = { read: 0, imported: 0, already_imported: 0, skipped_with_application: 0, unknown_keys: 0 };
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new LegacyStateError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  const ranked = doc && typeof doc === "object" && Array.isArray((doc as { ranked?: unknown }).ranked) ? (doc as { ranked: unknown[] }).ranked : [];
  for (const item of ranked) {
    const key = item && typeof item === "object" ? (item as { key?: unknown }).key : null;
    if (typeof key !== "string" || !key) continue;
    counts.read++;
    if (alreadyImported(ctx, "shortlist", key) !== undefined) {
      counts.already_imported++;
      continue;
    }
    const jobId = alreadyImported(ctx, "seen_job", key);
    if (!jobId) {
      counts.unknown_keys++;
      continue;
    }
    if (ctx.db.prepare("SELECT 1 FROM applications WHERE job_id = ?").get(jobId)) {
      counts.skipped_with_application++;
    } else {
      setApplicationState(ctx, jobId, "shortlisted", { reported_by: "import", channel: "import", note: "on the predecessor's last shortlist" });
      counts.imported++;
    }
    record(ctx, "shortlist", key, jobId);
  }
  return counts;
}

export function importLegacy(ctx: CoreContext, input: { from?: string; seen_jobs?: string; last_run?: string; tracker?: string }) {
  const paths = resolveLegacyPaths(input);
  const seen = paths.seen_jobs ? readSeenJobs(paths.seen_jobs) : null;
  let audit: unknown = null;
  if (seen) {
    try {
      audit = auditSeen({ seen }).report;
    } catch (error) {
      throw new LegacyStateError(`${paths.seen_jobs}: ${(error as Error).message}`);
    }
  }
  let trackerRows: Array<Record<string, string>> = [];
  if (paths.tracker) {
    const bytes = readFileSync(paths.tracker);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new LegacyStateError(`${paths.tracker} is not UTF-8 text - re-save it as CSV UTF-8`);
    }
    trackerRows = parseCsv(text);
  }
  const result = transaction(ctx.db, () => {
    const seenCounts = seen ? importSeen(ctx, seen) : { read: 0, imported: 0, already_imported: 0, merged_duplicates: 0, invalid: 0 };
    const trackerCounts = importTracker(ctx, trackerRows);
    const shortlistCounts = paths.last_run
      ? importShortlist(ctx, paths.last_run)
      : { read: 0, imported: 0, already_imported: 0, skipped_with_application: 0, unknown_keys: 0 };
    const totals = {
      jobs: (ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n,
      applications: (ctx.db.prepare("SELECT COUNT(*) AS n FROM applications").get() as { n: number }).n,
    };
    const summary = { at: nowIso(ctx), seen_jobs: seenCounts.read, tracker_rows: trackerCounts.read, shortlist: shortlistCounts.read };
    ctx.db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('legacy.last_import', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(JSON.stringify(summary), summary.at);
    emitEvent(ctx, "legacy.imported", "legacy_import", null, {
      seen_jobs: seenCounts,
      tracker: { ...trackerCounts },
      shortlist: shortlistCounts,
    });
    return { sources: paths, seen_jobs: seenCounts, tracker: trackerCounts, shortlist: shortlistCounts, audit, totals };
  });
  return result;
}

