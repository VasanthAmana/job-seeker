/**
 * Spec for the pipeline page, translated from dashboard/tests (9) on the
 * same tracker fixture. The rows now come from the database (design
 * 10.3), so the fixture enters through the legacy import, and by design:
 * - the predecessor's seven tracker buckets become the seven application
 *   states (hired is an offer; withdrawn and no-response are rejections,
 *   with the old status kept in the note; an unknown status is `found`);
 * - ranked postings become the current top matches, which show the shown
 *   score and its method, so a vetoed job is not among them;
 * - "Waiting for you" and pending approvals join the page.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeCtx, type TestContext } from "../../test/support/core.js";
import { importLegacy } from "../legacy/import.js";
import { collect, computeStats, renderHtml, writePipelinePage } from "./page.js";

const TRACKER = fileURLToPath(new URL("../../dashboard/tests/fixtures/tracker_sample.csv", import.meta.url));

function seenDoc() {
  const base = {
    first_seen: "2026-10-28",
    status: "ranked",
    rank_date: "2026-10-29",
    rank_verdict: "Strong Fit",
    location_verdict: "PASS",
    seniority_gate: "PASS",
    engineering_role: false,
    reason: "Fits.",
  };
  return {
    seen: {
      k1: { ...base, title: "VP AI", company: "LinkedCo", url: "https://l.example/1", source: "linkedin", rank_score: 82 },
      k2: { ...base, title: "Dir Strategy", company: "MailCo", url: "https://m.example/2", source: "indeed", rank_score: 61, deadline: "2026-11-04", engineering_role: true },
      k3: { ...base, title: "Skipped", company: "NewCo", url: "https://n.example/3", source: "ladders", status: "new" },
    },
  };
}

let ctx: TestContext;
let scratch: string;
beforeEach(() => {
  ctx = makeCtx({ now: "2026-11-02T09:00:00Z" });
  scratch = mkdtempSync(join(tmpdir(), "job-seeker-page-"));
  writeFileSync(join(scratch, "seen_jobs.json"), JSON.stringify(seenDoc()));
  writeFileSync(join(scratch, "last_run.json"), JSON.stringify({ ranked: [{ key: "k1" }] }));
  importLegacy(ctx, { seen_jobs: join(scratch, "seen_jobs.json"), last_run: join(scratch, "last_run.json"), tracker: TRACKER });
});
afterEach(() => {
  ctx.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("pipeline page data (dashboard collect)", () => {
  it("counts applications by state, leaving unsent ones out of the stats", () => {
    const s = collect(ctx).stats;
    expect(s.stage_counts).toEqual({ found: 1, shortlisted: 1, resume_prepared: 1, applied: 3, interview: 1, offer: 1, rejected: 2 });
    expect(s.sent).toBe(7);
    expect(s.funnel).toEqual({ Applied: 7, Interview: 2, Offer: 1 });
    // 2 rejections among 3 decided applications (2 rejected, 1 offer).
    expect(s.rejection_rate).toBe(67);
  });

  it("keeps an unknown status and a short row", () => {
    const rows = collect(ctx).rows;
    expect(rows.find((r) => r.company === "Theta")).toMatchObject({ origin: "application", stage: "found", notes: "legacy status: mystery" });
    expect(rows.some((r) => r.company === "Iota")).toBe(true);
  });

  it("works out follow-ups and deadlines", () => {
    const rows = Object.fromEntries(collect(ctx).rows.filter((r) => r.origin === "application").map((r) => [r.company, r]));
    expect(rows["Acme <Corp>"]).toMatchObject({ due_kind: "follow-up", due: "2026-10-27", due_state: "overdue" });
    // applied 10-30 -> follow-up 11-06; the deadline 11-05 is earlier and within a week
    expect(rows["Beta Inc"]).toMatchObject({ due_kind: "deadline", due_state: "soon" });
    expect(rows.Gamma?.due).toBe(""); // interview: no follow-up
    expect(rows.Iota?.due).toBe(""); // bare year: nothing inferred
    expect(rows.Eta?.due).toBe("2026-11-03"); // resume prepared keeps its deadline
  });

  it("shows top matches with their shown score, method and sources, never a vetoed job", () => {
    const matches = Object.fromEntries(collect(ctx).rows.filter((r) => r.origin === "match").map((r) => [r.company, r]));
    expect(matches.LinkedCo).toMatchObject({ score: 6.5, score_method: "rule", sources: ["legacy:linkedin"] });
    expect(matches.MailCo).toBeUndefined();
    expect(Object.values(matches).every((m) => m.score_method === "rule" && m.sources.length > 0)).toBe(true);
  });
});

describe("pipeline page HTML (dashboard render_html)", () => {
  it("has the table, filters, sources and escaping", () => {
    const data = collect(ctx);
    const html = renderHtml(data);
    expect(html.match(/<tr data-q=/g)).toHaveLength(data.rows.length);
    for (const needle of ['id="q"', 'id="f-stage"', 'id="f-source"', 'value="legacy:linkedin"', 'value="legacy:tracker"', 'value="applied"']) {
      expect(html).toContain(needle);
    }
    expect(html).toContain("Acme &lt;Corp&gt;");
    expect(html).not.toContain("Acme <Corp>");
    expect(html).toContain("&quot;quietly&quot;");
    expect(html).toContain("<svg");
    expect(html).toContain('role="img"');
    expect(html).toContain("Nothing is waiting for you.");
    expect(html).toContain("No approvals are pending.");
  });

  it("makes no network references", () => {
    const html = renderHtml(collect(ctx));
    expect(html).not.toMatch(/(src|href)="https?:\/\/(?!example\.com|[lmn]\.example)/);
    for (const banned of ["<script src", "<link", "@import", "fetch("]) expect(html).not.toContain(banned);
  });

  it("renders an empty state", () => {
    const empty = makeCtx();
    try {
      expect(renderHtml(collect(empty))).toContain("Job search pipeline");
    } finally {
      empty.close();
    }
  });

  it("lists waiting human steps and pending approvals, escaped", () => {
    ctx.db
      .prepare("INSERT INTO human_steps (id, compartment, reason, detail, open_what, opened_at) VALUES ('hs_1', 'linkedin', 'challenge', '<b>x</b>', 'open Handyman', '2026-11-02T08:00:00Z')")
      .run();
    ctx.db
      .prepare(
        "INSERT INTO approvals (id, subject_kind, subject_id, payload_sha256, summary, status, requested_by, requested_at) VALUES ('apr_1', 'criteria_change', 'chg_1', 'x', 'Add <title>', 'pending', 'assistant', '2026-11-02T08:00:00Z')",
      )
      .run();
    const html = renderHtml(collect(ctx));
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("Add &lt;title&gt;");
  });

  it("writes reports/pipeline.html in the data directory with LF line endings", () => {
    const out = writePipelinePage(ctx);
    expect(out.path).toBe(join(ctx.dataDir, "reports", "pipeline.html"));
    const bytes = readFileSync(out.path);
    expect(bytes.subarray(0, 15).toString()).toBe("<!doctype html>");
    expect(bytes.includes("\r\n")).toBe(false);
    expect(out.summary.applications.applied).toBe(3);
    expect(computeStats([]).sent).toBe(0);
  });
});
