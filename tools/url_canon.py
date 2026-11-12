#!/usr/bin/env python3
"""Canonicalise a posting URL so tracking parameters do not defeat dedupe.

`alert_state.py` and `job_key.py` both treat a posting's URL as its identity
(the raw URL, trailing "/" stripped). Alert links carry per-email tracking
parameters - `utm_*`, LinkedIn's `trk`/`trkEmail`, Indeed's `tk`/`from` - so
the same posting can arrive under several distinct "identities" and dodge
dedupe until company+title catches it at `store`, wasting a fetch and a
portal rate-limit slot each time.

`canonicalize_url` lowercases the scheme and host, drops the fragment and a
trailing slash, and drops known tracking parameters while keeping the ones
that actually identify the posting (LinkedIn's `currentJobId`, Indeed's
`jk`). It is pure and never raises on a malformed URL - callers that need a
validity check (a scheme, a host) still do that themselves.

This does not change what a canonical `seen_jobs.json` key looks like
(`job_key.make_key` is untouched); it only changes what two postings compare
equal *as URLs*, so callers apply it on both sides of a comparison - an
already-stored raw URL canonicalises the same way a fresh one does, so no
migration of existing state is needed.
"""

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Dropped regardless of host. "utm_*" is matched by prefix below.
_GENERIC_TRACKING_PARAMS = {
    "trk", "refid", "trackingid", "gclid", "fbclid", "msclkid", "mc_cid", "mc_eid",
}

# Per-portal tracking params to drop, keyed by the registered `source` values
# in `alert_state.SOURCES`. Only hosts with known extra noise need an entry.
_PORTAL_TRACKING_PARAMS = {
    "linkedin.com": {"trkemail", "trkinfo", "midtoken", "midsig", "lici", "eid", "originalsubdomain"},
    "indeed.com": {"tk", "from", "alid", "rgtk", "advn", "indpubnid", "atk", "cmp"},
}

# Params that identify the posting itself: never dropped even though they sit
# alongside tracking params on the same host.
_IDENTIFYING_PARAMS = {
    "linkedin.com": {"currentjobid"},
    "indeed.com": {"jk"},
}


def _portal_for(host: str) -> str | None:
    for domain in _PORTAL_TRACKING_PARAMS:
        if host == domain or host.endswith("." + domain):
            return domain
    return None


def _drop_param(key: str, host: str) -> bool:
    lowered = key.lower()
    if lowered.startswith("utm_"):
        return True
    if lowered in _GENERIC_TRACKING_PARAMS:
        return True
    portal = _portal_for(host)
    if portal is None:
        return False
    if lowered in _IDENTIFYING_PARAMS.get(portal, ()):
        return False
    return lowered in _PORTAL_TRACKING_PARAMS[portal]


def canonicalize_url(url: str) -> str:
    """The posting's identity: lowercase scheme/host, no fragment, no tracking params."""
    parsed = urlsplit((url or "").strip())
    host = parsed.netloc.lower()
    path = parsed.path.rstrip("/")
    kept = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if not _drop_param(k, host)]
    return urlunsplit((parsed.scheme.lower(), host, path, urlencode(kept), ""))
