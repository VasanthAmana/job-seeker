/**
 * AT-0.1 (execution plan section 5): the harness spawns the server, completes
 * the handshake and negotiates the protocol version. `tools/list` returns
 * `status`, and calling it returns the version.
 */
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ENGINE_API, VERSION } from "../../../src/version.js";
import { startHarness, type McpHarness } from "../harness.js";

describe("AT-0.1 status over MCP", () => {
  let harness: McpHarness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("completes the handshake and negotiates a protocol version", () => {
    expect(harness.protocolVersion).toBeTruthy();
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(harness.protocolVersion);
    expect(harness.client.getServerVersion()).toEqual({
      name: "job-seeker",
      version: VERSION,
    });
  });

  it("tools/list returns status, and exactly the phase 1 tools", async () => {
    const { tools } = await harness.client.listTools();
    // Equality on purpose: a tool that appears without being listed here is a
    // tool nobody reviewed (ported from test_mcp_tools' registry check).
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "status",
        "jobs_list",
        "job_get",
        "jobs_search",
        "rank_submit",
        "applications_list",
        "application_get",
        "application_set_state",
        "profile_import_source",
        "profile_get",
        "profile_save_version",
        "profile_add_statement",
        "pipeline_page",
        "human_steps_list",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.outputSchema).toMatchObject({ type: "object" });
      expect(tool.description?.length).toBeGreaterThan(20);
    }
    // Secrets never pass through MCP (design 5.5).
    expect(tools.some((tool) => tool.name.startsWith("secrets"))).toBe(false);
  });

  it("calling status returns the version and engine_api 1", async () => {
    const result = await harness.client.callTool({ name: "status", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ version: VERSION, engine_api: ENGINE_API });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    expect(JSON.parse(content[0]?.text ?? "")).toMatchObject({
      version: VERSION,
      engine_api: ENGINE_API,
    });
  });
});
