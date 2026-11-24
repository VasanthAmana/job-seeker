/**
 * The judgement-score apply path (design 8.5): scores from the user's
 * assistant (`rank_submit`, method `assistant`) or the AI adapter's match
 * review (method `ai_review`) go through the same validation, weights and
 * vetoes. A judgement can never lift a job a rule gate vetoed.
 *
 * Port of rank_state's `apply`: per-result statuses (`scored`, `expired`,
 * `unreachable`), gate-verdict validation, the passed-deadline expiry, and
 * the unreachable retry floor (3 attempts at least 48 hours apart before a
 * posting gives up to `expired`). Each result is validated on its own; a bad
 * one is reported in `errors` and does not stop the others.
 */
import { transaction } from "../../store/db.js";
import { isoDate, isoSeconds, parseIsoDate } from "../../util/clock.js";
import { squash } from "../../util/text.js";
import { emitEvent, nowIso, parseJson, type CoreContext } from "../context.js";
import { currentProfileVersion, getJobRow } from "../jobs.js";
import {
  AGENT_STATUSES,
  band,
  FETCH_ERROR_MAX,
  GATE_VERDICTS,
  isVeto,
  overallScore,
  REASON_MAX,
  score10,
  ScoreError,
  UNREACHABLE_MAX_ATTEMPTS,
  UNREACHABLE_MIN_SPAN_MS,
  URGENT_DAYS,
} from "./score.js";
import { addDays } from "../../util/clock.js";

export type JudgementMethod = "assistant" | "ai_review";

export interface ApplyOptions {
  method: JudgementMethod;
  /** Today's date for deadline checks (defaults to the clock). */
  today?: string;
  /** The time for the unreachable retry floor (defaults to the clock). */
  now?: Date;
  /** Marks scores carried over from the predecessor (not shown as current judgements). */
  basis?: string | null;
}

interface JobView {
  job_id: string;
  key: string;
  title: string;
  company: string;
  url: string | null;
}

export interface ApplyResult {
  ranked: Array<Record<string, unknown>>;
  vetoed: Array<Record<string, unknown>>;
  expired: JobView[];
  unreachable: Array<Record<string, unknown>>;
  gave_up: Array<Record<string, unknown>>;
  errors: Array<{ job_id: unknown; error: string }>;
}

function parseStamp(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.trim())) return null;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function guardLine(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let text = value.trim();
  if (text.toLowerCase().startsWith("posting_guard:")) text = text.slice("posting_guard:".length).trim();
  return text.toLowerCase().startsWith("clean") ? "clean" : Array.from(text).slice(0, 200).join("");
}

export function applyJudgements(ctx: CoreContext, results: unknown, options: ApplyOptions): ApplyResult {
  const today = options.today ?? isoDate(ctx.clock.now());
  const now = options.now ?? ctx.clock.now();
  const out: ApplyResult = { ranked: [], vetoed: [], expired: [], unreachable: [], gave_up: [], errors: [] };
  if (!Array.isArray(results)) {
    out.errors.push({ job_id: null, error: "results must be an array of scoring objects" });
    return out;
  }
  const weights = ctx.settings.ranking.weights;
  const profileVersion = currentProfileVersion(ctx);

  transaction(ctx.db, () => {
    for (const result of results) {
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        out.errors.push({ job_id: null, error: "result is not an object" });
        continue;
      }
      const r = result as Record<string, unknown>;
      const id = r.job_id ?? r.key;
      const job = typeof id === "string" ? getJobRow(ctx, id) : undefined;
      if (!job) {
        out.errors.push({ job_id: id ?? null, error: "no such job" });
        continue;
      }
      const view: JobView = { job_id: job.id, key: job.dedupe_key, title: job.title, company: job.company, url: job.canonical_url };
      const status = r.status ?? "scored";
      if (!(AGENT_STATUSES as readonly unknown[]).includes(status)) {
        out.errors.push({ job_id: job.id, error: `unknown status ${JSON.stringify(status)}; expected one of ${AGENT_STATUSES.join(", ")}` });
        continue;
      }
      const expire = (reason: string | null, deadline?: string | null) => {
        ctx.db
          .prepare(
            `UPDATE jobs SET status = 'expired', expired_reason = ?, fetch_attempts = NULL, first_unreachable = NULL,
               last_fetch_error = NULL, deadline = COALESCE(?, deadline), updated_at = ? WHERE id = ?`,
          )
          .run(reason, deadline ?? null, nowIso(ctx), job.id);
        emitEvent(ctx, "job.expired", "job", job.id, { reason: reason ?? "expired" });
        out.expired.push(view);
      };

      if (status === "unreachable") {
        // A stored deadline that has passed is positive evidence the posting is closed.
        const deadline = parseIsoDate(job.deadline);
        if (deadline !== null && deadline < today) {
          expire(null);
          continue;
        }
        const previous = job.fetch_attempts;
        const attempts = (Number.isInteger(previous) ? (previous as number) : 0) + 1;
        const first = parseStamp(job.first_unreachable) ?? now;
        const error = Array.from(squash(r.fetch_error ?? "")).slice(0, FETCH_ERROR_MAX).join("");
        const lastError = error || job.last_fetch_error;
        const row = { ...view, fetch_attempts: attempts, last_fetch_error: lastError };
        const gaveUp = attempts >= UNREACHABLE_MAX_ATTEMPTS && now.getTime() - first.getTime() >= UNREACHABLE_MIN_SPAN_MS;
        ctx.db
          .prepare(
            "UPDATE jobs SET status = ?, expired_reason = ?, fetch_attempts = ?, first_unreachable = ?, last_fetch_error = ?, updated_at = ? WHERE id = ?",
          )
          .run(gaveUp ? "expired" : "unreachable", gaveUp ? "unreachable" : null, attempts, isoSeconds(first), lastError, nowIso(ctx), job.id);
        if (gaveUp) {
          emitEvent(ctx, "job.expired", "job", job.id, { reason: "unreachable" });
          out.gave_up.push(row);
        } else {
          out.unreachable.push(row);
        }
        continue;
      }

      if (status === "expired") {
        expire(null);
        continue;
      }

      let score: number;
      try {
        score = overallScore(r.scores ?? {}, weights);
      } catch (error) {
        if (!(error instanceof ScoreError)) throw error;
        out.errors.push({ job_id: job.id, error: error.message });
        continue;
      }
      const badGate = (["location_verdict", "seniority_gate"] as const).find(
        (f) => r[f] && !(GATE_VERDICTS as readonly unknown[]).includes(r[f]),
      );
      if (badGate) {
        out.errors.push({ job_id: job.id, error: `unknown ${badGate} ${JSON.stringify(r[badGate])}; expected one of ${GATE_VERDICTS.join(", ")}` });
        continue;
      }
      const engineeringRole = r.engineering_role;
      if (engineeringRole !== undefined && engineeringRole !== null && typeof engineeringRole !== "boolean") {
        out.errors.push({ job_id: job.id, error: "engineering_role must be true or false" });
        continue;
      }
      // A missing deadline is not a correction to the stored date.
      const freshDeadline = typeof r.deadline === "string" && r.deadline ? r.deadline : null;
      const parsed = parseIsoDate(freshDeadline ?? job.deadline);
      if (parsed !== null && parsed < today) {
        expire(null, freshDeadline);
        continue;
      }

      const gates = {
        location_verdict: (r.location_verdict as string) || "PASS",
        seniority_gate: (r.seniority_gate as string) || "PASS",
        engineering_role: Boolean(engineeringRole),
      };
      const reason = Array.from(squash(r.reason ?? "")).slice(0, REASON_MAX).join("");
      const strengths = Array.isArray(r.strengths) ? r.strengths.map(String).slice(0, 3) : [];
      const gaps = Array.isArray(r.gaps) ? r.gaps.map(String).slice(0, 3) : [];
      const guard = guardLine(r.guard);
      const ruleRow = ctx.db
        .prepare("SELECT vetoed FROM job_scores WHERE job_id = ? AND method = 'rule' ORDER BY id DESC LIMIT 1")
        .get(job.id) as { vetoed: number } | undefined;
      const judgementVeto = isVeto(gates);
      const vetoed = judgementVeto || Boolean(ruleRow?.vetoed);

      ctx.db
        .prepare(
          `UPDATE jobs SET status = 'active', expired_reason = NULL, fetch_attempts = NULL, first_unreachable = NULL,
             last_fetch_error = NULL, deadline = COALESCE(?, deadline) WHERE id = ?`,
        )
        .run(freshDeadline, job.id);
      ctx.db
        .prepare(
          `INSERT INTO job_scores (job_id, profile_version, criteria_version, method, score, band, gates, vetoed, dimensions,
             reason, strengths, gaps, guard, basis, scored_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          job.id,
          options.basis === "legacy_import" ? null : profileVersion,
          options.method,
          score,
          band(score),
          JSON.stringify(gates),
          judgementVeto ? 1 : 0,
          JSON.stringify(r.scores),
          reason,
          JSON.stringify(strengths),
          JSON.stringify(gaps),
          guard,
          options.basis ?? null,
          nowIso(ctx),
        );
      emitEvent(ctx, "job.scored", "job", job.id, { method: options.method, score, vetoed });

      const deadline = parseIsoDate(freshDeadline ?? job.deadline);
      const row = {
        ...view,
        location: job.location,
        score,
        score_10: score10(score),
        score_method: options.method,
        verdict: band(score),
        reason,
        ...gates,
        rule_vetoed: Boolean(ruleRow?.vetoed),
        deadline: freshDeadline ?? job.deadline,
        urgent: Boolean(deadline && today <= deadline && deadline <= addDays(today, URGENT_DAYS)),
        strengths,
        gaps,
        guard,
      };
      (vetoed ? out.vetoed : out.ranked).push(row);
    }
  });

  const order = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    (b.score as number) - (a.score as number) || Number(b.urgent) - Number(a.urgent);
  out.ranked.sort(order);
  out.vetoed.sort(order);
  return out;
}

export { parseJson };
