# Phase 0 client check

- **Acceptance scenarios covered:** AT-0.1 (handshake, `tools/list`,
  `status`) and AT-0.2 (protocol error paths) - both passed in CI.
- **Real-account manual checks:** none - fictional data only. This check
  touches no account; it only proves both real clients can launch the stub
  server and call `status`.

The phase 0 client check from the execution plan (section 5): add the stub
to Claude Desktop and to Codex by hand; ask each for job-seeker's status.

## Prerequisites

- Node.js 22 or later (`node --version`).
- This repository, with the engine built: `npm ci && npm run build`.
- Claude Desktop and Codex installed.

## Steps

1. Add the stub server to **Claude Desktop**'s configuration
   (`claude_desktop_config.json`), pointing at the built CLI with a
   throwaway data directory, for example:

   ```json
   {
     "mcpServers": {
       "job-seeker": {
         "command": "node",
         "args": ["/absolute/path/to/job-seeker/dist/cli.js", "mcp"],
         "env": { "JOB_SEEKER_HOME": "/tmp/job-seeker-demo" }
       }
     }
   }
   ```

2. Add it to **Codex**'s configuration (`~/.codex/config.toml`):

   ```toml
   [mcp_servers.job-seeker]
   command = "node"
   args = ["/absolute/path/to/job-seeker/dist/cli.js", "mcp"]
   env = { JOB_SEEKER_HOME = "/tmp/job-seeker-demo" }
   ```

3. Restart Claude Desktop, then ask it: "What is job-seeker's status?"
   - Expected: the assistant calls the `status` tool and reports the
     version (the one in `package.json`) and `engine_api: 1`.
4. Ask Codex the same question.
   - Expected: the same answer.
5. Remove both configuration entries again when done.

## Results

Outcomes only - never personal data, account details or captures.

| Date | Client | Result | Notes |
|---|---|---|---|
| | Claude Desktop | | |
| | Codex | | |
