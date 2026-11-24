/**
 * Spec for core/dedupe, translated from tests/test_url_canon.py (9),
 * tests/test_job_key_audit.py (2) and the key case in
 * tests/test_tools_integrity.py (execution plan section 4.3).
 */
import { describe, expect, it } from "vitest";

import { auditSeen, isCanonical, makeKey } from "./jobKey.js";
import { canonicalizeUrl } from "./urlCanon.js";

describe("url canonicalisation (test_url_canon)", () => {
  it("lowercases scheme and host", () => {
    expect(canonicalizeUrl("HTTPS://Example.COM/Jobs/1")).toBe("https://example.com/Jobs/1");
  });

  it("drops fragment and trailing slash", () => {
    expect(canonicalizeUrl("https://example.com/jobs/1/#apply")).toBe("https://example.com/jobs/1");
  });

  it("drops utm and generic tracking params", () => {
    const url = "https://example.com/jobs/1?utm_source=linkedin&utm_campaign=x&trk=abc&refId=9";
    expect(canonicalizeUrl(url)).toBe("https://example.com/jobs/1");
  });

  it("two linkedin links with different tracking canonicalise equal", () => {
    const a = "https://www.linkedin.com/jobs/view/123?currentJobId=123&trk=flagship3_search&trkEmail=abc";
    const b = "https://www.linkedin.com/jobs/view/123?trk=nav_responsive&midToken=xyz&currentJobId=123";
    expect(canonicalizeUrl(a)).toBe(canonicalizeUrl(b));
  });

  it("linkedin currentJobId is kept", () => {
    expect(canonicalizeUrl("https://www.linkedin.com/jobs/view/123?currentJobId=123")).toContain("currentJobId=123");
  });

  it("indeed jk is kept but tk and from are dropped", () => {
    const url = "https://www.indeed.com/viewjob?jk=abc123&tk=xyz&from=serp&cmp=co";
    expect(canonicalizeUrl(url)).toBe("https://www.indeed.com/viewjob?jk=abc123");
  });

  it("two indeed links with different tracking canonicalise equal", () => {
    const a = "https://www.indeed.com/viewjob?jk=abc123&tk=one&from=serp";
    const b = "https://www.indeed.com/viewjob?jk=abc123&tk=two&from=email&alid=9";
    expect(canonicalizeUrl(a)).toBe(canonicalizeUrl(b));
  });

  it("non-tracking query params are kept", () => {
    expect(canonicalizeUrl("https://example.com/jobs/1?lang=en")).toBe("https://example.com/jobs/1?lang=en");
  });

  it("empty url does not throw", () => {
    expect(canonicalizeUrl("")).toBe("");
  });
});

describe("job key audit (test_job_key_audit)", () => {
  it("catches duplicate urls that differ only by tracking params", () => {
    const seen = {
      "acme_director-ai-strategy": {
        company: "Acme",
        title: "Director, AI Strategy",
        url: "https://www.linkedin.com/jobs/view/123?currentJobId=123&trk=flagship3_search",
      },
      "acme_director-ai-strategy-2": {
        company: "Acme",
        title: "Director, AI Strategy",
        url: "https://www.linkedin.com/jobs/view/123?currentJobId=123&trk=nav_responsive",
      },
    };
    const { ok, report } = auditSeen({ seen });
    expect(ok).toBe(false);
    expect(Object.keys(report.duplicate_urls)).toHaveLength(1);
  });

  it("does not flag distinct postings", () => {
    const seen = {
      "acme_director-ai-strategy": {
        company: "Acme",
        title: "Director, AI Strategy",
        url: "https://www.linkedin.com/jobs/view/123?currentJobId=123",
      },
      "beta_vp-transformation": {
        company: "Beta",
        title: "VP Transformation",
        url: "https://www.linkedin.com/jobs/view/456?currentJobId=456",
      },
    };
    const { ok, report } = auditSeen({ seen });
    expect(ok).toBe(true);
    expect(report.duplicate_urls).toEqual({});
  });
});

describe("job key (test_tools_integrity)", () => {
  it("is stable and path safe", () => {
    const key = makeKey("Acme Corp, Inc.", "Director, AI Strategy (Denver/Remote)", "https://a.example/1");
    expect(isCanonical(key)).toBe(true);
    expect(key).not.toContain("/");
    expect(key).not.toContain(",");
    expect(key).toBe(makeKey("Acme Corp, Inc.", "Director, AI Strategy (Denver/Remote)", "https://a.example/1"));
    // Truncation is disambiguated: two long titles never collide.
    const a = makeKey("Acme", `Director ${"x".repeat(100)} A`, "https://a.example/1");
    const b = makeKey("Acme", `Director ${"x".repeat(100)}y`, "https://a.example/2");
    expect(a).not.toBe(b);
  });
});
