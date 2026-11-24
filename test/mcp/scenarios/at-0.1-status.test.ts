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

  it("tools/list returns the status tool", async () => {
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["status"]);
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });
  });

  it("calling status returns the version and engine_api 1", async () => {
    const result = await harness.client.callTool({ name: "status", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ version: VERSION, engine_api: ENGINE_API });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    expect(JSON.parse(content[0]?.text ?? "")).toEqual({
      version: VERSION,
      engine_api: ENGINE_API,
    });
  });
});
