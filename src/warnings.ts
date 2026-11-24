/**
 * Silence Node's "SQLite is an experimental feature" warning. The CLI
 * imports this module first, before anything loads `node:sqlite`, so the
 * warning never reaches the user's terminal or an MCP client's log
 * (docs/decisions/storage-driver.md). Every other warning still prints.
 */
const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  const first = rest[0];
  const type = typeof first === "string" ? first : (first as { type?: string } | undefined)?.type;
  if (type === "ExperimentalWarning" && /SQLite/i.test(text)) return;
  emit(warning, ...rest);
}) as typeof process.emitWarning;

export {};
