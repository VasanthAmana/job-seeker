import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

/** The package version, reported by `job-seeker --version` and the `status` MCP tool. */
export const VERSION: string = packageJson.version;

/** Engine API level (design 4). A breaking change adds v2 and keeps v1 for one minor release. */
export const ENGINE_API = 1;
