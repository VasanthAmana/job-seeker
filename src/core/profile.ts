/**
 * The profile core (design 5.3): immutable sources, immutable versions, and
 * quote validation. Every claim cites evidence spans in a stored source; a
 * version whose quotes do not match their sources (whitespace normalised)
 * is refused, naming the claims, whoever proposed it. A fact the user
 * states in conversation is first recorded as a `user_statement` source.
 *
 * Phase 1 imports pasted text only; files (PDF, DOCX, LaTeX) arrive in
 * phase 6.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { transaction } from "../store/db.js";
import { sha256 } from "../util/text.js";
import { emitEvent, EngineError, nowIso, parseJson, type CoreContext } from "./context.js";

export const TEXT_SOURCE_KINDS = ["free_text", "resume_text"] as const;
export const CREATED_BY = ["user", "assistant", "ai_adapter", "import"] as const;

export interface Evidence {
  source_id: string;
  start?: number;
  end?: number;
  quote: string;
}

export interface Claim {
  id: string;
  type: string;
  value: string;
  evidence: Evidence[];
  [key: string]: unknown;
}

export interface ProfileDocument {
  schema: "profile@1";
  claims: Claim[];
  [key: string]: unknown;
}

interface SourceRow {
  id: string;
  kind: string;
  title: string | null;
  sha256: string;
  stored_path: string;
  extracted_text: string;
  imported_at: string;
}

const MAX_SOURCE_CHARS = 200_000;

function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function storeSource(ctx: CoreContext, kind: string, text: string, title: string | null) {
  if (typeof text !== "string" || !text.trim()) throw new EngineError("text must be a non-empty string");
  const body = normaliseNewlines(text);
  if (body.length > MAX_SOURCE_CHARS) throw new EngineError(`text is too long (${body.length} characters; the limit is ${MAX_SOURCE_CHARS})`);
  const digest = sha256(body);
  const existing = ctx.db.prepare("SELECT * FROM profile_sources WHERE kind = ? AND sha256 = ?").get(kind, digest) as SourceRow | undefined;
  if (existing) return { ...sourceView(existing), existing: true };
  const id = `src_${sha256(`${kind}\n${digest}`).slice(0, 12)}`;
  const relative = join("sources", `${id}.txt`);
  return transaction(ctx.db, () => {
    mkdirSync(join(ctx.dataDir, "sources"), { recursive: true });
    writeFileSync(join(ctx.dataDir, relative), body, { encoding: "utf8", mode: 0o600 });
    const at = nowIso(ctx);
    ctx.db
      .prepare("INSERT INTO profile_sources (id, kind, title, sha256, stored_path, extracted_text, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, kind, title, digest, relative.split("\\").join("/"), body, at);
    emitEvent(ctx, "profile.source_imported", "profile_source", id, { kind });
    const row = ctx.db.prepare("SELECT * FROM profile_sources WHERE id = ?").get(id) as unknown as SourceRow;
    return { ...sourceView(row), existing: false };
  });
}

function sourceView(row: SourceRow) {
  return { source_id: row.id, kind: row.kind, title: row.title, sha256: row.sha256, length: row.extracted_text.length, imported_at: row.imported_at };
}

/** Store pasted text (a resume or free text) as an immutable source. */
export function importTextSource(ctx: CoreContext, input: { text: unknown; kind?: unknown; title?: unknown }) {
  const kind = input.kind ?? "free_text";
  if (!(TEXT_SOURCE_KINDS as readonly unknown[]).includes(kind)) {
    throw new EngineError(`kind must be one of ${TEXT_SOURCE_KINDS.join(", ")} (files arrive in a later phase)`);
  }
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 200) : null;
  return storeSource(ctx, kind as string, input.text as string, title);
}

/** Record a fact the user stated, so claims can cite it. */
export function addStatement(ctx: CoreContext, input: { text: unknown }) {
  return storeSource(ctx, "user_statement", input.text as string, null);
}

export function getSource(ctx: CoreContext, id: string) {
  const row = ctx.db.prepare("SELECT * FROM profile_sources WHERE id = ?").get(id) as SourceRow | undefined;
  if (!row) throw new EngineError(`no profile source ${JSON.stringify(id)}`, "not_found");
  return { ...sourceView(row), text: row.extracted_text };
}

/** Whitespace-normalised text with a map from each normalised index back to the original. */
function normaliseWithMap(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (/\s/u.test(ch)) {
      if (out.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      map.push(i);
      pendingSpace = false;
    }
    out += ch;
    map.push(i);
  }
  return { text: out, map };
}

export function normaliseQuote(text: string): string {
  return text.normalize("NFC").split(/\s+/u).filter(Boolean).join(" ");
}

export interface ClaimProblem {
  claim_id: string;
  reason: string;
}

/**
 * Check every claim's evidence against its source. Returns the document
 * with each evidence span's offsets filled in, or the problems.
 */
export function validateClaims(ctx: CoreContext, document: ProfileDocument): { document: ProfileDocument; problems: ClaimProblem[] } {
  const problems: ClaimProblem[] = [];
  const ids = new Set<string>();
  const sources = new Map<string, SourceRow | null>();
  const source = (id: string) => {
    if (!sources.has(id)) {
      sources.set(id, (ctx.db.prepare("SELECT * FROM profile_sources WHERE id = ?").get(id) as SourceRow | undefined) ?? null);
    }
    return sources.get(id) ?? null;
  };
  const claims = document.claims.map((claim) => {
    if (ids.has(claim.id)) problems.push({ claim_id: claim.id, reason: "duplicate claim id" });
    ids.add(claim.id);
    const evidence = claim.evidence.map((ev) => {
      const row = source(ev.source_id);
      if (!row) {
        problems.push({ claim_id: claim.id, reason: `cites unknown source ${ev.source_id}` });
        return ev;
      }
      const quote = normaliseQuote(ev.quote);
      if (!quote) {
        problems.push({ claim_id: claim.id, reason: "has an empty quote" });
        return ev;
      }
      const text = row.extracted_text.normalize("NFC");
      if (ev.start !== undefined || ev.end !== undefined) {
        const { start, end } = ev;
        if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (end as number) > text.length || (start as number) >= (end as number)) {
          problems.push({ claim_id: claim.id, reason: `has an invalid span ${String(start)}-${String(end)} in ${ev.source_id}` });
          return ev;
        }
        if (normaliseQuote(text.slice(start, end)) !== quote) {
          problems.push({ claim_id: claim.id, reason: `quote does not match ${ev.source_id} at ${start}-${end}` });
        }
        return ev;
      }
      const { text: flat, map } = normaliseWithMap(text);
      const at = flat.indexOf(quote);
      if (at === -1) {
        problems.push({ claim_id: claim.id, reason: `quote not found in ${ev.source_id}` });
        return ev;
      }
      const start = map[at] as number;
      const end = (map[at + quote.length - 1] as number) + 1;
      return { ...ev, start, end };
    });
    return { ...claim, evidence };
  });
  return { document: { ...document, claims }, problems };
}

export function currentVersion(ctx: CoreContext): number | null {
  const row = ctx.db.prepare("SELECT MAX(version) AS v FROM profile_versions").get() as { v: number | null };
  return row.v ?? null;
}

/** Save a new profile version; refused when any claim's evidence does not check out. */
export function saveVersion(ctx: CoreContext, input: { document: ProfileDocument; note?: unknown; created_by?: unknown }) {
  const createdBy = input.created_by ?? "assistant";
  if (!(CREATED_BY as readonly unknown[]).includes(createdBy)) {
    throw new EngineError(`created_by must be one of ${CREATED_BY.join(", ")}`);
  }
  const { document, problems } = validateClaims(ctx, input.document);
  if (problems.length) {
    const named = [...new Set(problems.map((p) => p.claim_id))];
    throw new EngineError(
      `profile version refused: ${problems.map((p) => `claim ${p.claim_id} ${p.reason}`).join("; ")}`,
      "claims_rejected",
      { rejected_claims: named, problems },
    );
  }
  return transaction(ctx.db, () => {
    const parent = currentVersion(ctx);
    const version = (parent ?? 0) + 1;
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : null;
    ctx.db
      .prepare("INSERT INTO profile_versions (version, parent, document, created_by, note, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(version, parent, JSON.stringify(document), createdBy as string, note, nowIso(ctx));
    emitEvent(ctx, "profile.version_saved", "profile_version", String(version), { claims: document.claims.length, created_by: createdBy });
    return { version, parent, claims: document.claims.length, document };
  });
}

export function getProfile(ctx: CoreContext, version?: unknown) {
  if (version !== undefined && (!Number.isInteger(version) || (version as number) < 1)) {
    throw new EngineError("version must be a positive integer");
  }
  const row = (
    version === undefined
      ? ctx.db.prepare("SELECT * FROM profile_versions ORDER BY version DESC LIMIT 1").get()
      : ctx.db.prepare("SELECT * FROM profile_versions WHERE version = ?").get(version as number)
  ) as { version: number; parent: number | null; document: string; created_by: string; note: string | null; created_at: string } | undefined;
  if (version !== undefined && !row) throw new EngineError(`no profile version ${String(version)}`, "not_found");
  const sources = (ctx.db.prepare("SELECT * FROM profile_sources ORDER BY imported_at, id").all() as unknown as SourceRow[]).map(sourceView);
  return {
    version: row?.version ?? null,
    current_version: currentVersion(ctx),
    parent: row?.parent ?? null,
    created_by: row?.created_by ?? null,
    note: row?.note ?? null,
    created_at: row?.created_at ?? null,
    document: row ? parseJson<ProfileDocument | null>(row.document, null) : null,
    sources,
  };
}
