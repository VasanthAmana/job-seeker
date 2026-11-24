/**
 * Applications and their states (design 5.2): found, shortlisted,
 * resume_prepared, applied, interview, offer, rejected. Every state change
 * is an `application_events` row and an `application.state_changed` event.
 * Reshaped from the predecessor's tracker.csv.
 */
import { transaction } from "../store/db.js";
import { emitEvent, EngineError, nowIso, type CoreContext } from "./context.js";
import { getJobRow } from "./jobs.js";

export const APPLICATION_STATES = ["found", "shortlisted", "resume_prepared", "applied", "interview", "offer", "rejected"] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];

export const CHANNELS = ["mcp", "cli", "import", "service"] as const;

export interface SetStateOptions {
  reported_by?: "user" | "assistant" | "import" | "engine";
  channel?: (typeof CHANNELS)[number];
  note?: string | null;
  /** When the change happened, if not now (the legacy import's tracker dates). */
  at?: string;
}

interface ApplicationRow {
  job_id: string;
  state: ApplicationState;
  resume_id: string | null;
  created_at: string;
  updated_at: string;
}

export function isState(value: unknown): value is ApplicationState {
  return typeof value === "string" && (APPLICATION_STATES as readonly string[]).includes(value);
}

/** Move a job's application to `state`, creating the application when it has none. */
export function setApplicationState(ctx: CoreContext, jobId: string, state: unknown, options: SetStateOptions = {}) {
  if (!isState(state)) {
    throw new EngineError(`unknown application state ${JSON.stringify(state)}; expected one of ${APPLICATION_STATES.join(", ")}`);
  }
  const job = getJobRow(ctx, jobId);
  if (!job) throw new EngineError(`no job with id ${JSON.stringify(jobId)}`, "not_found");
  return transaction(ctx.db, () => {
    const current = ctx.db.prepare("SELECT * FROM applications WHERE job_id = ?").get(job.id) as ApplicationRow | undefined;
    const from = current?.state ?? null;
    if (from === state) {
      return { job_id: job.id, from_state: from, state, changed: false };
    }
    const at = options.at ?? nowIso(ctx);
    if (current) {
      ctx.db.prepare("UPDATE applications SET state = ?, updated_at = ? WHERE job_id = ?").run(state, at, job.id);
    } else {
      ctx.db.prepare("INSERT INTO applications (job_id, state, created_at, updated_at) VALUES (?, ?, ?, ?)").run(job.id, state, at, at);
    }
    const note = typeof options.note === "string" && options.note.trim() ? options.note.trim().slice(0, 500) : null;
    ctx.db
      .prepare(
        "INSERT INTO application_events (job_id, from_state, to_state, at, reported_by, channel, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(job.id, from, state, at, options.reported_by ?? "assistant", options.channel ?? "mcp", note);
    emitEvent(ctx, "application.state_changed", "application", job.id, { from, to: state });
    return { job_id: job.id, from_state: from, state, changed: true };
  });
}

function history(ctx: CoreContext, jobId: string) {
  return ctx.db
    .prepare("SELECT from_state, to_state, at, reported_by, channel, note FROM application_events WHERE job_id = ? ORDER BY id")
    .all(jobId) as Array<{ from_state: string | null; to_state: string; at: string; reported_by: string; channel: string; note: string | null }>;
}

export function getApplication(ctx: CoreContext, jobId: string) {
  const job = getJobRow(ctx, jobId);
  if (!job) throw new EngineError(`no job with id ${JSON.stringify(jobId)}`, "not_found");
  const row = ctx.db.prepare("SELECT * FROM applications WHERE job_id = ?").get(job.id) as ApplicationRow | undefined;
  if (!row) throw new EngineError(`job ${job.id} has no application yet; set its state to start one`, "not_found");
  return {
    job_id: job.id,
    title: job.title,
    company: job.company,
    url: job.canonical_url,
    state: row.state,
    created_at: row.created_at,
    updated_at: row.updated_at,
    events: history(ctx, job.id),
  };
}

export function listApplications(ctx: CoreContext, state?: unknown) {
  if (state !== undefined && !isState(state)) {
    throw new EngineError(`unknown application state ${JSON.stringify(state)}; expected one of ${APPLICATION_STATES.join(", ")}`);
  }
  const rows = ctx.db
    .prepare(
      `SELECT a.job_id, a.state, a.created_at, a.updated_at, j.title, j.company, j.canonical_url AS url
       FROM applications a JOIN jobs j ON j.id = a.job_id
       ${state ? "WHERE a.state = ?" : ""} ORDER BY a.updated_at DESC, a.job_id`,
    )
    .all(...(state ? [state as string] : [])) as Array<Record<string, unknown>>;
  const counts: Record<string, number> = Object.fromEntries(APPLICATION_STATES.map((s) => [s, 0]));
  for (const row of ctx.db.prepare("SELECT state, COUNT(*) AS n FROM applications GROUP BY state").all() as Array<{ state: string; n: number }>) {
    counts[row.state] = row.n;
  }
  return { count: rows.length, counts, results: rows.map((row) => ({ ...row })) };
}
