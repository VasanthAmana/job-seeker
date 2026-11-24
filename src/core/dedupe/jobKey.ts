/**
 * Canonical dedupe key for a job posting, and an audit for existing state.
 *
 * Port of tools/job_key.py. The key is a pure, deterministic function of
 * the posting: "<company-slug>_<title-slug>", lowercase ASCII alphanumerics
 * and hyphens. Truncation is length-capped and disambiguated by a hash of
 * the full slug, so a long title always produces the same key and two
 * different long titles never collide. A title or company that folds to
 * nothing (a non-Latin script), or loses letters in the ASCII fold, takes
 * its identity from the portal's numeric id or a hash instead.
 */
import { casefold, sha1 } from "../../util/text.js";
import { canonicalizeUrl } from "./urlCanon.js";

export const COMPANY_MAX = 40;
export const TITLE_MAX = 60;
const HASH_LEN = 6;

const NON_SLUG = /[^a-z0-9]+/g;
const JOB_ID = /(\d{6,})/;

/** Lowercase ASCII slug. Non-Latin scripts legitimately reduce to "". */
export function slugify(text: string | null | undefined): string {
  if (!text) return "";
  const decomposed = String(text).normalize("NFKD");
  // encode("ascii", "ignore"): drop every non-ASCII code point.
  // eslint-disable-next-line no-control-regex -- the ASCII range is the point
  const asciiOnly = decomposed.replace(/[^\x00-\x7F]/g, "");
  return asciiOnly.toLowerCase().replace(NON_SLUG, "-").replace(/^-+|-+$/g, "");
}

/**
 * True when the ASCII fold dropped non-Latin letters, so the slug
 * under-identifies. Latin letters without a decomposition ("\u00f8", "\u00df") are
 * deliberately not counted: "\u00d8rsted" has keyed as "rsted" since the rule
 * existed.
 */
export function lostLetters(text: string | null | undefined): boolean {
  if (!text) return false;
  for (const ch of String(text).normalize("NFKD")) {
    if (ch.charCodeAt(0) < 128 || !/\p{L}/u.test(ch)) continue;
    if (!/\p{Script=Latin}/u.test(ch)) return true;
  }
  return false;
}

function cap(slug: string, limit: number): string {
  if (slug.length <= limit) return slug;
  const digest = sha1(slug).slice(0, HASH_LEN);
  return `${slug.slice(0, limit).replace(/-+$/, "")}-${digest}`;
}

/** The canonical dedupe key for one posting. */
export function makeKey(company: string | null | undefined, title: string | null | undefined, url = ""): string {
  let companySlug = cap(slugify(company), COMPANY_MAX);
  if (!companySlug || lostLetters(company)) {
    const name = casefold(String(company ?? "").trim()).normalize("NFC");
    const digest = sha1(name).slice(0, HASH_LEN);
    if (!name) companySlug = "unknown-company";
    else companySlug = companySlug ? `${companySlug}-${digest}` : `company-${digest}`;
  }
  let titleSlug = cap(slugify(title), TITLE_MAX);
  if (!titleSlug || lostLetters(title)) {
    const fragment = titleSlug;
    const match = JOB_ID.exec(url || "");
    if (match) {
      titleSlug = fragment ? `${fragment}-${match[1]}` : (match[1] as string);
    } else {
      const basis = slugify(String(title || url || "").normalize("NFKD"));
      // Hash the URL alone when there is one: the URL is the posting's
      // identity, the title is not.
      const digestBasis = url ? String(url) : String(title ?? "");
      const digest = sha1(digestBasis).slice(0, HASH_LEN);
      titleSlug = fragment ? `${fragment}-${digest}` : basis || `untitled-${digest}`;
    }
  }
  return `${companySlug}_${titleSlug}`;
}

const CANONICAL = /^[a-z0-9][a-z0-9-]*_[a-z0-9][a-z0-9-]*$/;

/** Structurally safe as a dedupe key and as an archive folder name. */
export function isCanonical(key: string): boolean {
  return Boolean(key) && CANONICAL.test(key);
}

/** Old three-part "company_title_location" keys: harmless but not what makeKey produces. */
export function isLegacyShape(key: string): boolean {
  if (!key || key.split("_").length - 1 <= 1) return false;
  return key
    .split("_")
    .filter(Boolean)
    .every((part) => /^[a-z0-9][a-z0-9-]*$/.test(part));
}

export interface AuditReport {
  entries: number;
  malformed_keys: string[];
  legacy_three_part_keys: string[];
  duplicate_urls: Record<string, string[]>;
  keys_not_matching_current_rule: number;
}

/**
 * Audit a predecessor seen-jobs map. Throws on a document that is not a map
 * of objects; `ok` is false when keys are malformed or URLs duplicated.
 */
export function auditSeen(doc: unknown): { ok: boolean; report: AuditReport } {
  const seen =
    doc && typeof doc === "object" && !Array.isArray(doc) && "seen" in (doc as object)
      ? (doc as { seen: unknown }).seen
      : doc;
  if (!seen || typeof seen !== "object" || Array.isArray(seen)) {
    throw new Error("expected an object of job entries");
  }
  const entries = seen as Record<string, unknown>;
  for (const [key, value] of Object.entries(entries)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`entry is not an object: ${key}`);
    }
    const url = (value as { url?: unknown }).url;
    if (url !== undefined && url !== null && typeof url !== "string") {
      throw new Error(`entry url is not a string: ${key}`);
    }
  }
  const keys = Object.keys(entries);
  const malformed = keys.filter((k) => !isCanonical(k) && !isLegacyShape(k));
  const legacy = keys.filter((k) => isLegacyShape(k));
  const byUrl = new Map<string, string[]>();
  for (const [key, value] of Object.entries(entries)) {
    const url = canonicalizeUrl(((value as { url?: string }).url as string | undefined) ?? "");
    if (url) byUrl.set(url, [...(byUrl.get(url) ?? []), key]);
  }
  const duplicates: Record<string, string[]> = {};
  for (const [url, ks] of byUrl) if (ks.length > 1) duplicates[url] = ks;
  const drift = Object.entries(entries).filter(([k, v]) => {
    const entry = v as { company?: string; title?: string; url?: string };
    return isCanonical(k) && k !== makeKey(entry.company ?? "", entry.title ?? "", entry.url ?? "");
  }).length;
  const report: AuditReport = {
    entries: keys.length,
    malformed_keys: malformed,
    legacy_three_part_keys: legacy,
    duplicate_urls: duplicates,
    keys_not_matching_current_rule: drift,
  };
  return { ok: malformed.length === 0 && Object.keys(duplicates).length === 0, report };
}
