/**
 * AT-0.2 (execution plan section 5): an unknown tool, non-object arguments
 * and an unknown argument each return an MCP error, not a crash. These port
 * the error-path cases of the Python server's test_mcp_server and
 * test_mcp_tools.
 */
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { startHarness, type McpHarness } from "../harness.js";

describe("AT-0.2 protocol error paths", () => {
  let harness: McpHarness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("an unknown tool returns an error result, and the server keeps serving", async () => {
    const result = await harness.client.callTool({
      name: "delete_everything",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/unknown tool: delete_everything/);

    const followUp = await harness.client.callTool({ name: "status", arguments: {} });
    expect(followUp.isError).toBeFalsy();
  });

  it.each(["a string", ["an", "array"], 42])(
    "non-object arguments (%j) return an MCP error, and the server keeps serving",
    async (badArguments) => {
      // Sent through client.request because callTool's own typing only
      // allows an object; the server must answer with an MCP error
      // (here a JSON-RPC InvalidParams from request validation), not a crash.
      await expect(
        harness.client.request(
          { method: "tools/call", params: { name: "status", arguments: badArguments } },
          CallToolResultSchema,
        ),
      ).rejects.toBeInstanceOf(McpError);

      const followUp = await harness.client.callTool({ name: "status", arguments: {} });
      expect(followUp.isError).toBeFalsy();
    },
  );

  it("an unknown argument returns an error result, and the server keeps serving", async () => {
    const result = await harness.client.callTool({
      name: "status",
      arguments: { verbose: true },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/unknown argument: verbose/);

    const followUp = await harness.client.callTool({ name: "status", arguments: {} });
    expect(followUp.isError).toBeFalsy();
  });
});
