/**
 * Canonicalise a posting URL so tracking parameters do not defeat dedupe.
 *
 * Port of tools/url_canon.py. Alert links carry per-email tracking
 * parameters (`utm_*`, LinkedIn's `trk`/`trkEmail`, Indeed's `tk`/`from`),
 * so the same posting can arrive under several URLs. `canonicalizeUrl`
 * lowercases the scheme and host, drops the fragment and a trailing slash,
 * and drops known tracking parameters while keeping the ones that identify
 * the posting (LinkedIn's `currentJobId`, Indeed's `jk`). It is pure and
 * never throws on a malformed URL; callers that need a validity check do it
 * themselves.
 *
 * The splitting and query encoding follow Python's urllib (urlsplit,
 * parse_qsl, urlencode) rather than the WHATWG URL parser, so the two
 * implementations produce the same string for the same input.
 */

const GENERIC_TRACKING_PARAMS = new Set([
  "trk", "refid", "trackingid", "gclid", "fbclid", "msclkid", "mc_cid", "mc_eid",
]);

const PORTAL_TRACKING_PARAMS: Record<string, Set<string>> = {
  "linkedin.com": new Set(["trkemail", "trkinfo", "midtoken", "midsig", "lici", "eid", "originalsubdomain"]),
  "indeed.com": new Set(["tk", "from", "alid", "rgtk", "advn", "indpubnid", "atk", "cmp"]),
};

const IDENTIFYING_PARAMS: Record<string, Set<string>> = {
  "linkedin.com": new Set(["currentjobid"]),
  "indeed.com": new Set(["jk"]),
};

// urllib.parse.uses_netloc: schemes whose URLs carry a "//" authority.
const USES_NETLOC = new Set([
  "", "ftp", "http", "gopher", "nntp", "telnet", "imap", "wais", "file", "mms", "https", "shttp",
  "snews", "prospero", "rtsp", "rtsps", "rtspu", "rsync", "svn", "svn+ssh", "sftp", "nfs", "git",
  "git+ssh", "ws", "wss", "itms-services",
]);

export interface SplitUrl {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
}

/** urllib.parse.urlsplit for already-stripped input. */
export function urlsplit(raw: string): SplitUrl {
  let url = raw.replace(/[\t\r\n]/g, "");
  let scheme = "";
  let netloc = "";
  let query = "";
  let fragment = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z][A-Za-z0-9+\-.]*$/.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  if (url.startsWith("//")) {
    const rest = url.slice(2);
    const end = rest.search(/[/?#]/);
    netloc = end === -1 ? rest : rest.slice(0, end);
    url = end === -1 ? "" : rest.slice(end);
  }
  const hash = url.indexOf("#");
  if (hash !== -1) {
    fragment = url.slice(hash + 1);
    url = url.slice(0, hash);
  }
  const question = url.indexOf("?");
  if (question !== -1) {
    query = url.slice(question + 1);
    url = url.slice(0, question);
  }
  return { scheme, netloc, path: url, query, fragment };
}

function unquotePlus(text: string): string {
  const spaced = text.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    // Python's unquote leaves an invalid escape as it is; decode what can be.
    return spaced.replace(/(%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

/** urllib.parse.parse_qsl(query, keep_blank_values=True). */
export function parseQsl(query: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = eq === -1 ? part : part.slice(0, eq);
    const value = eq === -1 ? "" : part.slice(eq + 1);
    pairs.push([unquotePlus(key), unquotePlus(value)]);
  }
  return pairs;
}

function quotePlus(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.\-~]/.test(ch)) out += ch;
    else if (byte === 0x20) out += "+";
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** urllib.parse.urlencode over a list of pairs. */
export function urlencode(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join("&");
}

/** urllib.parse.urlunsplit. */
export function urlunsplit(parts: SplitUrl): string {
  let url = parts.path;
  if (parts.netloc || (parts.scheme && USES_NETLOC.has(parts.scheme) && !url.startsWith("//"))) {
    if (url && !url.startsWith("/")) url = `/${url}`;
    url = `//${parts.netloc}${url}`;
  }
  if (parts.scheme) url = `${parts.scheme}:${url}`;
  if (parts.query) url = `${url}?${parts.query}`;
  if (parts.fragment) url = `${url}#${parts.fragment}`;
  return url;
}

function portalFor(host: string): string | null {
  for (const domain of Object.keys(PORTAL_TRACKING_PARAMS)) {
    if (host === domain || host.endsWith(`.${domain}`)) return domain;
  }
  return null;
}

function dropParam(key: string, host: string): boolean {
  const lowered = key.toLowerCase();
  if (lowered.startsWith("utm_")) return true;
  if (GENERIC_TRACKING_PARAMS.has(lowered)) return true;
  const portal = portalFor(host);
  if (portal === null) return false;
  if (IDENTIFYING_PARAMS[portal]?.has(lowered)) return false;
  return PORTAL_TRACKING_PARAMS[portal]?.has(lowered) ?? false;
}

/** The posting's identity: lowercase scheme/host, no fragment, no tracking params. */
export function canonicalizeUrl(url: string | null | undefined): string {
  const parsed = urlsplit((url ?? "").trim());
  const host = parsed.netloc.toLowerCase();
  const path = parsed.path.replace(/\/+$/, "");
  const kept = parseQsl(parsed.query).filter(([k]) => !dropParam(k, host));
  return urlunsplit({ scheme: parsed.scheme.toLowerCase(), netloc: host, path, query: urlencode(kept), fragment: "" });
}
