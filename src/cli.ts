#!/usr/bin/env node
import { serveStdio } from "./mcp/server.js";
import { VERSION } from "./version.js";

const USAGE = `job-seeker ${VERSION}

Usage: job-seeker <command>

Commands:
  mcp         Serve MCP over stdio (the server Claude Desktop and Codex launch)
  --version   Print the version
  --help      Show this help
`;

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  switch (command) {
    case "mcp":
      await serveStdio();
      return 0;
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    case undefined:
      process.stderr.write(USAGE);
      return 2;
    default:
      process.stderr.write(`job-seeker: unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`job-seeker: ${message}\n`);
    process.exitCode = 1;
  },
);
