import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const extractors = require("../src/extractors.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadFixture(name, url = "https://www.linkedin.com/") {
  const html = readFileSync(path.join(HERE, "fixtures", name), "utf8");
  return new JSDOM(html, { url, runScripts: "outside-only" });
}

// Runs an extractor's source inside the jsdom window, the same way main.js
// runs it inside the live page - identical code path on both sides. The
// result crosses a JSON boundary, as Electron's executeJavaScript structured
// clone also produces plain objects in the calling realm (and deepStrictEqual
// refuses cross-realm prototypes). Async to support promise-returning guests.
export async function evalInWindow(dom, fn, arg) {
  const result = await dom.window.eval(extractors.callSource(fn, arg));
  if (result === undefined || result === null) return result;
  return JSON.parse(JSON.stringify(result));
}

export { extractors };
