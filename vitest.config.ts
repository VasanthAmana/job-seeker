import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The MCP acceptance scenarios (AT-*.mcp.test.ts live next to the
    // harness; unit suites of later phases live under src/).
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // Scenarios spawn the real server as a child process, which is slow on a
    // loaded CI runner (Windows especially).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
