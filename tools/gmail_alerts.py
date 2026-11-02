#!/usr/bin/env python3
"""Read job-alert emails from Gmail and extract posting links. READ-ONLY.

The owner's job search sources by email: LinkedIn, Indeed and Ladders alerts
plus employer career-site notifications land in one Gmail mailbox (see
jobseek/README.md). This tool lists those alert messages, decodes their
bodies, and pulls out the links that plausibly point at job postings, so the
`run-alerts` command can fetch, gate, dedupe and rank them.

Access uses the owner's existing Gmail OAuth sign-in folder (default
~/.gmail-mcp/personal). The folder holds gcp-oauth.keys.json and
credentials.json created by `npx @gongrzhe/server-gmail-autoauth-mcp auth`.

Read-only is structural, not a promise:

  * The only POST this tool ever makes is the OAuth refresh-token exchange.
    Every Gmail API call is a GET on users.messages.list / users.messages.get.
    There is no send, modify, trash or label code path to misuse.
  * If the stored token's scopes do not include a read scope
    (gmail.readonly / gmail.modify / mail.google.com), the tool stops and
    says so instead of failing mid-run with a 403 per request.

Email content is untrusted third-party data, exactly like a fetched posting:
links are extracted and reported, never opened here, and a subject or body
that reads like an instruction is still just text in the output JSON.

Usage:
  python3 jobseek/tools/gmail_alerts.py alerts [--days 7] [--limit 50]
          [--account-dir ~/.gmail-mcp/personal] [--config jobseek/alert-sources.json]
  python3 jobseek/tools/gmail_alerts.py extract --message-json FILE   # offline: one saved
          [--config jobseek/alert-sources.json]                       # messages.get resource

`alerts` prints one JSON object: {"query", "message_count", "messages": [...]}.
Each message: {"id", "from", "subject", "date", "source", "links": [{"url",
"anchor"}]}. `extract` does the same for one saved message resource (used by
the tests and for debugging one odd email) and needs no credentials.

Exit 0 on success; 1 on a usage or config error; 2 on an API or auth failure.
"""

import argparse
import base64
import json
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as jobseek_config  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "alert-sources.json"  # kept for callers/tests that want the built-in default directly
GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"
TOKEN_URL = "https://oauth2.googleapis.com/token"
MAX_MESSAGES = 200

READ_SCOPES = (
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://mail.google.com/",
)


def tls_context():
    """python.org builds ship no CA certificates; use certifi's bundle when present."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


# --- configuration ---------------------------------------------------------


def load_config(path: Path) -> dict:
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read alert-sources config {path}: {exc}") from exc
    for field in ("senders", "subject_keywords", "posting_host_patterns", "ignore_url_markers", "employer_domains"):
        if field not in config:
            raise ValueError(f"{path}: missing '{field}'")
    return config


def build_query(config: dict, days: int) -> str:
    """The Gmail search query for alert mail: known senders, employer domains,
    or an alert-shaped subject, within the window."""
    senders = [s for group in config["senders"].values() for s in group]
    parts = []
    if senders:
        parts.append(" OR ".join(f"from:{s}" for s in senders))
    domains = config.get("employer_domains") or []
    if domains:
        parts.append(" OR ".join(f"from:{d}" for d in domains))
    keywords = [k for k in config["subject_keywords"] if k.strip()]
    if keywords:
        parts.append(" OR ".join(f'subject:"{k}"' for k in keywords))
    if not parts:
        raise ValueError("alert-sources config has no senders, domains or subject keywords")
    inner = " OR ".join(f"({p})" for p in parts)
    return f"({inner}) newer_than:{days}d"


# --- message decoding (pure, testable) -------------------------------------


def _header(message: dict, name: str) -> str:
    for header in (message.get("payload") or {}).get("headers") or []:
        if header.get("name", "").lower() == name.lower():
            return header.get("value", "")
    return ""


def _b64url(data: str) -> bytes:
    # Gmail omits padding; urlsafe_b64decode wants it.
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _walk_parts(payload: dict):
    """Yield (mimeType, decoded text) for every leaf part with body data."""
    mime = (payload.get("mimeType") or "").lower()
    body = payload.get("body") or {}
    data = body.get("data")
    if data and not payload.get("parts"):
        charset = "utf-8"
        try:
            yield mime, _b64url(data).decode(charset, errors="replace")
        except (ValueError, LookupError):
            return
    for part in payload.get("parts") or []:
        yield from _walk_parts(part)


def extract_bodies(message: dict) -> dict:
    """{"html": [...], "plain": [...]} decoded bodies of one messages.get resource."""
    bodies = {"html": [], "plain": []}
    payload = message.get("payload") or {}
    for mime, text in _walk_parts(payload):
        if "html" in mime:
            bodies["html"].append(text)
        else:
            bodies["plain"].append(text)
    return bodies


class _LinkParser(HTMLParser):
    """Collect (href, anchor text) pairs from an HTML body."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
        self._href = None
        self._text = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() == "a":
            self._href = dict(attrs).get("href")
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag.lower() == "a" and self._href is not None:
            anchor = " ".join("".join(self._text).split())
            self.links.append((self._href, anchor))
            self._href = None
            self._text = []


BARE_URL = re.compile(r"https?://[^\s<>\"')\]]+")


def extract_links(bodies: dict) -> list:
    """All http(s) links with anchor text, HTML bodies first, then bare URLs
    from plain-text bodies (anchor = '')."""
    links = []
    for html_body in bodies["html"]:
        parser = _LinkParser()
        parser.feed(html_body)
        links.extend(parser.links)
    if not links:
        for plain in bodies["plain"]:
            links.extend((url, "") for url in BARE_URL.findall(plain))
    return links


def _host(url: str) -> str:
    return (urllib.parse.urlsplit(url).hostname or "").lower()


def classify_link(url: str, config: dict) -> str | None:
    """'linkedin' | 'indeed' | 'ladders' | 'employer' | 'other', or None for a
    link that is clearly not a posting (unsubscribe, settings, mailto)."""
    lowered = url.lower()
    if lowered.startswith("mailto:"):
        return None
    for marker in config["ignore_url_markers"]:
        if marker.lower() in lowered:
            return None
    for source, patterns in config["posting_host_patterns"].items():
        if any(p.lower() in lowered for p in patterns):
            return source
    host = _host(url)
    for domain in config.get("employer_domains") or []:
        d = domain.lower()
        if host == d or host.endswith("." + d):
            return "employer"
    return "other"


def classify_sender(from_header: str, config: dict) -> str:
    """Which alert source sent this message, by sender address/domain."""
    address = from_header.lower()
    for source, senders in config["senders"].items():
        if any(s.lower() in address for s in senders):
            return source
    host = address.rsplit("@", 1)[-1].rstrip(">")
    for domain in config.get("employer_domains") or []:
        d = domain.lower()
        if host == d or host.endswith("." + d):
            return "employer"
    return "other"


def record_from_message(message: dict, config: dict) -> dict:
    """One output record from a messages.get resource: metadata + posting links.

    Link order is first-seen, deduplicated by URL. Every link gets a
    classification; `other` links are kept (an employer alert's posting link
    matches no pattern until the config learns the ATS host) and the
    run-alerts command decides whether to fetch them.
    """
    bodies = extract_bodies(message)
    seen_urls = set()
    links = []
    for url, anchor in extract_links(bodies):
        url = url.strip()
        if not url.lower().startswith(("http://", "https://")):
            continue
        kind = classify_link(url, config)
        if kind is None or url in seen_urls:
            continue
        seen_urls.add(url)
        links.append({"url": url, "anchor": anchor[:200], "kind": kind})
    return {
        "id": message.get("id", ""),
        "from": _header(message, "From"),
        "subject": _header(message, "Subject"),
        "date": _header(message, "Date"),
        "internal_date": message.get("internalDate", ""),
        "source": classify_sender(_header(message, "From"), config),
        "links": links,
    }


# --- Gmail API (the only network code; GET only) ----------------------------


def _access_token(account_dir: Path) -> str:
    """Refresh the stored OAuth token. Refuses a token with no read scope."""
    d = account_dir.expanduser()
    try:
        keys = json.loads((d / "gcp-oauth.keys.json").read_text(encoding="utf-8"))
        keys = keys.get("installed") or keys.get("web")
        creds = json.loads((d / "credentials.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, AttributeError) as exc:
        raise RuntimeError(
            f"cannot read Gmail OAuth files in {d}: {exc}. "
            "Create them with `npx @gongrzhe/server-gmail-autoauth-mcp auth` "
            "(see workie docs/google-services-setup.md)."
        ) from exc
    scope = creds.get("scope") or ""
    if scope and not any(s in scope.split() for s in READ_SCOPES):
        raise RuntimeError(
            f"the Gmail token in {d} has scopes {scope!r}, none of which can read mail. "
            "This tool is read-only and needs gmail.readonly (or gmail.modify); "
            "re-authorize with a read scope - it will never send."
        )
    token_req = urllib.parse.urlencode({
        "client_id": keys["client_id"],
        "client_secret": keys["client_secret"],
        "refresh_token": creds["refresh_token"],
        "grant_type": "refresh_token",
    }).encode()
    with urllib.request.urlopen(TOKEN_URL, token_req, context=tls_context()) as resp:
        return json.load(resp)["access_token"]


def _gmail_get(token: str, path: str, params: dict | None = None) -> dict:
    """One GET against the Gmail API. There is deliberately no other method."""
    url = f"{GMAIL_API}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, context=tls_context()) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"Gmail API GET {path} -> HTTP {exc.code}: {detail}") from exc


def _resolve_run_settings(args):
    """Merge jobseek/config.json with this run's CLI flags (flags win)."""
    jcfg = jobseek_config.load_config(args.jobseek_config)
    if args.account_dir is not None:
        account_dir = args.account_dir
    else:
        account = jobseek_config.resolve_account(jcfg, args.account)
        account_dir = jobseek_config.account_dir(account)
    alert_sources = args.config if args.config is not None else jobseek_config.resolve_alert_sources(jcfg)
    days = args.days if args.days is not None else jcfg.get("days", 7)
    limit = args.limit if args.limit is not None else jcfg.get("limit", 50)
    return account_dir, alert_sources, days, limit


def fetch_alerts(account_dir: Path, source_config: dict, query: str, limit: int) -> dict:
    """The live Gmail read behind `alerts`: used by both the CLI and the MCP
    server's `run_alerts` tool so there is exactly one code path that ever
    talks to the Gmail API."""
    token = _access_token(account_dir)
    messages, page_token = [], None
    while len(messages) < min(limit, MAX_MESSAGES):
        params = {"q": query, "maxResults": 50}
        if page_token:
            params["pageToken"] = page_token
        page = _gmail_get(token, "messages", params)
        batch = page.get("messages") or []
        for stub in batch:
            full = _gmail_get(token, f"messages/{stub['id']}", {"format": "full"})
            messages.append(record_from_message(full, source_config))
            if len(messages) >= min(limit, MAX_MESSAGES):
                break
        page_token = page.get("nextPageToken")
        if not page_token or not batch:
            break
    return {
        "query": query,
        "message_count": len(messages),
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "messages": messages,
    }


def cmd_alerts(args) -> int:
    account_dir, alert_sources, days, limit = _resolve_run_settings(args)
    config = load_config(alert_sources)
    query = args.query or build_query(config, days)
    result = fetch_alerts(account_dir, config, query, limit)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


def cmd_extract(args) -> int:
    jcfg = jobseek_config.load_config(args.jobseek_config)
    alert_sources = args.config if args.config is not None else jobseek_config.resolve_alert_sources(jcfg)
    config = load_config(alert_sources)
    try:
        message = json.loads(args.message_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"gmail_alerts: cannot read {args.message_json}: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(record_from_message(message, config), indent=2, ensure_ascii=False))
    return 0


def _force_utf8_output() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8")


def main(argv=None) -> int:
    _force_utf8_output()
    ap = argparse.ArgumentParser(prog="gmail_alerts.py", description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="command", required=True)

    alerts = sub.add_parser("alerts", help="list alert emails and extract posting links (read-only)")
    alerts.add_argument("--days", type=int, default=None, help="look-back window (default: from config, else 7)")
    alerts.add_argument("--limit", type=int, default=None, help="max messages to read (default: from config, else 50)")
    alerts.add_argument("--account", help="named account from jobseek/config.json (default: config's default_account)")
    alerts.add_argument("--account-dir", type=Path, default=None, help="overrides --account and the config entirely")
    alerts.add_argument("--config", type=Path, default=None, help="alert-sources.json path (default: from jobseek config)")
    alerts.add_argument("--jobseek-config", type=Path, default=None, help="jobseek config.json path (default: jobseek/config.json)")
    alerts.add_argument("--query", help="override the generated Gmail query")
    alerts.set_defaults(func=cmd_alerts)

    extract = sub.add_parser("extract", help="offline: extract links from one saved messages.get resource")
    extract.add_argument("--message-json", type=Path, required=True)
    extract.add_argument("--config", type=Path, default=None, help="alert-sources.json path (default: from jobseek config)")
    extract.add_argument("--jobseek-config", type=Path, default=None)
    extract.set_defaults(func=cmd_extract)

    args = ap.parse_args(argv)
    try:
        return args.func(args)
    except ValueError as exc:
        print(f"gmail_alerts: {exc}", file=sys.stderr)
        return 1
    except RuntimeError as exc:
        print(f"gmail_alerts: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
