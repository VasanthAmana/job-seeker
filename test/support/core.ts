/**
 * Unit-test support: an engine-core context over a fresh temporary data
 * directory and a pinned clock. Nothing here touches the user's data.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CoreContext } from "../../src/core/context.js";
import { deepMerge, DEFAULTS, type Settings } from "../../src/core/settings.js";
import { openDatabase } from "../../src/store/db.js";
import { fixedClock, type Clock } from "../../src/util/clock.js";

export interface TestContext extends CoreContext {
  setNow(iso: string): void;
  close(): void;
}

export function makeCtx(options: { settings?: Record<string, unknown>; now?: string } = {}): TestContext {
  const dataDir = mkdtempSync(join(tmpdir(), "job-seeker-unit-"));
  let clock: Clock = fixedClock(options.now ?? "2026-11-02T09:00:00Z");
  const clockProxy: Clock = { now: () => clock.now() };
  const settings: Settings = options.settings ? deepMerge(DEFAULTS, options.settings) : structuredClone(DEFAULTS);
  const { db } = openDatabase({ dataDir, clock: clockProxy });
  return {
    db,
    clock: clockProxy,
    settings,
    dataDir,
    setNow(iso: string) {
      clock = fixedClock(iso);
    },
    close() {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
