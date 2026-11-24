import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { ENGINE_API, VERSION } from "../version.js";

const STATUS_TOOL = {
  name: "status",
  description:
    "Report the job-seeker build version and Engine API level. Later phases add service state, next runs, waiting human steps, pending approvals and connector state (design 9).",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      version: { type: "string", description: "The job-seeker package version." },
      engine_api: { type: "integer", description: "The Engine API level (design 4)." },
    },
    required: ["version", "engine_api"],
    additionalProperties: false,
  },
} as const;

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * The phase 0 stub MCP server: one `status` tool.
 *
 * Error paths (AT-0.2, ported from the Python server's test_mcp_server and
 * test_mcp_tools): an unknown tool or a bad argument shape comes back as an
 * MCP error and the server keeps serving; nothing here may throw the process
 * away over one bad call.
 */
export function createServer(): Server {
  const server = new Server(
    { name: "job-seeker", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [STATUS_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name } = request.params;
    const args: unknown = request.params.arguments;

    if (name !== STATUS_TOOL.name) {
      return errorResult(`unknown tool: ${name}`);
    }
    // The SDK has already rejected non-object `arguments` with a JSON-RPC
    // InvalidParams error before this handler runs, so `args` here is always
    // an object when present; what remains is rejecting unknown arguments.
    const unknown = Object.keys((args ?? {}) as Record<string, unknown>);
    if (unknown.length > 0) {
      return errorResult(`status: unknown argument: ${unknown.join(", ")}`);
    }

    const payload = { version: VERSION, engine_api: ENGINE_API };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  });

  return server;
}

/** Serve MCP over stdio, exactly as Claude Desktop and Codex launch it. */
export async function serveStdio(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
