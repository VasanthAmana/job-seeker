/**
 * Settings: `config.json` in the data directory (design 5.1).
 *
 * Reshaped from tools/config.py. Precedence is built-in DEFAULTS <
 * config.json; a missing file applies DEFAULTS unchanged, and a malformed
 * file is an error rather than a silent fallback, since falling back would
 * mask a typo in the user's own config. The predecessor's Gmail accounts
 * and repository paths are gone: mailboxes become connector bindings
 * (phase 8) and state lives in the database. `state_lock` gives way to
 * SQLite transactions.
 *
 * `ranking.rules` holds the rule ranker's criteria until criteria sets
 * arrive in phase 3 (docs/decisions/interim-ranking-rules.md).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RuleWeights {
  title: number;
  skills: number;
  domain: number;
  seniority: number;
  location: number;
}

export interface RankingRules {
  titles: string[];
  keywords: string[];
  domains: string[];
  seniority: string[];
  exclude: string[];
  locations: string[];
  salary_min: number | null;
  weights: RuleWeights;
}

export interface Settings {
  ranking: {
    /** The judgement rubric's dimension weights (profile/job-evaluation.example.md). */
    weights: Record<string, number>;
    top_n: number;
    candidate_limit: number;
    rules: RankingRules;
  };
  ai: { backend: "off" | "claude-code" | "codex" | "anthropic-api" | "fake" };
  secrets: { backend: "auto" | "keychain" | "file" };
}

export const DEFAULTS: Settings = {
  ranking: {
    weights: { domain: 0.3, leadership: 0.25, behavioral: 0.15, career: 0.3 },
    top_n: 5,
    candidate_limit: 10,
    rules: {
      titles: [],
      keywords: [],
      domains: [],
      seniority: [],
      exclude: [],
      locations: [],
      salary_min: null,
      weights: { title: 0.3, skills: 0.25, domain: 0.15, seniority: 0.15, location: 0.15 },
    },
  },
  ai: { backend: "off" },
  secrets: { backend: "auto" },
};

export const CONFIG_FILE = "config.json";

export class ConfigError extends Error {
  override name = "ConfigError";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(base: T, override: Record<string, unknown>): T {
  const result = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isObject(value) && isObject(current)) result[key] = deepMerge(current, value);
    else result[key] = structuredClone(value);
  }
  return result as T;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function checkStrings(value: unknown, where: string, source: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${source}: '${where}' must be an array of strings`);
  }
}

export function validateSettings(settings: Settings, source = "<config>"): void {
  const ranking = settings.ranking as unknown;
  if (!isObject(ranking)) throw new ConfigError(`${source}: 'ranking' must be an object`);
  const weights = ranking.weights;
  if (!isObject(weights) || Object.keys(weights).length === 0) {
    throw new ConfigError(`${source}: 'ranking.weights' must be a non-empty object`);
  }
  for (const [dim, value] of Object.entries(weights)) {
    if (!isNumber(value)) throw new ConfigError(`${source}: ranking.weights.${dim} must be a number`);
  }
  for (const key of ["top_n", "candidate_limit"] as const) {
    const value = ranking[key];
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new ConfigError(`${source}: ranking.${key} must be a positive integer`);
    }
  }
  const rules = ranking.rules;
  if (!isObject(rules)) throw new ConfigError(`${source}: 'ranking.rules' must be an object`);
  for (const key of ["titles", "keywords", "domains", "seniority", "exclude", "locations"]) {
    checkStrings(rules[key], `ranking.rules.${key}`, source);
  }
  if (rules.salary_min !== null && !isNumber(rules.salary_min)) {
    throw new ConfigError(`${source}: ranking.rules.salary_min must be a number or null`);
  }
  const ruleWeights = rules.weights;
  if (!isObject(ruleWeights)) throw new ConfigError(`${source}: 'ranking.rules.weights' must be an object`);
  for (const dim of ["title", "skills", "domain", "seniority", "location"]) {
    if (!isNumber(ruleWeights[dim])) throw new ConfigError(`${source}: ranking.rules.weights.${dim} must be a number`);
  }
  const backend = (settings.secrets as unknown as Record<string, unknown>)?.backend;
  if (!["auto", "keychain", "file"].includes(String(backend))) {
    throw new ConfigError(`${source}: secrets.backend must be one of auto, keychain, file`);
  }
}

/** DEFAULTS merged with the JSON object at `path`. */
export function loadSettingsFile(path: string): Settings {
  const settings = structuredClone(DEFAULTS);
  if (!existsSync(path)) return settings;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`cannot read job-seeker config ${path}: ${message}`);
  }
  if (!isObject(data)) throw new ConfigError(`${path}: expected a JSON object at the top level`);
  const merged = deepMerge(settings, data);
  validateSettings(merged, path);
  return merged;
}

export function loadSettings(dataDir: string): Settings {
  return loadSettingsFile(join(dataDir, CONFIG_FILE));
}
