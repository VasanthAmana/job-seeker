/**
 * Engine API v1 schemas (design 4): one JSON file per operation under
 * `schemas/engine/v1/`, with an `input` and an `output` JSON Schema, plus
 * `_common.json` for shared definitions. References into `_common.json`
 * are inlined on load, so every schema handed to MCP clients (which do not
 * resolve cross-file references) is self-contained.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type JsonSchema = Record<string, unknown>;

export interface OperationSchemas {
  input: JsonSchema;
  output: JsonSchema;
}

/** The schemas directory: `<package>/schemas/engine/v1/` from both src/ and dist/. */
export const SCHEMA_DIR = fileURLToPath(new URL("../../schemas/engine/v1/", import.meta.url));

const COMMON_PREFIX = "_common.json#/$defs/";
const LOCAL_PREFIX = "#/$defs/";

function readJson(file: string): JsonSchema {
  return JSON.parse(readFileSync(`${SCHEMA_DIR}${file}`, "utf8")) as JsonSchema;
}

let commonDefs: Record<string, JsonSchema> | null = null;

function defs(): Record<string, JsonSchema> {
  commonDefs ??= (readJson("_common.json").$defs ?? {}) as Record<string, JsonSchema>;
  return commonDefs;
}

/** Replace `$ref`s to the shared definitions with the definitions themselves. */
export function inlineRefs(node: unknown, inCommon = false): unknown {
  if (Array.isArray(node)) return node.map((item) => inlineRefs(item, inCommon));
  if (!node || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;
  const ref = record.$ref;
  if (typeof ref === "string") {
    let name: string | null = null;
    if (ref.startsWith(COMMON_PREFIX)) name = ref.slice(COMMON_PREFIX.length);
    else if (inCommon && ref.startsWith(LOCAL_PREFIX)) name = ref.slice(LOCAL_PREFIX.length);
    if (name !== null) {
      const target = defs()[name];
      if (!target) throw new Error(`unknown schema definition: ${ref}`);
      const { $ref: _ref, ...rest } = record;
      const inlined = inlineRefs(structuredClone(target), true) as Record<string, unknown>;
      return Object.keys(rest).length ? { ...inlined, ...(inlineRefs(rest, inCommon) as object) } : inlined;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) out[key] = inlineRefs(value, inCommon);
  return out;
}

const cache = new Map<string, OperationSchemas>();

export function loadOperationSchemas(name: string): OperationSchemas {
  const cached = cache.get(name);
  if (cached) return cached;
  const raw = readJson(`${name}.json`);
  if (!raw.input || !raw.output) throw new Error(`schema ${name}.json needs an input and an output`);
  const schemas = {
    input: inlineRefs(raw.input) as JsonSchema,
    output: inlineRefs(raw.output) as JsonSchema,
  };
  cache.set(name, schemas);
  return schemas;
}

/** Every operation that has a schema file. */
export function schemaNames(): string[] {
  return readdirSync(SCHEMA_DIR)
    .filter((file) => file.endsWith(".json") && !file.startsWith("_"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}
