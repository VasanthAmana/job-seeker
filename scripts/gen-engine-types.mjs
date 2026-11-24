#!/usr/bin/env node
/**
 * Generate src/engine/types.gen.ts from the Engine API v1 JSON Schemas
 * (design 3.1: the same schemas generate the TypeScript types).
 *
 *   npm run gen:types          write the file
 *   npm run gen:types -- --check   exit 1 when the file is out of date
 *
 * It inlines references into _common.json the same way src/engine/schemas.ts
 * does, so the types match what the engine validates and MCP clients see.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compile } from "json-schema-to-typescript";

const OUT = fileURLToPath(new URL("../src/engine/types.gen.ts", import.meta.url));
const SCHEMA_DIR = fileURLToPath(new URL("../schemas/engine/v1/", import.meta.url));

const readJson = (file) => JSON.parse(readFileSync(`${SCHEMA_DIR}${file}`, "utf8"));

function inline(node, defs, inCommon = false) {
  if (Array.isArray(node)) return node.map((item) => inline(item, defs, inCommon));
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string") {
    let name = null;
    if (node.$ref.startsWith("_common.json#/$defs/")) name = node.$ref.slice("_common.json#/$defs/".length);
    else if (inCommon && node.$ref.startsWith("#/$defs/")) name = node.$ref.slice("#/$defs/".length);
    if (name !== null) {
      if (!defs[name]) throw new Error(`unknown schema definition: ${node.$ref}`);
      const { $ref: _ref, ...rest } = node;
      const inlined = inline(structuredClone(defs[name]), defs, true);
      return Object.keys(rest).length ? { ...inlined, ...inline(rest, defs, inCommon) } : inlined;
    }
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) out[key] = inline(value, defs, inCommon);
  return out;
}

function pascal(name) {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Drop schema titles and ids (not properties named "title") so nested definitions stay inline. */
function strip(node, inProperties = false) {
  if (Array.isArray(node)) return node.map((item) => strip(item));
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (!inProperties && (key === "title" || key === "$id")) continue;
    out[key] = strip(value, !inProperties && key === "properties");
  }
  return out;
}

export async function generate() {
  const defs = readJson("_common.json").$defs ?? {};
  const names = readdirSync(SCHEMA_DIR)
    .filter((file) => file.endsWith(".json") && !file.startsWith("_"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
  const options = { bannerComment: "", additionalProperties: false, format: false, unknownAny: true, strictIndexSignatures: false };
  const parts = [
    "/* eslint-disable */",
    "/**",
    " * Generated from schemas/engine/v1 by scripts/gen-engine-types.mjs.",
    " * Do not edit by hand: change the schema and run `npm run gen:types`.",
    " */",
    "",
  ];
  for (const name of names) {
    const raw = readJson(`${name}.json`);
    const input = inline(raw.input, defs);
    const output = inline(raw.output, defs);
    const base = pascal(name);
    parts.push(await compile(strip(input), `${base}Input`, options));
    parts.push(await compile(strip(output), `${base}Output`, options));
  }
  return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = await generate();
  if (process.argv.includes("--check")) {
    const current = readFileSync(OUT, "utf8");
    if (current !== text) {
      process.stderr.write("src/engine/types.gen.ts is out of date: run npm run gen:types\n");
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, text);
  }
}
