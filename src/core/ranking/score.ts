/**
 * Score arithmetic shared by every ranking method. Port of the pure parts
 * of tools/rank_state.py: the weighted 0-100 score in exact decimal
 * arithmetic, the verdict bands, the guide's 1-10 scale and the veto gates.
 */
import { add, fromNumber, mul, roundHalfUp, ZERO } from "../../util/rational.js";

export const BANDS: ReadonlyArray<readonly [number, string]> = [
  [75, "Strong Fit"],
  [60, "Good Fit"],
  [45, "Moderate Fit"],
  [30, "Weak Fit"],
  [0, "Poor Fit"],
];

/** The statuses a judgement result may carry. */
export const AGENT_STATUSES = ["scored", "expired", "unreachable"] as const;

/** The values a veto gate may take. The veto is an exact match on FAIL. */
export const GATE_VERDICTS = ["PASS", "FAIL", "FLAG"] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];

export const URGENT_DAYS = 7;
export const UNREACHABLE_MAX_ATTEMPTS = 3;
export const UNREACHABLE_MIN_SPAN_MS = 48 * 3600 * 1000;
export const FETCH_ERROR_MAX = 200;
export const REASON_MAX = 200;

export class ScoreError extends Error {
  override name = "ScoreError";
}

/** The weighted score, rounded half up, from 0-100 dimension scores. */
export function overallScore(scores: unknown, weights: Record<string, number>): number {
  if (typeof scores !== "object" || scores === null || Array.isArray(scores)) {
    throw new ScoreError("scores must be an object");
  }
  let total = ZERO;
  for (const [dim, weight] of Object.entries(weights)) {
    const value = (scores as Record<string, unknown>)[dim];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ScoreError(`missing or non-numeric score '${dim}'`);
    }
    if (value < 0 || value > 100) {
      throw new ScoreError(`score '${dim}' must be finite and between 0 and 100`);
    }
    total = add(total, mul(fromNumber(value), fromNumber(weight)));
  }
  return roundHalfUp(total);
}

export function band(score: number): string {
  for (const [floor, name] of BANDS) if (score >= floor) return name;
  return "Poor Fit";
}

/** The guide's 1-10 ranking scale, derived from the weighted 0-100. */
export function score10(score: number): number {
  return Math.round(score) / 10;
}

export interface JudgementGates {
  location_verdict?: string | null;
  seniority_gate?: string | null;
  engineering_role?: boolean | null;
}

/** The hard gates of a judgement score: relocation, seniority mismatch, engineering IC role. */
export function isVeto(row: JudgementGates): boolean {
  return row.location_verdict === "FAIL" || row.seniority_gate === "FAIL" || row.engineering_role === true;
}
