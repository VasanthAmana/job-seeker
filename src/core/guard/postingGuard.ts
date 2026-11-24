/**
 * Integrity gate for a fetched job posting: clean it, scan it, say what was
 * found. Port of tools/posting_guard.py (design 6.5 rule 4: text from
 * services passes posting_guard at ingest).
 *
 * - Hidden HTML (display:none, visibility:hidden, opacity:0, font-size:0,
 *   color:transparent, clip/clip-path, off-screen positioning, a collapsed
 *   box with overflow:hidden, the `hidden` attribute, aria-hidden) is
 *   removed from the text; its content is scanned and reported as excerpts.
 *   Comments and script/style/noscript/svg/template blocks are removed and
 *   scanned too, but not listed.
 * - Invisible characters are removed and counted; the ones that indicate
 *   tampering are flagged. Unicode tag characters and variation-selector
 *   runs are decoded into `invisible_text`.
 * - Instruction-shaped lines aimed at an agent are quoted, never removed.
 * - URLs that only exist in hidden content are listed.
 * - Words mixing Latin with Cyrillic or Greek letters are listed.
 *
 * It advises; it never blocks. Regular expressions follow Python's Unicode
 * semantics: `\w` and `\b` are spelled out with Unicode classes because a
 * JavaScript `\b` is ASCII-only even with the `u` flag.
 */
import { decodeHTML } from "entities";

export const EXCERPT = 120;
export const LINE_MAX = 200;

const ZERO_WIDTH = "\u200b\u200c\u200d\u2060\u2061\u2062\u2063\u2064";
const BIDI = "\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
const BIDI_TAMPER = "\u202d\u202e\u2066\u2067\u2068\u2069";
const FORMAT = "\u00ad\u2028\u2029";
const BOM = "\ufeff";

const TAG_RUN = /[\u{E0000}-\u{E007F}]+/gu;
const RGI_TAG_FLAG =
  /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}/gu;
const VARIATION = /[\ufe00-\ufe0f\u{E0100}-\u{E01EF}]/gu;
const VARIATION_RUN = /[\ufe00-\ufe0f\u{E0100}-\u{E01EF}]{2,}/gu;

/** Python's Unicode word character. */
const W = "[\\p{L}\\p{N}_]";
/** Python's Unicode word boundary. */
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const D = "\\p{Nd}";

function py(source: string, flags = ""): RegExp {
  return new RegExp(source.replace(/\\b/g, B).replace(/\\d/g, D), `u${flags}`);
}

const HIDDEN_STYLE = py(
  "display\\s*:\\s*none" +
    "|visibility\\s*:\\s*hidden" +
    "|opacity\\s*:\\s*0(?![.\\d]*[1-9])" +
    "|font-size\\s*:\\s*0(?:\\.0+)?(?:px|pt|em|rem|%)?(?![\\d.])" +
    "|color\\s*:\\s*transparent" +
    "|clip\\s*:\\s*rect\\(\\s*0" +
    "|clip-path\\s*:\\s*inset\\(\\s*100%" +
    "|(?:left|top|text-indent)\\s*:\\s*-\\d{4,}px",
  "i",
);
const PRESTRIP = /<!DOCTYPE[^>]*>|<\?[^>]*\?>/giu;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/gu;
const DROP_BLOCKS = py("<(script|style|noscript|svg|template)\\b[^>]*>[\\s\\S]*?(?:</\\1\\s*>|$)", "gi");
const TAG = /<(\/?)([a-zA-Z][\p{L}\p{N}_:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gu;
const ATTR = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/gu;
const VOID = new Set(["br", "img", "input", "meta", "link", "hr", "wbr", "source", "area", "base", "col", "embed", "param", "track"]);
const BLOCK = new Set([
  "p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "br", "section", "article",
  "header", "footer", "table", "thead", "tbody", "blockquote", "pre", "dd", "dt", "dl", "nav", "main",
  "aside", "figure", "form", "fieldset", "legend", "address", "hr", "td", "th", "option",
]);
const IMPLIED_END = new Set(["p", "li", "dd", "dt", "tr", "td", "th", "option"]);
const CLOSES_P = new Set([...BLOCK].filter((name) => name !== "br"));
const HTML_HINT = py("<\\s*(html|body|div|p)\\b", "i");

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gu;
const INSTRUCTION_PATTERNS: RegExp[] = [
  "\\bignore (all|any|the|previous|prior|above|earlier)\\b",
  "\\b(disregard|forget)( all| any| the| your| my)? (previous|prior|above|earlier|preceding|initial|original|system) (instructions?|prompts?)\\b",
  `\\byou are (?:an?|the) (?:ai(?![\\p{L}\\p{N}_-])|ai (?:assistant|agent|model|language model)|assistant|llm|language model)\\b`,
  "\\bsystem prompt\\b",
  "\\b(do not|don['\u2019]?t|never) (tell|inform) the user\\b(?!['\u2019]s)",
  "\\b(do not|don['\u2019]?t|never) (mention|reveal|disclose) (this|these|that|it|any of this|the (above|following|previous))\\b[^.\\n]{0,30}\\bto the user\\b",
  "\\b(run|execute) the following (command|commands|script|code|shell|instruction|instructions|steps)\\b",
  `\\bas an ai(?![\\p{L}\\p{N}_-])(?![\\s/&]+(?:[\\p{L}\\p{N}_&/-]+\\s+){0,3}?(?:engineer|developer|researcher|scientist|architect|specialist|lead|consultant|manager|analyst|intern|trainer|expert|strategist|designer|tester|owner|programmer)s?\\b)`,
  "^\\s*(assistant|system|user)\\s*:",
  "<\\|",
  "\\[INST\\]",
  "###\\s*(system|instruction)",
  "\\b(curl|wget|ssh|scp)\\b",
  "\\.env\\b",
  "settings\\.json",
  "allowed-tools",
  "\\btool_use\\b|\\bfunction_call\\b",
].map((source) => py(source, "i"));
const WORD = /[\p{L}\p{N}_]+/gu;
const LATIN = /[A-Za-z]/u;
const CONFUSABLE = /[\u0400-\u04ff\u0370-\u03ff]/u;

const CSS_COMMENT = /\/\*[\s\S]*?\*\//gu;
const COLLAPSED_BOX = py("\\b(?:max-)?(?:height|width)\\s*:\\s*0(?:\\.0+)?(?:px|em|rem|%|pt)?(?![\\d.])", "i");
const CLIPPED = py("\\boverflow(?:-[xy])?\\s*:\\s*hidden\\b", "i");

export interface GuardFindings {
  hidden_blocks: string[];
  invisible_chars: Record<string, number>;
  invisible_flagged: number;
  invisible_text: string[];
  instruction_like: string[];
  hidden_urls: string[];
  visible_url_count: number;
  homoglyph_runs: string[];
  verdict: string;
}

export type GuardMode = "html" | "text" | "auto";

function isAlpha(ch: string): boolean {
  return ch !== "" && /^\p{L}$/u.test(ch);
}

function isPrintable(ch: string): boolean {
  return ch === " " || !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u.test(ch);
}

/** Code-point slice, like Python's str slicing. */
function cpSlice(text: string, start: number, end?: number): string {
  return Array.from(text).slice(start, end).join("");
}

function cpLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** Python's str.splitlines(). */
export function splitlines(text: string): string[] {
  if (!text) return [];
  // Python's line boundaries include the C0 separators \x1c-\x1e.
  // eslint-disable-next-line no-control-regex
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u);
  // eslint-disable-next-line no-control-regex
  if (lines.length > 0 && lines[lines.length - 1] === "" && /(?:\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029])$/u.test(text)) {
    lines.pop();
  }
  return lines;
}

/** Python's str.strip(). */
function pyStrip(text: string): string {
  // eslint-disable-next-line no-control-regex -- Python's str.isspace() includes \x1c-\x1f
  return text.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/gu, "");
}

export function fold(text: string): string {
  let out = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  out = out.replace(/[ \t\xa0\f\v]+/g, " ");
  out = out.replace(/ *\n */g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  return pyStrip(out);
}

function countChars(text: string, chars: string): number {
  let n = 0;
  for (const ch of text) if (chars.includes(ch)) n++;
  return n;
}

function stripInvisible(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (ZERO_WIDTH.includes(ch) || BIDI.includes(ch) || FORMAT.includes(ch) || ch === BOM) continue;
    if (cp >= 0xe0000 && cp <= 0xe007f) continue;
    out += ch;
  }
  return out;
}

interface TextFindings {
  invisible_chars: Record<string, number>;
  invisible_flagged: number;
  invisible_text: string[];
}

/** Remove invisible characters; count, flag and decode them. */
export function cleanText(input: string): [string, TextFindings] {
  let text = input;
  const counts: Record<string, number> = {};
  let flagged = 0;
  for (const [key, chars] of [
    ["zero_width", ZERO_WIDTH],
    ["bidi", BIDI],
    ["format", FORMAT],
    ["bom", BOM],
  ] as const) {
    const n = countChars(text, chars);
    if (n) counts[key] = n;
  }
  const hasFlags = text.match(RGI_TAG_FLAG) !== null;
  const unflagged = text.replace(RGI_TAG_FLAG, "");
  let tags = 0;
  for (const ch of unflagged) {
    const cp = ch.codePointAt(0) as number;
    if (cp >= 0xe0000 && cp <= 0xe007f) tags++;
  }
  if (tags) counts.tag = tags;
  const variation = (text.match(VARIATION) ?? []).length;
  if (variation) counts.variation = variation;
  const chars = Array.from(text);
  chars.forEach((ch, i) => {
    if (BIDI_TAMPER.includes(ch)) {
      flagged++;
    } else if (ZERO_WIDTH.includes(ch) || ch === BOM) {
      const before = i ? (chars[i - 1] as string) : "";
      const after = i + 1 < chars.length ? (chars[i + 1] as string) : "";
      if (isAlpha(before) && isAlpha(after)) flagged++;
    }
  });
  const invisibleText: string[] = [];
  for (const run of unflagged.match(TAG_RUN) ?? []) {
    let decoded = "";
    for (const ch of run) {
      const code = (ch.codePointAt(0) as number) - 0xe0000;
      if (code >= 0x20 && code < 0x7f) decoded += String.fromCharCode(code);
    }
    decoded = pyStrip(decoded);
    if (decoded) invisibleText.push(cpSlice(decoded, 0, LINE_MAX));
  }
  for (const run of text.match(VARIATION_RUN) ?? []) {
    const bytes = Array.from(run).map((ch) => {
      const cp = ch.codePointAt(0) as number;
      return cp <= 0xfe0f ? cp - 0xfe00 : cp - 0xe0100 + 16;
    });
    const decodedRaw = new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
    const decoded = pyStrip(Array.from(decodedRaw).filter(isPrintable).join(""));
    if (decoded) invisibleText.push(cpSlice(decoded, 0, LINE_MAX));
  }
  text = text.replace(VARIATION, "");
  if (hasFlags) {
    const pieces: string[] = [];
    let last = 0;
    for (const match of text.matchAll(RGI_TAG_FLAG)) {
      const start = match.index as number;
      pieces.push(stripInvisible(text.slice(last, start)));
      pieces.push(match[0]);
      last = start + match[0].length;
    }
    pieces.push(stripInvisible(text.slice(last)));
    text = pieces.join("");
  } else {
    text = stripInvisible(text);
  }
  return [fold(text), { invisible_chars: counts, invisible_flagged: flagged, invisible_text: invisibleText }];
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) {
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : (m[4] ?? "");
    out[(m[1] as string).toLowerCase()] = value;
  }
  return out;
}

function style(parsed: Record<string, string>): string {
  return decodeHTML(parsed.style ?? "").replace(CSS_COMMENT, "");
}

function isHidden(rawAttrs: string): boolean {
  const parsed = attrs(rawAttrs);
  if ("hidden" in parsed || pyStrip(parsed["aria-hidden"] ?? "").toLowerCase() === "true") return true;
  const css = style(parsed);
  if (HIDDEN_STYLE.test(css)) return true;
  return COLLAPSED_BOX.test(css) && CLIPPED.test(css);
}

/** Visible text and the hidden content that was removed. */
export function cleanHtml(input: string): [string, { hidden_blocks: string[]; hidden_text: string }] {
  const hiddenParts: string[] = [];
  const hiddenBlocks: string[] = [];

  const collect = (matched: string): string => {
    let inner = matched.replace(/<!--|-->/g, " ");
    inner = inner.replace(/<[^>]+>/g, " ");
    hiddenParts.push(decodeHTML(inner));
    return " ";
  };

  let markup = input.replace(PRESTRIP, " ");
  markup = markup.replace(COMMENT, collect);
  markup = markup.replace(DROP_BLOCKS, collect);

  const visible: string[] = [];
  const hiddenBuf: string[] = [];
  const stack: string[] = [];
  let hiddenAt: number | null = null;
  let pos = 0;

  const emit = (text: string) => {
    (hiddenAt === null ? visible : hiddenBuf).push(text);
  };
  const flushHidden = () => {
    const block = fold(decodeHTML(hiddenBuf.join("")));
    hiddenBuf.length = 0;
    hiddenAt = null;
    if (block) {
      hiddenBlocks.push(cpSlice(cleanText(block)[0], 0, EXCERPT));
      hiddenParts.push(block);
    }
  };
  const popTo = (index: number) => {
    stack.splice(index);
    if (hiddenAt !== null && hiddenAt >= stack.length) flushHidden();
  };
  const lastIndex = (name: string): number | null => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i] === name) return i;
    return null;
  };

  for (const m of markup.matchAll(TAG)) {
    const start = m.index as number;
    emit(markup.slice(pos, start));
    pos = start + m[0].length;
    const closing = m[1];
    const name = (m[2] as string).toLowerCase();
    const rawAttrs = m[3] as string;
    if (BLOCK.has(name)) emit("\n");
    if (closing) {
      const index = lastIndex(name);
      if (index !== null) popTo(index);
      continue;
    }
    if (VOID.has(name)) continue;
    if (IMPLIED_END.has(name) && stack.length && stack[stack.length - 1] === name) {
      popTo(stack.length - 1);
    } else if (CLOSES_P.has(name) && stack.length && stack[stack.length - 1] === "p") {
      popTo(stack.length - 1);
    }
    stack.push(name);
    if (hiddenAt === null && isHidden(rawAttrs)) hiddenAt = stack.length - 1;
  }
  emit(markup.slice(pos));
  if (hiddenAt !== null) flushHidden();

  const text = decodeHTML(visible.join(""));
  return [fold(text), { hidden_blocks: hiddenBlocks, hidden_text: hiddenParts.join("\n") }];
}

function excerpt(line: string, at: number): string {
  const chars = Array.from(line);
  if (chars.length <= LINE_MAX) return line;
  const lead = Math.floor(LINE_MAX / 3);
  let start = Math.max(0, at - lead);
  const end = Math.min(chars.length, start + LINE_MAX);
  start = Math.max(0, end - LINE_MAX);
  const head = start ? "\u2026" : "";
  const tail = end < chars.length ? "\u2026" : "";
  return `${head}${chars.slice(start, end).join("")}${tail}`;
}

/** Instruction-shaped lines, hidden URLs, visible URL count, mixed-script words. */
export function scan(visible: string, hidden: string) {
  const seen = new Set<string>();
  const instructionLike: string[] = [];
  for (const line of [...splitlines(visible), ...splitlines(hidden)]) {
    const stripped = pyStrip(line);
    if (!stripped || seen.has(stripped)) continue;
    let matchAt: number | null = null;
    for (const pattern of INSTRUCTION_PATTERNS) {
      const m = pattern.exec(stripped);
      if (m) {
        matchAt = cpLength(stripped.slice(0, m.index));
        break;
      }
    }
    if (matchAt !== null) {
      seen.add(stripped);
      instructionLike.push(excerpt(stripped, matchAt));
    }
  }
  const hiddenUrls: string[] = [];
  for (const url of hidden.match(URL_RE) ?? []) if (!hiddenUrls.includes(url)) hiddenUrls.push(url);
  const homoglyphs: string[] = [];
  for (const word of `${visible}\n${hidden}`.match(WORD) ?? []) {
    if (LATIN.test(word) && CONFUSABLE.test(word) && !homoglyphs.includes(word)) homoglyphs.push(word);
  }
  return {
    instruction_like: instructionLike,
    hidden_urls: hiddenUrls,
    visible_url_count: (visible.match(URL_RE) ?? []).length,
    homoglyph_runs: homoglyphs,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function verdict(findings: Omit<GuardFindings, "verdict">): string {
  const alarms: string[] = [];
  let n = findings.instruction_like.length;
  if (n) alarms.push(plural(n, "instruction-like line", "instruction-like lines"));
  n = findings.invisible_flagged;
  if (n) alarms.push(plural(n, "invisible character inside words", "invisible characters inside words"));
  n = findings.invisible_chars.tag ?? 0;
  if (n) alarms.push(plural(n, "tag character (text hidden from the reader)", "tag characters (text hidden from the reader)"));
  n = findings.invisible_text.length;
  if (n) alarms.push(plural(n, "string spelled in invisible characters", "strings spelled in invisible characters"));
  n = findings.homoglyph_runs.length;
  if (n) alarms.push(plural(n, "mixed-script word", "mixed-script words"));

  const context: string[] = [];
  n = findings.hidden_blocks.length;
  if (n) context.push(plural(n, "hidden block", "hidden blocks"));
  n = findings.hidden_urls.length;
  if (n) context.push(plural(n, "hidden URL", "hidden URLs"));
  const removed = context.join(" and ");

  if (alarms.length) {
    const line = `posting_guard: \u26a0 ${alarms.join(", ")} - review before continuing`;
    return removed ? `${line} (${removed} removed)` : line;
  }
  if (removed) return `posting_guard: clean (${removed} removed, none instruction-like)`;
  return "posting_guard: clean";
}

/** Run the whole gate. Returns the cleaned text and the findings. */
export function guard(raw: string, mode: GuardMode = "auto"): { text: string; findings: GuardFindings } {
  let resolved = mode;
  if (resolved === "auto") resolved = HTML_HINT.test(raw) ? "html" : "text";
  let visibleText: string;
  let hiddenText: string;
  let hiddenBlocks: string[];
  if (resolved === "html") {
    const [text, hf] = cleanHtml(raw);
    visibleText = text;
    hiddenText = hf.hidden_text;
    hiddenBlocks = hf.hidden_blocks;
  } else {
    visibleText = raw;
    hiddenText = "";
    hiddenBlocks = [];
  }
  const [text, tf] = cleanText(visibleText);
  const [cleanedHidden, hiddenTf] = cleanText(hiddenText);
  for (const [key, n] of Object.entries(hiddenTf.invisible_chars)) {
    tf.invisible_chars[key] = (tf.invisible_chars[key] ?? 0) + n;
  }
  tf.invisible_flagged += hiddenTf.invisible_flagged;
  tf.invisible_text.push(...hiddenTf.invisible_text);
  const scannedHidden = [cleanedHidden, ...tf.invisible_text].join("\n");
  const partial = { hidden_blocks: hiddenBlocks, ...tf, ...scan(text, scannedHidden) };
  return { text, findings: { ...partial, verdict: verdict(partial) } };
}

/** True when the verdict carries the \u26a0 marker (signals that indicate targeting). */
export function isAlarming(findings: Pick<GuardFindings, "verdict">): boolean {
  return findings.verdict.includes("\u26a0");
}
