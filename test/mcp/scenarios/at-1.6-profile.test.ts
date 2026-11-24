/**
 * AT-1.6 (execution plan section 6): `profile_import_source` stores pasted
 * text; `profile_save_version` accepts a claim whose quote matches and
 * refuses one whose quote does not, naming the claim.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarness, type McpHarness } from "../harness.js";
import { callError, callOk, withDb } from "../fixtures.js";

const RESUME = `Jordan Example (fictional) - Director of Strategy, Acme Analytics

Led the pricing redesign for a B2B analytics product across 3 regions.
Built the AI operating model for a 40-person transformation office.`;

interface Source {
  source_id: string;
  kind: string;
  existing: boolean;
}

describe("AT-1.6 profile sources and versions", () => {
  let harness: McpHarness;
  let source: Source;

  beforeAll(async () => {
    harness = await startHarness();
    source = await callOk<Source>(harness.client, "profile_import_source", { text: RESUME, kind: "resume_text", title: "Resume (fictional)" });
  });

  afterAll(async () => {
    await harness.close();
  });

  it("stores pasted text as a source, in the data directory", async () => {
    expect(source).toMatchObject({ kind: "resume_text", existing: false });
    expect(existsSync(join(harness.home, "sources", `${source.source_id}.txt`))).toBe(true);
    const again = await callOk<Source>(harness.client, "profile_import_source", { text: RESUME, kind: "resume_text" });
    expect(again).toMatchObject({ source_id: source.source_id, existing: true });
    const resource = await harness.client.readResource({ uri: `jobseeker://profile/sources/${source.source_id}` });
    expect((resource.contents[0] as { text: string }).text).toBe(RESUME);
  });

  it("refuses a version whose quote does not match, naming the claim", async () => {
    const text = await callError(harness.client, "profile_save_version", {
      document: {
        schema: "profile@1",
        claims: [
          { id: "clm_pricing", type: "achievement", value: "Pricing redesign", evidence: [{ source_id: source.source_id, quote: "Led the pricing redesign" }] },
          {
            id: "clm_invented",
            type: "achievement",
            value: "Revenue growth",
            evidence: [{ source_id: source.source_id, quote: "Grew revenue 300% in a year" }],
          },
        ],
      },
    });
    expect(text).toMatch(/claim clm_invented quote not found/);
    expect(text).not.toMatch(/clm_pricing/);
    withDb(harness.home, (db) => expect(db.prepare("SELECT COUNT(*) AS n FROM profile_versions").get()).toEqual({ n: 0 }));
  });

  it("accepts a claim whose quote matches, filling its offsets", async () => {
    const saved = await callOk<{ version: number; claims: number; document: { claims: Array<{ evidence: Array<{ start: number; end: number }> }> } }>(
      harness.client,
      "profile_save_version",
      {
        document: {
          schema: "profile@1",
          claims: [
            {
              id: "clm_pricing",
              type: "achievement",
              value: "B2B pricing redesign across 3 regions",
              evidence: [{ source_id: source.source_id, quote: "Led the pricing redesign for a B2B analytics product across 3 regions" }],
            },
          ],
        },
        note: "First version",
      },
    );
    expect(saved).toMatchObject({ version: 1, claims: 1 });
    const span = saved.document.claims[0]?.evidence[0];
    expect(RESUME.slice(span?.start, span?.end)).toBe("Led the pricing redesign for a B2B analytics product across 3 regions");
    const profile = await callOk<{ version: number; created_by: string; sources: unknown[] }>(harness.client, "profile_get");
    expect(profile).toMatchObject({ version: 1, created_by: "assistant" });
    expect(profile.sources).toHaveLength(1);
  });

  it("lets a stated fact back a claim", async () => {
    const statement = await callOk<Source>(harness.client, "profile_add_statement", { text: "I also mentor two strategy analysts." });
    expect(statement.kind).toBe("user_statement");
    const saved = await callOk<{ version: number }>(harness.client, "profile_save_version", {
      document: {
        schema: "profile@1",
        claims: [{ id: "clm_mentor", type: "fact", value: "Mentors analysts", evidence: [{ source_id: statement.source_id, quote: "mentor two strategy analysts" }] }],
      },
    });
    expect(saved.version).toBe(2);
    const current = await harness.client.readResource({ uri: "jobseeker://profile/current" });
    expect(JSON.parse((current.contents[0] as { text: string }).text)).toMatchObject({ version: 2 });
  });
});
