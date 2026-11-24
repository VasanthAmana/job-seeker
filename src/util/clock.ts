/**
 * The injectable clock (execution plan section 3). The engine never reads
 * the system time directly; tests and the MCP harness pin it with
 * JOB_SEEKER_NOW (an ISO 8601 date-time).
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`invalid clock time: ${iso}`);
  }
  return { now: () => new Date(at.getTime()) };
}

/** The clock the environment asks for: JOB_SEEKER_NOW when set, else the system clock. */
export function clockFromEnv(env: NodeJS.ProcessEnv = process.env): Clock {
  const pinned = env.JOB_SEEKER_NOW;
  return pinned ? fixedClock(pinned) : systemClock;
}

/** YYYY-MM-DD of a date in UTC. */
export function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** YYYY-MM-DDTHH:MM:SSZ (the predecessor's stored timestamp shape). */
export function isoSeconds(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** A strict YYYY-MM-DD, or null: never compared, never guessed at. */
export function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return null;
  return text;
}

/** Days from date a to date b (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function addDays(day: string, days: number): string {
  return isoDate(new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000));
}
