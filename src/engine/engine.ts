/**
 * The Engine: the one boundary every caller goes through (design 4).
 *
 * It opens the data directory lazily, on the first call, so a process that
 * cannot open it (a data directory inside a git work tree, a database from
 * a newer job-seeker, a malformed config.json) still starts and answers
 * every call with a clear error instead of dying. Every call's input is
 * validated against the operation's JSON Schema, and so is its output.
 */
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import { EngineError, type CoreContext } from "../core/context.js";
import { rescoreIfRulesChanged } from "../core/jobs.js";
import { ConfigError, loadSettings } from "../core/settings.js";
import { DataDirError } from "../store/dataDir.js";
import { NewerDatabaseError, openDatabase, type Database } from "../store/db.js";
import { clockFromEnv, type Clock } from "../util/clock.js";
import { findOperation, OPERATIONS, type CallMeta, type Operation } from "./operations.js";
import { loadOperationSchemas, type JsonSchema } from "./schemas.js";

export interface EngineOptions {
  dataDir: string;
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, { input: ValidateFunction; output: ValidateFunction }>();

function validatorsFor(name: string) {
  let entry = validators.get(name);
  if (!entry) {
    const schemas = loadOperationSchemas(name);
    entry = { input: ajv.compile(schemas.input), output: ajv.compile(schemas.output) };
    validators.set(name, entry);
  }
  return entry;
}

/** Plain-language messages for schema failures, naming unknown arguments. */
export function describeErrors(operation: string, errors: ErrorObject[] | null | undefined): string {
  const messages = (errors ?? []).map((error) => {
    const where = error.instancePath ? error.instancePath.slice(1).replace(/\//g, ".") : "";
    if (error.keyword === "additionalProperties") {
      const extra = (error.params as { additionalProperty: string }).additionalProperty;
      return where ? `unknown argument: ${where}.${extra}` : `unknown argument: ${extra}`;
    }
    if (error.keyword === "required") {
      const missing = (error.params as { missingProperty: string }).missingProperty;
      return where ? `missing argument: ${where}.${missing}` : `missing argument: ${missing}`;
    }
    return `${where || "arguments"} ${error.message ?? "is invalid"}`;
  });
  return `${operation}: ${[...new Set(messages)].join("; ")}`;
}

export class Engine {
  readonly dataDir: string;
  readonly clock: Clock;
  readonly env: NodeJS.ProcessEnv;
  private ctx: CoreContext | null = null;

  constructor(options: EngineOptions) {
    this.dataDir = options.dataDir;
    this.env = options.env ?? process.env;
    this.clock = options.clock ?? clockFromEnv(this.env);
  }

  /** Open (and migrate) the data directory, or explain why it cannot be. */
  context(): CoreContext {
    if (this.ctx) return this.ctx;
    let db: Database | null = null;
    try {
      const settings = loadSettings(this.dataDir);
      db = openDatabase({ dataDir: this.dataDir, clock: this.clock }).db;
      const ctx: CoreContext = { db, clock: this.clock, settings, dataDir: this.dataDir };
      rescoreIfRulesChanged(ctx);
      this.ctx = ctx;
      return ctx;
    } catch (error) {
      db?.close();
      if (error instanceof NewerDatabaseError) throw new EngineError(error.message, "upgrade_required");
      if (error instanceof DataDirError) throw new EngineError(error.message, "data_dir");
      if (error instanceof ConfigError) throw new EngineError(error.message, "config");
      throw error;
    }
  }

  operations(surface: CallMeta["surface"]): Array<Operation<Record<string, unknown>, unknown> & { inputSchema: JsonSchema; outputSchema: JsonSchema }> {
    return OPERATIONS.filter((operation) => operation.surfaces.includes(surface)).map((operation) => {
      const schemas = loadOperationSchemas(operation.name);
      return { ...operation, inputSchema: schemas.input, outputSchema: schemas.output };
    });
  }

  /** Validate, run and check one operation. Throws EngineError for anything the caller should see. */
  call(name: string, input: unknown, meta: CallMeta): unknown {
    const operation = findOperation(name);
    if (!operation || !operation.surfaces.includes(meta.surface)) throw new EngineError(`unknown tool: ${name}`, "unknown_operation");
    const args = input ?? {};
    if (typeof args !== "object" || Array.isArray(args)) throw new EngineError(`${name}: arguments must be an object`);
    const { input: validateInput, output: validateOutput } = validatorsFor(name);
    if (!validateInput(args)) throw new EngineError(describeErrors(name, validateInput.errors), "invalid_arguments");
    const ctx = this.context();
    const result = operation.handler(ctx, args as Record<string, unknown>, { env: this.env, ...meta });
    if (!validateOutput(result)) {
      throw new Error(`internal error: ${name} produced output that fails its schema (${describeErrors(name, validateOutput.errors)})`);
    }
    return result;
  }

  close(): void {
    this.ctx?.db.close();
    this.ctx = null;
  }
}
