/**
 * Jobs: ingest, dedupe, storage and the ranked views (design 8).
 *
 * Reshaped from tools/alert_state.py onto SQLite: candidate selection keeps
 * the predecessor's rules (a candidate needs only a valid posting URL;
 * dedupe by canonical URL and by company+title against stored jobs, jobs
 * with an application, and repeats inside the batch), and storing needs the
 * full identity. Unlike the JSON store, a repeat is not dropped: it is kept
 * as another sighting, so a job keeps every source (design 8.2). Every
 * write runs in one transaction, which replaces the predecessor's file lock.
 */
import { makeKey } from "./dedupe/jobKey.js";
import { canonicalizeUrl, urlsplit } from "./dedupe/urlCanon.js";
import { guard, type GuardFindings } from "./guard/postingGuard.js";
import { emitEvent, EngineError, nowIso, parseJson, type CoreContext } from "./context.js";
import { ruleScore, type RuleScore } from "./ranking/rules.js";
import { isVeto, score10, URGENT_DAYS } from "./ranking/score.js";
import { transaction } from "../store/db.js";
import { addDays, isoDate, parseIsoDate } from "../util/clock.js";
import { canonicalJson, norm, sha256 } from "../util/text.js";

export interface PostingRecord {
  schema?: string;
  title?: unknown;
  company?: unknown;
  location?: unknown;
  workplace?: unknown;
  url?: unknown;
  source?: unknown;
  external_id?: unknown;
  posted_at?: unknown;
  deadline?: unknown;
  salary?: unknown;
  seniority?: unknown;
  partial?: unknown;
  description?: unknown;
  description_html?: unknown;
  [key: string]: unknown;
}

export interface Counts {
  already_seen: number;
  already_applied: number;
  repeated_in_batch: number;
  invalid: Array<{ index: number; error: string }>;
}

export interface DedupeIndex {
  urls: Set<string>;
  pairs: Set<string>;
  applied: Set<string>;
}

const pairKey = (company: unknown, title: unknown) => `${norm(company)}|${norm(title)}`;

/** A candidate's identity at ingest time: its canonicalised posting URL. */
export function candidateUrl(job: PostingRecord): string {
  const url = job.url;
  if (typeof url !== "string" || !url.trim()) throw new Error("job needs a non-empty url");
  const trimmed = url.trim();
  const parsed = urlsplit(trimmed);
  if (!["http", "https"].includes(parsed.scheme) || !parsed.netloc) {
    throw new Error(`job has an invalid posting URL: ${trimmed}`);
  }
  return canonicalizeUrl(trimmed);
}

/**
 * Select the records worth looking at. Port of alert_state.select: the
 * counts say why each skipped record was skipped.
 */
export function selectCandidates(
  jobs: unknown[],
  index: DedupeIndex,
): { selected: Array<{ index: number; job: PostingRecord; url: string }>; counts: Counts } {
  const selected: Array<{ index: number; job: PostingRecord; url: string }> = [];
  const counts: Counts = { already_seen: 0, already_applied: 0, repeated_in_batch: 0, invalid: [] };
  const batchUrls = new Set<string>();
  const batchPairs = new Set<string>();
  jobs.forEach((raw, i) => {
    let url: string;
    let job: PostingRecord;
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("job is not an object");
      job = raw as PostingRecord;
      url = candidateUrl(job);
    } catch (error) {
      counts.invalid.push({ index: i, error: (error as Error).message });
      return;
    }
    const hasPair = Boolean(norm(job.company)) && Boolean(norm(job.title));
    const pair = pairKey(job.company, job.title);
    if (index.urls.has(url) || (hasPair && index.pairs.has(pair))) counts.already_seen++;
    else if (hasPair && index.applied.has(pair)) counts.already_applied++;
    else if (batchUrls.has(url) || (hasPair && batchPairs.has(pair))) counts.repeated_in_batch++;
    else {
      selected.push({ index: i, job, url });
      batchUrls.add(url);
      if (hasPair) batchPairs.add(pair);
    }
  });
  return { selected, counts };
}

export function buildIndex(ctx: Pick<CoreContext, "db">): DedupeIndex {
  const urls = new Set<string>();
  const pairs = new Set<string>();
  const applied = new Set<string>();
  for (const row of ctx.db.prepare("SELECT canonical_url, company_norm, title_norm FROM jobs").all() as Array<{
    canonical_url: string | null;
    company_norm: string;
    title_norm: string;
  }>) {
    if (row.canonical_url) urls.add(row.canonical_url);
    pairs.add(`${row.company_norm}|${row.title_norm}`);
  }
  for (const row of ctx.db
    .prepare("SELECT j.company_norm, j.title_norm FROM applications a JOIN jobs j ON j.id = a.job_id")
    .all() as Array<{ company_norm: string; title_norm: string }>) {
    applied.add(`${row.company_norm}|${row.title_norm}`);
  }
  return { urls, pairs, applied };
}

export function jobIdFor(dedupeKey: string): string {
  return `job_${sha256(dedupeKey).slice(0, 12)}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const WORKPLACES = new Set(["onsite", "hybrid", "remote"]);

interface GuardedDescription {
  text: string;
  findings: GuardFindings;
}

function guardDescription(record: PostingRecord): GuardedDescription | null {
  const html = text(record.description_html);
  if (html) {
    const { text: cleaned, findings } = guard(html, "html");
    return { text: cleaned, findings };
  }
  const plain = text(record.description);
  if (plain) {
    const { text: cleaned, findings } = guard(plain, "text");
    return { text: cleaned, findings };
  }
  return null;
}

function salaryOf(record: PostingRecord): string | null {
  const salary = record.salary;
  if (!salary || typeof salary !== "object" || Array.isArray(salary)) return null;
  return JSON.stringify(salary);
}

/** The record as stored on the sighting: raw description text is not kept twice. */
function sightingRecord(record: PostingRecord): string {
  const { description_html: _html, description: _text, ...rest } = record;
  return JSON.stringify({ schema: "job.posting@1", ...rest, has_description: Boolean(_html || _text) });
}

export interface IngestOptions {
  connector: string;
  bindingId?: string | null;
  runId?: string | null;
  criteriaSetId?: string | null;
  /** When the record was seen (defaults to the clock). */
  seenAt?: string;
}

export interface IngestResult extends Counts {
  added: string[];
  merged: string[];
}

interface JobRow {
  id: string;
  dedupe_key: string;
  canonical_url: string | null;
  title: string;
  company: string;
  title_norm: string;
  company_norm: string;
  location: string | null;
  workplace: string | null;
  salary: string | null;
  seniority: string | null;
  description: string | null;
  description_guard: string | null;
  partial: number;
  deadline: string | null;
  posted_at: string | null;
  first_seen: string;
  last_seen: string;
  updated_at: string;
  status: string;
  expired_reason: string | null;
  fetch_attempts: number | null;
  first_unreachable: string | null;
  last_fetch_error: string | null;
}

export function findExisting(ctx: Pick<CoreContext, "db">, url: string | null, company: unknown, title: unknown): JobRow | undefined {
  if (url) {
    const byUrl = ctx.db.prepare("SELECT * FROM jobs WHERE canonical_url = ? LIMIT 1").get(url) as JobRow | undefined;
    if (byUrl) return byUrl;
  }
  const c = norm(company);
  const t = norm(title);
  if (c && t) {
    return ctx.db.prepare("SELECT * FROM jobs WHERE company_norm = ? AND title_norm = ? LIMIT 1").get(c, t) as JobRow | undefined;
  }
  return undefined;
}

export function getJobRow(ctx: Pick<CoreContext, "db">, idOrKey: string): JobRow | undefined {
  return ctx.db.prepare("SELECT * FROM jobs WHERE id = ? OR dedupe_key = ?").get(idOrKey, idOrKey) as JobRow | undefined;
}

export interface NewJob {
  title: string;
  company: string;
  url: string | null;
  location?: string | null;
  workplace?: string | null;
  salary?: string | null;
  seniority?: string | null;
  description?: GuardedDescription | null;
  partial?: boolean;
  deadline?: string | null;
  posted_at?: string | null;
  first_seen: string;
  status?: string;
}

/** Insert a job row (no dedupe check: callers did that). Returns its id. */
export function insertJob(ctx: CoreContext, job: NewJob): string {
  const canonical = job.url ? canonicalizeUrl(job.url) : null;
  let key = makeKey(job.company, job.title, job.url ?? "");
  const base = key;
  const identity = canonical ?? `${job.company}\n${job.title}`;
  for (let attempt = 0; ctx.db.prepare("SELECT 1 FROM jobs WHERE dedupe_key = ?").get(key); attempt++) {
    // Same slug for a different posting: disambiguate by the URL's identity.
    key = `${base}-${sha256(attempt ? `${identity}\n${attempt}` : identity).slice(0, 6)}`;
  }
  const id = jobIdFor(key);
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO jobs (id, dedupe_key, canonical_url, title, company, title_norm, company_norm, location, workplace,
        salary, seniority, description, description_guard, partial, deadline, posted_at, first_seen, last_seen, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      key,
      canonical,
      job.title,
      job.company,
      norm(job.title),
      norm(job.company),
      job.location ?? null,
      job.workplace ?? null,
      job.salary ?? null,
      job.seniority ?? null,
      job.description?.text ?? null,
      job.description ? JSON.stringify(job.description.findings) : null,
      job.partial ? 1 : 0,
      job.deadline ?? null,
      job.posted_at ?? null,
      job.first_seen,
      job.first_seen,
      now,
      job.status ?? "active",
    );
  emitEvent(ctx, "job.found", "job", id, { title: job.title, company: job.company });
  return id;
}

export function addSighting(
  ctx: CoreContext,
  jobId: string,
  options: IngestOptions & { externalId?: string | null; rawUrl?: string | null; record: string },
): void {
  ctx.db
    .prepare(
      `INSERT INTO job_sightings (job_id, connector, binding_id, external_id, raw_url, run_id, criteria_set_id, record, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jobId,
      options.connector,
      options.bindingId ?? null,
      options.externalId ?? null,
      options.rawUrl ?? null,
      options.runId ?? null,
      options.criteriaSetId ?? null,
      options.record,
      options.seenAt ?? nowIso(ctx),
    );
}

function validateForStore(job: PostingRecord): void {
  for (const field of ["title", "company", "url"] as const) {
    if (!text(job[field])) throw new Error(`job needs a non-empty ${field} before storage`);
  }
  candidateUrl(job);
  if (job.workplace !== undefined && job.workplace !== null && !WORKPLACES.has(String(job.workplace))) {
    throw new Error(`job has an invalid workplace ${JSON.stringify(job.workplace)}; expected onsite, hybrid or remote`);
  }
}

/**
 * Store `job.posting@1` records: new postings become jobs, repeats become
 * sightings of the job they repeat. All or nothing: a record without its
 * full identity refuses the whole batch.
 */
export function ingest(ctx: CoreContext, records: unknown[], options: IngestOptions): IngestResult {
  return transaction(ctx.db, () => {
    const { selected, counts } = selectCandidates(records, buildIndex(ctx));
    for (const { job } of selected) {
      try {
        validateForStore(job);
      } catch (error) {
        throw new EngineError(`${String(job.url ?? "?")}: ${(error as Error).message}`);
      }
    }
    const selectedIndexes = new Set(selected.map((s) => s.index));
    const added: string[] = [];
    const merged: string[] = [];
    const seenAt = options.seenAt ?? nowIso(ctx);
    const today = seenAt.slice(0, 10);
    records.forEach((raw, i) => {
      if (counts.invalid.some((entry) => entry.index === i)) return;
      const record = raw as PostingRecord;
      const url = candidateUrl(record);
      const description = guardDescription(record);
      let jobId: string;
      if (selectedIndexes.has(i)) {
        jobId = insertJob(ctx, {
          title: text(record.title) as string,
          company: text(record.company) as string,
          url: String(record.url).trim(),
          location: text(record.location),
          workplace: text(record.workplace),
          salary: salaryOf(record),
          seniority: text(record.seniority),
          description,
          partial: record.partial === true || description === null,
          deadline: parseIsoDate(record.deadline),
          posted_at: text(record.posted_at),
          first_seen: today,
        });
        added.push(jobId);
      } else {
        const existing = findExisting(ctx, url, record.company, record.title);
        if (!existing) return; // a batch repeat of an invalid-for-store record
        jobId = existing.id;
        mergeInto(ctx, existing, record, description, today);
        if (!merged.includes(jobId) && !added.includes(jobId)) merged.push(jobId);
      }
      addSighting(ctx, jobId, {
        ...options,
        seenAt,
        externalId: text(record.external_id),
        rawUrl: String(record.url).trim(),
        record: sightingRecord(record),
      });
    });
    for (const id of new Set([...added, ...merged])) scoreJobByRules(ctx, id);
    return { ...counts, added, merged };
  });
}

/** Fill what the stored job lacks from a repeat sighting. */
function mergeInto(ctx: CoreContext, existing: JobRow, record: PostingRecord, description: GuardedDescription | null, today: string): void {
  const updates: string[] = ["last_seen = ?"];
  const values: Array<string | number | null> = [today > existing.last_seen ? today : existing.last_seen];
  let changed = false;
  if (description && !existing.description) {
    updates.push("description = ?", "description_guard = ?", "partial = 0");
    values.push(description.text, JSON.stringify(description.findings));
    changed = true;
  }
  if (!existing.location && text(record.location)) {
    updates.push("location = ?");
    values.push(text(record.location));
    changed = true;
  }
  if (!existing.workplace && text(record.workplace) && WORKPLACES.has(String(record.workplace))) {
    updates.push("workplace = ?");
    values.push(text(record.workplace));
    changed = true;
  }
  if (!existing.salary && salaryOf(record)) {
    updates.push("salary = ?");
    values.push(salaryOf(record));
    changed = true;
  }
  if (!existing.canonical_url) {
    updates.push("canonical_url = ?");
    values.push(candidateUrl(record));
    changed = true;
  }
  if (changed) {
    updates.push("updated_at = ?");
    values.push(nowIso(ctx));
  }
  ctx.db.prepare(`UPDATE jobs SET ${updates.join(", ")} WHERE id = ?`).run(...values, existing.id);
}

// ---------------------------------------------------------------- scoring

export function rulesHash(ctx: Pick<CoreContext, "settings">): string {
  return sha256(canonicalJson(ctx.settings.ranking.rules)).slice(0, 16);
}

function rankable(row: JobRow) {
  return {
    title: row.title,
    company: row.company,
    location: row.location,
    workplace: row.workplace,
    description: row.description,
    salary: parseJson<{ min?: number; max?: number } | null>(row.salary, null),
  };
}

/** Store a fresh rule score for one job. */
export function scoreJobByRules(ctx: CoreContext, jobId: string): RuleScore | null {
  const row = ctx.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
  if (!row) return null;
  const result = ruleScore(rankable(row), ctx.settings.ranking.rules);
  ctx.db
    .prepare(
      `INSERT INTO job_scores (job_id, profile_version, criteria_version, method, score, band, gates, vetoed, dimensions, reason, basis, scored_at)
       VALUES (?, ?, NULL, 'rule', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jobId,
      currentProfileVersion(ctx),
      result.score,
      result.band,
      JSON.stringify(result.gates),
      result.vetoed ? 1 : 0,
      JSON.stringify(result.dimensions),
      result.reason,
      `rules:${rulesHash(ctx)}`,
      nowIso(ctx),
    );
  emitEvent(ctx, "job.scored", "job", jobId, { method: "rule", score: result.score, vetoed: result.vetoed });
  return result;
}

/** Re-score every job when the rules changed since they were last scored. */
export function rescoreIfRulesChanged(ctx: CoreContext): number {
  const hash = rulesHash(ctx);
  const stored = ctx.db.prepare("SELECT value FROM settings WHERE key = 'ranking.rules_hash'").get() as { value: string } | undefined;
  if (stored && JSON.parse(stored.value) === hash) return 0;
  return transaction(ctx.db, () => {
    const ids = (ctx.db.prepare("SELECT id FROM jobs").all() as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) scoreJobByRules(ctx, id);
    ctx.db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('ranking.rules_hash', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(JSON.stringify(hash), nowIso(ctx));
    return ids.length;
  });
}

export function currentProfileVersion(ctx: Pick<CoreContext, "db">): number | null {
  const row = ctx.db.prepare("SELECT MAX(version) AS v FROM profile_versions").get() as { v: number | null } | undefined;
  return row?.v ?? null;
}

interface ScoreRow {
  id: number;
  job_id: string;
  profile_version: number | null;
  method: "rule" | "assistant" | "ai_review";
  score: number;
  band: string;
  gates: string;
  vetoed: number;
  dimensions: string;
  reason: string | null;
  strengths: string;
  gaps: string;
  guard: string | null;
  basis: string | null;
  scored_at: string;
}

export interface ShownScore {
  score: number | null;
  score_10: number | null;
  band: string | null;
  score_method: "rule" | "assistant" | "ai_review" | null;
  vetoed: boolean;
  flags: string[];
  reason: string | null;
}

function judgementFlags(row: ScoreRow): string[] {
  const gates = parseJson<Record<string, unknown>>(row.gates, {});
  const flags: string[] = [];
  if (gates.engineering_role === true) flags.push("engineering role");
  for (const key of ["location_verdict", "seniority_gate"]) {
    const value = gates[key];
    if (value === "FAIL" || value === "FLAG") flags.push(`${key.replace(/_(verdict|gate)$/, "")}:${String(value)}`);
  }
  return flags;
}

function ruleFlags(row: ScoreRow): string[] {
  const gates = parseJson<Record<string, string>>(row.gates, {});
  return Object.entries(gates)
    .filter(([, v]) => v === "FAIL" || v === "FLAG")
    .map(([k, v]) => `${k}:${v}`);
}

/**
 * What is shown for a job (design 8.6): the newest judgement score when it
 * was made for the current profile version and the job has not changed
 * since; otherwise the rule score. A veto from the rule gates, or from the
 * newest judgement, always holds: a judgement can never lift a rule veto.
 */
export function shownScore(ctx: Pick<CoreContext, "db">, job: Pick<JobRow, "id" | "updated_at">, profileVersion: number | null): ShownScore {
  const rule = ctx.db
    .prepare("SELECT * FROM job_scores WHERE job_id = ? AND method = 'rule' ORDER BY id DESC LIMIT 1")
    .get(job.id) as ScoreRow | undefined;
  const judgement = ctx.db
    .prepare("SELECT * FROM job_scores WHERE job_id = ? AND method != 'rule' ORDER BY id DESC LIMIT 1")
    .get(job.id) as ScoreRow | undefined;
  const judgementShown =
    judgement !== undefined &&
    judgement.basis !== "legacy_import" &&
    judgement.profile_version === profileVersion &&
    judgement.scored_at >= job.updated_at;
  const shown = judgementShown ? judgement : rule;
  const vetoed = Boolean(rule?.vetoed) || Boolean(judgement?.vetoed);
  const flags = [...(rule ? ruleFlags(rule) : []), ...(judgement ? judgementFlags(judgement) : [])];
  if (judgement?.guard && judgement.guard !== "clean") flags.push("guard warning");
  return {
    score: shown?.score ?? null,
    score_10: shown ? score10(shown.score) : null,
    band: shown?.band ?? null,
    score_method: shown?.method ?? null,
    vetoed,
    flags: [...new Set(flags)],
    reason: shown?.reason ?? null,
  };
}

export function sourcesOf(ctx: Pick<CoreContext, "db">, jobId: string): string[] {
  return (
    ctx.db.prepare("SELECT connector FROM job_sightings WHERE job_id = ? GROUP BY connector ORDER BY MIN(id)").all(jobId) as Array<{ connector: string }>
  ).map((r) => r.connector);
}

export interface JobSummary {
  job_id: string;
  key: string;
  title: string;
  company: string;
  location: string | null;
  workplace: string | null;
  url: string | null;
  status: "active" | "skipped" | "unreachable" | "expired";
  sources: string[];
  score: number | null;
  score_10: number | null;
  band: string | null;
  score_method: "rule" | "assistant" | "ai_review" | null;
  vetoed: boolean;
  flags: string[];
  reason: string | null;
  partial: boolean;
  deadline: string | null;
  urgent: boolean;
  application_state: ApplicationStateName | null;
}

type ApplicationStateName = "found" | "shortlisted" | "resume_prepared" | "applied" | "interview" | "offer" | "rejected";

function summarise(ctx: CoreContext, row: JobRow, profileVersion: number | null): JobSummary {
  const shown = shownScore(ctx, row, profileVersion);
  const application = ctx.db.prepare("SELECT state FROM applications WHERE job_id = ?").get(row.id) as
    | { state: ApplicationStateName }
    | undefined;
  const today = isoDate(ctx.clock.now());
  const deadline = parseIsoDate(row.deadline);
  return {
    job_id: row.id,
    key: row.dedupe_key,
    title: row.title,
    company: row.company,
    location: row.location,
    workplace: row.workplace,
    url: row.canonical_url,
    status: row.status as JobSummary["status"],
    sources: sourcesOf(ctx, row.id),
    score: shown.score,
    score_10: shown.score_10,
    band: shown.band,
    score_method: shown.score_method,
    vetoed: shown.vetoed,
    flags: shown.flags,
    reason: shown.reason,
    partial: Boolean(row.partial),
    deadline: row.deadline,
    urgent: Boolean(deadline && today <= deadline && deadline <= addDays(today, URGENT_DAYS)),
    application_state: application?.state ?? null,
  };
}

function byScore(a: JobSummary, b: JobSummary): number {
  return (b.score ?? -1) - (a.score ?? -1) || Number(b.urgent) - Number(a.urgent) || a.job_id.localeCompare(b.job_id);
}

export interface ListOptions {
  top_n?: number;
  shortlist?: boolean;
}

/** Active jobs ranked by their shown score; vetoed jobs and rejected applications are left out. */
export function listJobs(ctx: CoreContext, options: ListOptions = {}) {
  const topN = options.top_n ?? ctx.settings.ranking.top_n;
  if (!Number.isInteger(topN) || topN <= 0) throw new EngineError("top_n must be a positive integer");
  const profileVersion = currentProfileVersion(ctx);
  const rows = ctx.db.prepare("SELECT * FROM jobs WHERE status IN ('active', 'unreachable')").all() as unknown as JobRow[];
  // A job whose application was rejected is no longer a match to show.
  let jobs = rows.map((row) => summarise(ctx, row, profileVersion)).filter((j) => j.application_state !== "rejected");
  const vetoed = jobs.filter((j) => j.vetoed).length;
  jobs = jobs.filter((j) => !j.vetoed);
  if (options.shortlist) jobs = jobs.filter((j) => j.application_state === "shortlisted");
  jobs.sort(byScore);
  const eligible = jobs.length;
  return {
    top_n: topN,
    count: Math.min(topN, eligible),
    eligible,
    vetoed,
    profile_version: profileVersion,
    results: jobs.slice(0, topN),
  };
}

/** Jobs whose title, company or location contains the query (case-insensitive). */
export function searchJobs(ctx: CoreContext, query: string, limit = 50) {
  if (typeof query !== "string" || !query.trim()) throw new EngineError("query must be a non-empty string");
  const needle = query.trim().toLowerCase();
  const profileVersion = currentProfileVersion(ctx);
  const rows = ctx.db.prepare("SELECT * FROM jobs").all() as unknown as JobRow[];
  const matches = rows
    .filter((row) => [row.title, row.company, row.location ?? ""].join("\n").toLowerCase().includes(needle))
    .map((row) => summarise(ctx, row, profileVersion))
    .sort(byScore);
  return { query, count: matches.length, results: matches.slice(0, limit) };
}

/** One job in full. The description is untrusted and comes back wrapped (design 6.5). */
export function getJob(ctx: CoreContext, idOrKey: string) {
  if (typeof idOrKey !== "string" || !idOrKey.trim()) throw new EngineError("job_id must be a non-empty string");
  const row = getJobRow(ctx, idOrKey.trim());
  if (!row) throw new EngineError(`no job with id ${JSON.stringify(idOrKey)}`, "not_found");
  const summary = summarise(ctx, row, currentProfileVersion(ctx));
  const scores = (ctx.db.prepare("SELECT * FROM job_scores WHERE job_id = ? ORDER BY id DESC").all(row.id) as unknown as ScoreRow[])
    .filter((s, i, all) => all.findIndex((o) => o.method === s.method && (o.basis === "legacy_import") === (s.basis === "legacy_import")) === i)
    .map((s) => ({
      method: s.method,
      score: s.score,
      band: s.band,
      vetoed: Boolean(s.vetoed),
      gates: parseJson(s.gates, {}),
      dimensions: parseJson(s.dimensions, {}),
      reason: s.reason,
      strengths: parseJson<string[]>(s.strengths, []),
      gaps: parseJson<string[]>(s.gaps, []),
      profile_version: s.profile_version,
      basis: s.basis,
      scored_at: s.scored_at,
    }));
  const sightings = (
    ctx.db.prepare("SELECT connector, external_id, raw_url, run_id, seen_at FROM job_sightings WHERE job_id = ? ORDER BY id").all(row.id) as Array<
      Record<string, unknown>
    >
  ).map((s) => ({ ...s }));
  const findings = parseJson<GuardFindings | null>(row.description_guard, null);
  return {
    ...summary,
    salary: parseJson(row.salary, null),
    seniority: row.seniority,
    posted_at: row.posted_at,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    expired_reason: row.expired_reason,
    fetch_attempts: row.fetch_attempts,
    last_fetch_error: row.last_fetch_error,
    description: row.description === null ? null : { untrusted_page_content: row.description },
    guard: findings,
    scores,
    sightings,
  };
}

/**
 * The jobs worth a judgement score. Port of rank_state candidates: by
 * default the active or unreachable jobs with no judgement yet; with `all`,
 * every job that is not skipped. Jobs with an application are left out (the
 * predecessor's tracker exclusion); `focus` filters on title, company and
 * stored strengths and gaps.
 */
export function rankCandidates(ctx: CoreContext, options: { all?: boolean; focus?: string; limit?: number } = {}) {
  const limit = options.limit ?? ctx.settings.ranking.candidate_limit;
  const rows = ctx.db.prepare("SELECT * FROM jobs ORDER BY first_seen, id").all() as unknown as JobRow[];
  const selected: Array<Record<string, unknown> & { job_id: string; sources: string[] }> = [];
  let excluded = 0;
  for (const row of rows) {
    if (options.all) {
      if (row.status === "skipped") continue;
    } else {
      if (!["active", "unreachable"].includes(row.status)) continue;
      const judged = ctx.db.prepare("SELECT 1 FROM job_scores WHERE job_id = ? AND method != 'rule' LIMIT 1").get(row.id);
      if (judged && row.status !== "unreachable") continue;
    }
    if (ctx.db.prepare("SELECT 1 FROM applications WHERE job_id = ?").get(row.id)) {
      excluded++;
      continue;
    }
    if (options.focus) {
      const notes = ctx.db
        .prepare("SELECT strengths, gaps FROM job_scores WHERE job_id = ? AND method != 'rule' ORDER BY id DESC LIMIT 1")
        .get(row.id) as { strengths: string; gaps: string } | undefined;
      const haystack = [row.title, row.company, ...parseJson<string[]>(notes?.strengths, []), ...parseJson<string[]>(notes?.gaps, [])]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(options.focus.toLowerCase())) continue;
    }
    selected.push({
      job_id: row.id,
      key: row.dedupe_key,
      title: row.title,
      company: row.company,
      url: row.canonical_url,
      sources: sourcesOf(ctx, row.id),
      deadline: row.deadline,
      posted_at: row.posted_at,
    });
  }
  const eligible = selected.length;
  const capped = limit > 0 ? selected.slice(0, limit) : selected;
  return { eligible, selected: capped, deferred: Math.max(0, eligible - capped.length), excluded_by_application: excluded, total_jobs: rows.length };
}

// ---------------------------------------------------------------- deadline sweep

/**
 * Expiry pass over stored deadlines, no fetch. Port of rank_state sweep:
 * an active job whose deadline has passed is expired (when `write`); one
 * closing within URGENT_DAYS is reported; a deadline that is not YYYY-MM-DD
 * is reported and never guessed at.
 */
export function sweepDeadlines(ctx: CoreContext, options: { today?: string; write?: boolean; exclude?: string[] } = {}) {
  const today = options.today ?? isoDate(ctx.clock.now());
  const exclude = new Set(options.exclude ?? []);
  const expired: Array<Record<string, unknown>> = [];
  const closing: Array<Record<string, unknown>> = [];
  const unparseable: Array<Record<string, unknown>> = [];
  let checked = 0;
  const rows = ctx.db.prepare("SELECT * FROM jobs WHERE status = 'active'").all() as unknown as JobRow[];
  for (const row of rows) {
    if (exclude.has(row.id) || exclude.has(row.dedupe_key)) continue;
    checked++;
    if (row.deadline === null || row.deadline === "") continue;
    const parsed = parseIsoDate(row.deadline);
    const view = { job_id: row.id, key: row.dedupe_key, title: row.title, company: row.company, url: row.canonical_url, deadline: row.deadline };
    if (parsed === null) {
      unparseable.push({ job_id: row.id, key: row.dedupe_key, deadline: row.deadline });
      continue;
    }
    if (parsed < today) expired.push(view);
    else if (parsed <= addDays(today, URGENT_DAYS)) closing.push(view);
  }
  const written = Boolean(options.write && expired.length);
  if (written) {
    transaction(ctx.db, () => {
      for (const row of expired) {
        ctx.db.prepare("UPDATE jobs SET status = 'expired', updated_at = ? WHERE id = ?").run(nowIso(ctx), row.job_id as string);
        emitEvent(ctx, "job.expired", "job", row.job_id as string, { reason: "deadline" });
      }
    });
  }
  closing.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
  return { swept: checked, newly_expired: expired, closing_soon: closing, unparseable_deadlines: unparseable, written };
}

export { isVeto };
