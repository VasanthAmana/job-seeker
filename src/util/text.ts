import { createHash } from "node:crypto";

export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sha1(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/**
 * Ignore case and separators without discarding non-Latin identity.
 * Port of rank_state.norm: NFC of the casefolded text, keeping letters,
 * digits and combining marks.
 */
export function norm(text: unknown): string {
  const folded = casefold(String(text ?? "")).normalize("NFC");
  let out = "";
  for (const ch of folded) {
    if (/[\p{L}\p{N}\p{M}]/u.test(ch)) out += ch;
  }
  return out;
}

/**
 * Python's str.casefold() for the cases that matter to identity: lowercase,
 * then the two common full foldings lowercase alone leaves (final sigma and
 * sharp s).
 */
export function casefold(text: string): string {
  return text.toLowerCase().replace(/\u03c2/g, "\u03c3").replace(/\u00df/g, "ss");
}

/** Collapse whitespace runs to one space and trim (Python's " ".join(s.split())). */
export function squash(text: unknown): string {
  return String(text ?? "")
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ");
}

/** A stable JSON rendering: object keys sorted, for hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** HTML-escape like Python's html.escape(value, quote=True). */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
