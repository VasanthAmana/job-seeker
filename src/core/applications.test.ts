/** Applications and their states (design 5.2). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeCtx, type TestContext } from "../../test/support/core.js";
import { getApplication, listApplications, setApplicationState } from "./applications.js";
import { ingest } from "./jobs.js";

let ctx: TestContext;
let jobId: string;
beforeEach(() => {
  ctx = makeCtx();
  jobId = ingest(ctx, [{ title: "Director, AI Strategy", company: "Acme", url: "https://a.example/1" }], { connector: "test" }).added[0] as string;
});
afterEach(() => ctx.close());

const events = () =>
  ctx.db.prepare("SELECT payload FROM events WHERE type = 'application.state_changed' ORDER BY cursor").all() as Array<{ payload: string }>;

describe("applications", () => {
  it("move through found, shortlisted and applied, with an event each time", () => {
    expect(setApplicationState(ctx, jobId, "found")).toMatchObject({ from_state: null, state: "found", changed: true });
    expect(setApplicationState(ctx, jobId, "shortlisted")).toMatchObject({ from_state: "found", changed: true });
    expect(setApplicationState(ctx, jobId, "applied", { note: "sent via careers page" })).toMatchObject({ from_state: "shortlisted" });
    expect(events().map((e) => JSON.parse(e.payload))).toEqual([
      { from: null, to: "found" },
      { from: "found", to: "shortlisted" },
      { from: "shortlisted", to: "applied" },
    ]);
    const app = getApplication(ctx, jobId);
    expect(app.state).toBe("applied");
    expect(app.events.map((e) => e.to_state)).toEqual(["found", "shortlisted", "applied"]);
    expect(app.events[2]?.note).toBe("sent via careers page");
  });

  it("treat the same state as no change, with no event", () => {
    setApplicationState(ctx, jobId, "found");
    expect(setApplicationState(ctx, jobId, "found")).toMatchObject({ changed: false });
    expect(events()).toHaveLength(1);
  });

  it("refuse an unknown state and an unknown job", () => {
    expect(() => setApplicationState(ctx, jobId, "hired")).toThrow(/unknown application state/);
    expect(() => setApplicationState(ctx, "job_nope", "found")).toThrow(/no job/);
  });

  it("list by state with counts", () => {
    setApplicationState(ctx, jobId, "interview");
    const all = listApplications(ctx);
    expect(all.count).toBe(1);
    expect(all.counts.interview).toBe(1);
    expect(listApplications(ctx, "offer").count).toBe(0);
    expect(() => listApplications(ctx, "bogus")).toThrow();
  });
});
