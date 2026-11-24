import type { Database } from "../store/db.js";
import type { Clock } from "../util/clock.js";
import type { Settings } from "./settings.js";

/** What every engine-core function works against. */
export interface CoreContext {
  db: Database;
  clock: Clock;
  settings: Settings;
  dataDir: string;
}

/** A refusal the caller can show as is: bad input, an unknown id, a rule that says no. */
export class EngineError extends Error {
  override name = "EngineError";
  constructor(
    message: string,
    readonly code: string = "invalid_request",
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function nowIso(ctx: Pick<CoreContext, "clock">): string {
  return ctx.clock.now().toISOString();
}

/** Append a domain event (design 4). Returns its cursor. */
export function emitEvent(
  ctx: Pick<CoreContext, "db" | "clock">,
  type: string,
  entity: string,
  entityId: string | null,
  payload: Record<string, unknown> = {},
): number {
  const result = ctx.db
    .prepare("INSERT INTO events (type, entity, entity_id, payload, at) VALUES (?, ?, ?, ?, ?)")
    .run(type, entity, entityId, JSON.stringify(payload), nowIso(ctx));
  return Number(result.lastInsertRowid);
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
