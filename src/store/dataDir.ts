/**
 * Where job-seeker keeps its data (design 5.1), and the rule that keeps it
 * out of git: job-seeker refuses a data directory inside a git work tree,
 * so private data cannot be committed by accident (execution plan section
 * 2, rule 3).
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "job-seeker");
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, "job-seeker");
  }
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "job-seeker");
}

/** JOB_SEEKER_HOME when set, else the platform default. Always absolute. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.JOB_SEEKER_HOME;
  return resolve(override && override.trim() ? override : defaultDataDir(env));
}

/** The root of the git work tree containing `dir` (or the nearest existing ancestor), or null. */
export function findGitWorkTree(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    const marker = join(current, ".git");
    if (existsSync(marker)) {
      try {
        const stat = statSync(marker);
        if (stat.isDirectory() || stat.isFile()) return current;
      } catch {
        // unreadable marker: keep walking
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export class DataDirError extends Error {
  override name = "DataDirError";
}

export function assertOutsideGit(dir: string): void {
  const root = findGitWorkTree(dir);
  if (root !== null) {
    throw new DataDirError(
      `job-seeker refuses a data directory inside a git work tree (${root}): private data could be committed. ` +
        "Set JOB_SEEKER_HOME to a folder outside any repository.",
    );
  }
}
