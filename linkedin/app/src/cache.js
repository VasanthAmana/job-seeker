"use strict";
// A per-session result cache. Results live only in the app's memory for the
// life of the process: nothing is written to disk, and a restart is a fresh
// session. A cache hit costs no page load, so repeating a query inside the
// TTL is free against the pace budget.

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

class SessionCache {
  constructor({ ttlMs = 600_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }

  static key(tool, args) {
    return tool + " " + stableStringify(args || {});
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  get size() {
    return this.map.size;
  }

  clear() {
    this.map.clear();
  }
}

module.exports = { SessionCache, stableStringify };
