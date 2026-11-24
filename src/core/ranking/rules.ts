/**
 * The rule ranker (design 8.4): gates first, and any gate failure vetoes
 * the job; then weighted dimensions. It is deterministic and needs no
 * model, so unattended runs and reports rank on their own.
 *
 * Gates: exclusions (title terms), seniority (title signals compared with
 * the target levels), location and workplace, and a salary floor applied
 * only when the salary is known. Dimensions, each 0-100: title, skills,
 * domain, seniority and location. Until criteria sets arrive in phase 3 the
 * rules come from `ranking.rules` in config.json
 * (docs/decisions/interim-ranking-rules.md).
 */
import type { RankingRules } from "../settings.js";
import { band, overallScore, type GateVerdict } from "./score.js";

export interface RankableJob {
  title: string;
  company: string;
  location: string | null;
  workplace: string | null;
  description: string | null;
  salary: { min?: number | null; max?: number | null } | null;
}

export interface RuleGates {
  exclusion: GateVerdict;
  seniority: GateVerdict;
  location: GateVerdict;
  salary: GateVerdict;
}

export interface RuleScore {
  score: number;
  band: string;
  gates: RuleGates;
  vetoed: boolean;
  dimensions: Record<keyof RankingRules["weights"], number>;
  reason: string;
  seniority_level: string | null;
}

/** Seniority levels in order, each with the title signals that name it. */
export const SENIORITY_LEVELS: ReadonlyArray<{ level: string; rank: number; pattern: RegExp }> = [
  { level: "chief", rank: 8, pattern: /\b(chief|c[a-z]{1,2}o)\b/i },
  { level: "vp", rank: 7, pattern: /\b(s?vp|evp|vice[ -]president)\b/i },
  { level: "head", rank: 6, pattern: /\bhead of\b/i },
  { level: "director", rank: 6, pattern: /\b(director|dir)\b/i },
  { level: "manager", rank: 4, pattern: /\bmanager\b/i },
  { level: "senior", rank: 3, pattern: /\b(senior|sr|lead|principal|staff)\b/i },
  { level: "junior", rank: 1, pattern: /\b(junior|jr|associate|entry[ -]level|graduate)\b/i },
  { level: "intern", rank: 0, pattern: /\b(intern|internship)\b/i },
];

const LEVEL_RANK = new Map(SENIORITY_LEVELS.map((entry) => [entry.level, entry.rank]));

/** The most senior level a title signals, or null when it signals none. */
export function detectSeniority(title: string): { level: string; rank: number } | null {
  let best: { level: string; rank: number } | null = null;
  for (const entry of SENIORITY_LEVELS) {
    if (entry.pattern.test(title) && (best === null || entry.rank > best.rank)) {
      best = { level: entry.level, rank: entry.rank };
    }
  }
  return best;
}

function lower(text: string | null | undefined): string {
  return (text ?? "").toLowerCase();
}

function words(text: string): Set<string> {
  return new Set(lower(text).match(/[\p{L}\p{N}]+/gu) ?? []);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word (or whole-phrase) match, case-insensitive. */
export function containsTerm(haystack: string, term: string): boolean {
  const trimmed = term.trim();
  if (!trimmed) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}])`, "iu").test(haystack);
}

function seniorityGate(title: string, targets: string[]): { verdict: GateVerdict; level: string | null } {
  const detected = detectSeniority(title);
  if (targets.length === 0) return { verdict: "PASS", level: detected?.level ?? null };
  if (detected === null) return { verdict: "FLAG", level: null };
  const ranks = targets.map((t) => LEVEL_RANK.get(t.toLowerCase())).filter((r): r is number => r !== undefined);
  if (ranks.length === 0) return { verdict: "FLAG", level: detected.level };
  if (detected.rank < Math.min(...ranks)) return { verdict: "FAIL", level: detected.level };
  if (detected.rank > Math.max(...ranks)) return { verdict: "FLAG", level: detected.level };
  return { verdict: "PASS", level: detected.level };
}

function locationGate(job: RankableJob, wanted: string[]): GateVerdict {
  if (wanted.length === 0) return "PASS";
  const place = lower(job.location);
  const remote = job.workplace === "remote" || containsTerm(place, "remote");
  const wantsRemote = wanted.some((w) => containsTerm(w, "remote"));
  if (remote && wantsRemote) return "PASS";
  if (!place && !job.workplace) return "FLAG";
  for (const entry of wanted) {
    if (containsTerm(entry, "remote")) continue;
    const city = lower(entry.split(",")[0]).trim();
    if (city && place.includes(city)) return "PASS";
  }
  return "FAIL";
}

function salaryGate(job: RankableJob, floor: number | null): GateVerdict {
  if (floor === null || !job.salary) return "PASS";
  const top = job.salary.max ?? job.salary.min;
  if (typeof top !== "number") return "PASS";
  return top < floor ? "FAIL" : "PASS";
}

function gateScore(verdict: GateVerdict): number {
  return verdict === "PASS" ? 100 : verdict === "FLAG" ? 50 : 0;
}

function titleDimension(title: string, phrases: string[]): { score: number; matched: string | null } {
  if (phrases.length === 0) return { score: 50, matched: null };
  let best = 0;
  let matched: string | null = null;
  const titleWords = words(title);
  for (const phrase of phrases) {
    if (containsTerm(title, phrase)) return { score: 100, matched: phrase };
    const phraseWords = [...words(phrase)];
    if (phraseWords.length === 0) continue;
    const overlap = phraseWords.filter((w) => titleWords.has(w)).length / phraseWords.length;
    const score = Math.round(overlap * 80);
    if (score > best) {
      best = score;
      matched = overlap > 0 ? phrase : matched;
    }
  }
  return { score: best, matched };
}

function coverage(text: string, terms: string[]): { score: number; hits: string[] } {
  if (terms.length === 0) return { score: 50, hits: [] };
  const hits = terms.filter((term) => containsTerm(text, term));
  return { score: Math.round((100 * hits.length) / terms.length), hits };
}

/** Score one job against the rules. Pure and deterministic. */
export function ruleScore(job: RankableJob, rules: RankingRules): RuleScore {
  const title = job.title ?? "";
  const excluded = rules.exclude.filter((term) => containsTerm(title, term));
  const seniority = seniorityGate(title, rules.seniority);
  const gates: RuleGates = {
    exclusion: excluded.length ? "FAIL" : "PASS",
    seniority: seniority.verdict,
    location: locationGate(job, rules.locations),
    salary: salaryGate(job, rules.salary_min),
  };
  const text = `${title}\n${job.description ?? ""}`;
  const titleDim = titleDimension(title, rules.titles);
  const skills = coverage(text, rules.keywords);
  const domain = coverage(`${job.company}\n${text}`, rules.domains);
  const dimensions = {
    title: titleDim.score,
    skills: skills.score,
    domain: domain.score,
    seniority: gateScore(gates.seniority),
    location: gateScore(gates.location),
  };
  const score = overallScore(dimensions, rules.weights as unknown as Record<string, number>);
  const vetoed = Object.values(gates).includes("FAIL");

  const reasons: string[] = [];
  if (excluded.length) reasons.push(`excluded title term: ${excluded.join(", ")}`);
  if (gates.seniority === "FAIL") reasons.push(`seniority ${seniority.level ?? "unknown"} is below the target`);
  if (gates.location === "FAIL") reasons.push(`location ${job.location ?? "unknown"} is outside the target`);
  if (gates.salary === "FAIL") reasons.push("salary is below the floor");
  if (titleDim.matched && titleDim.score === 100) reasons.push(`title matches "${titleDim.matched}"`);
  if (rules.keywords.length) reasons.push(`${skills.hits.length}/${rules.keywords.length} keywords`);
  if (seniority.level && gates.seniority !== "FAIL") reasons.push(`seniority ${seniority.level}`);
  if (gates.seniority === "FLAG" && !seniority.level) reasons.push("seniority unclear from the title");
  if (gates.location === "PASS" && rules.locations.length) reasons.push(`location ${job.location ?? job.workplace ?? ""}`.trim());
  if (gates.location === "FLAG") reasons.push("location unknown");

  return {
    score,
    band: band(score),
    gates,
    vetoed,
    dimensions,
    reason: reasons.join("; "),
    seniority_level: seniority.level,
  };
}
