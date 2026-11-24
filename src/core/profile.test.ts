/**
 * The profile core (design 5.3): immutable sources, versions, and quote
 * validation that names the failing claims.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeCtx, type TestContext } from "../../test/support/core.js";
import { EngineError } from "./context.js";
import { addStatement, getProfile, importTextSource, saveVersion, type ProfileDocument } from "./profile.js";

const RESUME = `Jordan Example - Director of Strategy (fictional)

Led the pricing redesign for a B2B analytics
product across 3 regions.
Built an AI operating model for a 40-person   transformation office.`;

let ctx: TestContext;
beforeEach(() => {
  ctx = makeCtx();
});
afterEach(() => ctx.close());

const doc = (claims: ProfileDocument["claims"]): ProfileDocument => ({ schema: "profile@1", claims });

describe("sources", () => {
  it("store pasted text once, in the data directory", () => {
    const first = importTextSource(ctx, { text: RESUME, kind: "resume_text", title: "Resume" });
    expect(first.existing).toBe(false);
    expect(first.source_id).toMatch(/^src_[0-9a-f]{12}$/);
    const stored = join(ctx.dataDir, "sources", `${first.source_id}.txt`);
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored, "utf8")).toBe(RESUME);
    const again = importTextSource(ctx, { text: RESUME, kind: "resume_text" });
    expect(again).toMatchObject({ source_id: first.source_id, existing: true });
  });

  it("refuse empty text and file kinds that arrive later", () => {
    expect(() => importTextSource(ctx, { text: "   " })).toThrow(EngineError);
    expect(() => importTextSource(ctx, { text: "x", kind: "resume_pdf" })).toThrow(/kind must be/);
  });
});

describe("versions", () => {
  it("accept a claim whose quote matches, whitespace normalised, and fill its offsets", () => {
    const { source_id } = importTextSource(ctx, { text: RESUME, kind: "resume_text" });
    const saved = saveVersion(ctx, {
      document: doc([
        {
          id: "clm_pricing",
          type: "achievement",
          value: "B2B pricing redesign",
          evidence: [{ source_id, quote: "Led the pricing redesign for a B2B analytics product across 3 regions" }],
        },
      ]),
    });
    expect(saved.version).toBe(1);
    const evidence = saved.document.claims[0]?.evidence[0];
    expect(RESUME.slice(evidence?.start, evidence?.end).replace(/\s+/g, " ")).toBe(
      "Led the pricing redesign for a B2B analytics product across 3 regions",
    );
    expect(getProfile(ctx).document?.claims).toHaveLength(1);
  });

  it("accept explicit offsets that match", () => {
    const { source_id } = importTextSource(ctx, { text: RESUME });
    const start = RESUME.indexOf("Built an AI");
    const end = RESUME.indexOf("office.") + "office".length;
    expect(() =>
      saveVersion(ctx, {
        document: doc([
          { id: "clm_ops", type: "achievement", value: "AI operating model", evidence: [{ source_id, start, end, quote: "Built an AI operating model for a 40-person transformation office" }] },
        ]),
      }),
    ).not.toThrow();
  });

  it("refuse a version whose quote does not match, naming the claim", () => {
    const { source_id } = importTextSource(ctx, { text: RESUME });
    let error: unknown;
    try {
      saveVersion(ctx, {
        document: doc([
          { id: "clm_ok", type: "skill", value: "pricing", evidence: [{ source_id, quote: "Led the pricing redesign" }] },
          { id: "clm_invented", type: "achievement", value: "grew revenue", evidence: [{ source_id, quote: "Grew revenue 300% in one year" }] },
        ]),
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).message).toMatch(/clm_invented/);
    expect((error as EngineError).message).not.toMatch(/clm_ok/);
    expect(((error as EngineError).details as { rejected_claims: string[] }).rejected_claims).toEqual(["clm_invented"]);
    expect(getProfile(ctx).version).toBeNull();
  });

  it("refuse a mismatched span, an unknown source and a duplicate id", () => {
    const { source_id } = importTextSource(ctx, { text: RESUME });
    const attempt = (claims: ProfileDocument["claims"]) => () => saveVersion(ctx, { document: doc(claims) });
    expect(attempt([{ id: "a", type: "skill", value: "x", evidence: [{ source_id, start: 0, end: 6, quote: "Led the" }] }])).toThrow(/does not match/);
    expect(attempt([{ id: "b", type: "skill", value: "x", evidence: [{ source_id: "src_nope", quote: "Led" }] }])).toThrow(/unknown source/);
    expect(
      attempt([
        { id: "c", type: "skill", value: "x", evidence: [{ source_id, quote: "Led" }] },
        { id: "c", type: "skill", value: "y", evidence: [{ source_id, quote: "Built" }] },
      ]),
    ).toThrow(/duplicate claim id/);
  });

  it("let a stated fact back a claim through a user_statement source", () => {
    const statement = addStatement(ctx, { text: "I hold a fictional certificate in AI governance." });
    expect(statement.kind).toBe("user_statement");
    const saved = saveVersion(ctx, {
      document: doc([
        {
          id: "clm_cert",
          type: "certification",
          value: "AI governance certificate",
          evidence: [{ source_id: statement.source_id, quote: "certificate in AI governance" }],
        },
      ]),
      created_by: "user",
    });
    expect(saved.version).toBe(1);
    const second = saveVersion(ctx, { document: doc([]), note: "cleared" });
    expect(second).toMatchObject({ version: 2, parent: 1 });
    expect(getProfile(ctx, 1).document?.claims[0]?.id).toBe("clm_cert");
  });
});
