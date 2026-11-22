#!/usr/bin/env python3
"""ChristianTechJobs RSS source for `/run-alerts`. READ-ONLY, no sign-up.

ChristianTechJobs (christiantechjobs.io) publishes an open, unauthenticated
RSS 2.0 feed of its current open listings at `/api/rss`. Its `robots.txt`
disallows `/api/` wholesale except two explicit carve-outs, one of them
`Allow: /api/rss` - so polling this one path is consistent with the site's
own stated crawl policy (see the jobsite-api-check research report). There is
no API to sign up for and nothing here ever authenticates.

This is a second, independent source feeding the SAME dedupe store that
`linkedin/source.py` and `tools/gmail_alerts.py` feed - same candidate shape
`tools/alert_state.py` already consumes, same `state/seen_jobs.json`, never a
parallel pipeline. Unlike an email alert, the feed already carries a posting
identity (`link`/`guid`) and company/location for every item, so nothing here
needs to parse free-text anchors.

Politeness:

  * One poll per invocation, with a conservative floor of
    `MIN_POLL_INTERVAL_SECONDS` (30 minutes) between live fetches, tracked in
    a small poll-state file. `/run-alerts` is a human-triggered, at-most-a-
    few-times-a-day workflow and the feed itself has no published rate limit
    or refresh cadence faster than that, so 30 minutes is a generous safety
    margin against an accidental tight retry loop in the same session - it
    does not get in the way of ordinary use.
  * A clear, descriptive User-Agent (`USER_AGENT`).
  * Conditional GET: the poll state remembers `ETag`/`Last-Modified` from the
    last response and sends `If-None-Match`/`If-Modified-Since` next time. A
    304 costs the host nothing beyond a cheap revalidation. If the feed never
    sends either header (observed behaviour at the time of writing), this is
    simply a no-op - every poll is an ordinary conditional-less GET.
  * Every poll attempt - success, 304, or failure - advances the poll-state
    clock, so a failing or slow-to-revalidate feed cannot be retried in a
    tight loop by re-running `/run-alerts`.

Usage:
  python3 tools/christiantechjobs_alerts.py candidates
          [--state state/christiantechjobs_feed_state.json] [--feed-url URL]
  python3 tools/christiantechjobs_alerts.py parse --feed-xml FILE   # offline:
          one saved feed body, no network, no state (tests + debugging)

Both print one JSON object: `{"fetched", "jobs", "links": [...], "errors": [...]}`.
`links` is ready to concatenate with `gmail_alerts.py`'s and `linkedin/source.py`'s
candidate links into one array before `tools/alert_state.py candidates` - see
`.claude/commands/run-alerts.md` Step 1.

Exit 0 on success (even an empty or unreachable feed is reported, not fatal);
1 on a usage or state error.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import date, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from xml.etree import ElementTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as jobseek_config  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FEED_URL = "https://www.christiantechjobs.io/api/rss"
DEFAULT_STATE_PATH = ROOT / "state" / "christiantechjobs_feed_state.json"
SOURCE_ID = "christiantechjobs"

USER_AGENT = "jobseek-christiantechjobs-poller/1.0 (read-only RSS poll; one fetch per /run-alerts run)"
MIN_POLL_INTERVAL_SECONDS = 30 * 60  # see "Politeness" above
REQUEST_TIMEOUT_SECONDS = 20

_COMPANY_LOCATION_SEP = re.compile(r"\s+—\s+")  # the feed separates "Company — Location" with an em dash


def tls_context():
    """python.org builds ship no CA certificates; use certifi's bundle when present."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


# --- pure parsing (offline-testable) ----------------------------------------


def _strip_tags(fragment: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", fragment)).strip()


def _company_and_location(description_html: str) -> tuple[str, str]:
    """The feed's `description` CDATA opens with an image, then one `<p>` of
    "Company — Location" before the "Tags: ..." line and the job body. Best
    effort: an unrecognised shape yields two empty strings rather than a
    wrong guess - callers then simply omit `company`/`location`, the same as
    a Gmail alert whose anchor text does not name the employer."""
    paragraphs = re.findall(r"<p>(.*?)</p>", description_html, flags=re.S)
    if not paragraphs:
        return "", ""
    first = _strip_tags(paragraphs[0])
    parts = _COMPANY_LOCATION_SEP.split(first, maxsplit=1)
    if len(parts) != 2:
        return "", ""
    return parts[0].strip(), parts[1].strip()


def _posted_date(pub_date: str) -> str | None:
    if not pub_date:
        return None
    try:
        parsed = parsedate_to_datetime(pub_date)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%d")


def parse_feed(xml_text: str) -> tuple[list[dict], list[str]]:
    """RSS XML -> (items, errors). `items` is one dict per parseable `<item>`
    with `title`, `url`, `guid`, `pub_date`, `category`, `company`,
    `location` (the last two may be empty). Malformed XML or a channel with
    no items is not an error - it simply yields `([], [])` or `([], [error])`."""
    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError as exc:
        return [], [f"invalid RSS XML: {exc}"]
    items = []
    errors = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        url = (item.findtext("link") or "").strip()
        if not title or not url:
            errors.append(f"item missing title or link (guid={item.findtext('guid')!r})")
            continue
        description = item.findtext("description") or ""
        company, location = _company_and_location(description)
        items.append({
            "title": title,
            "url": url,
            "guid": (item.findtext("guid") or url).strip(),
            "pub_date": item.findtext("pubDate") or "",
            "category": (item.findtext("category") or "").strip(),
            "company": company,
            "location": location,
        })
    return items, errors


def to_candidate(item: dict, today: str) -> dict:
    """Shape one parsed feed item into `tools/alert_state.py`'s candidate
    schema - see `linkedin/source.py` for the same shape from a second,
    independent source."""
    candidate = {
        "url": item["url"],
        "source": SOURCE_ID,
        "anchor_title": item["title"],
        "title": item["title"],
        "message_id": f"ctj:{item['guid']}",
        "alert_date": today,
    }
    if item.get("company"):
        candidate["company"] = item["company"]
    if item.get("location"):
        candidate["location"] = item["location"]
    posted = _posted_date(item.get("pub_date", ""))
    if posted:
        candidate["posted_date"] = posted
    return candidate


def candidates_from_xml(xml_text: str, today: str | None = None) -> dict:
    """Pure: feed body -> `{"jobs", "links", "errors"}`. No network, no state
    - used by both the live poll and the offline `parse` command/tests."""
    today = today or date.today().isoformat()
    items, errors = parse_feed(xml_text)
    links = [to_candidate(item, today) for item in items]
    return {"jobs": len(links), "links": links, "errors": errors}


# --- poll state (conditional GET + minimum interval) -------------------------


def _load_poll_state(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_poll_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".christiantechjobs_feed_state.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _fetch(feed_url: str, state: dict) -> tuple[int, str | None, dict]:
    """One conditional GET. Returns (http_status_or_0_on_network_error, body
    or None, the response headers worth remembering)."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/xml, text/xml"}
    if state.get("etag"):
        headers["If-None-Match"] = state["etag"]
    if state.get("last_modified"):
        headers["If-Modified-Since"] = state["last_modified"]
    req = urllib.request.Request(feed_url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS, context=tls_context()) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            new_headers = {"etag": resp.headers.get("ETag"), "last_modified": resp.headers.get("Last-Modified")}
            return resp.status, body, new_headers
    except urllib.error.HTTPError as exc:
        if exc.code == 304:
            return 304, None, {}
        return exc.code, None, {}
    except (urllib.error.URLError, OSError, TimeoutError):
        return 0, None, {}


def fetch_and_poll(state_path: Path = DEFAULT_STATE_PATH, feed_url: str = FEED_URL, now: float | None = None) -> dict:
    """The live read behind `candidates`: one conditional GET at most, gated
    by `MIN_POLL_INTERVAL_SECONDS`. Always returns a result - a skipped,
    not-modified, or unreachable poll is reported, never raised, so one bad
    poll never fails the rest of `/run-alerts`."""
    now = time.time() if now is None else now
    with jobseek_config.state_lock(state_path):
        state = _load_poll_state(state_path)
        last_polled = state.get("last_polled_at")
        if isinstance(last_polled, (int, float)) and now - last_polled < MIN_POLL_INTERVAL_SECONDS:
            wait = MIN_POLL_INTERVAL_SECONDS - (now - last_polled)
            return {"fetched": False, "reason": f"polled {int(now - last_polled)}s ago; waiting {int(wait)}s more",
                    "jobs": 0, "links": [], "errors": []}

        status, body, new_headers = _fetch(feed_url, state)
        state["last_polled_at"] = now
        if status == 200 and body is not None:
            state["etag"] = new_headers.get("etag") or None
            state["last_modified"] = new_headers.get("last_modified") or None
            _save_poll_state(state_path, state)
            result = candidates_from_xml(body)
            result["fetched"] = True
            return result
        _save_poll_state(state_path, state)
        if status == 304:
            return {"fetched": True, "reason": "not modified since last poll", "jobs": 0, "links": [], "errors": []}
        if status == 0:
            return {"fetched": False, "reason": "network error reaching the feed", "jobs": 0, "links": [], "errors": []}
        return {"fetched": False, "reason": f"feed returned HTTP {status}", "jobs": 0, "links": [], "errors": []}


# --- CLI ----------------------------------------------------------------


def cmd_candidates(args) -> int:
    result = fetch_and_poll(state_path=args.state, feed_url=args.feed_url)
    print(json.dumps(result, ensure_ascii=False))
    return 0


def cmd_parse(args) -> int:
    try:
        xml_text = args.feed_xml.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"christiantechjobs_alerts: cannot read {args.feed_xml}: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(candidates_from_xml(xml_text), ensure_ascii=False))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="christiantechjobs_alerts.py", description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="command", required=True)

    candidates_cmd = sub.add_parser("candidates", help="poll the live feed (read-only; respects the minimum interval)")
    candidates_cmd.add_argument("--state", type=Path, default=DEFAULT_STATE_PATH)
    candidates_cmd.add_argument("--feed-url", default=FEED_URL)
    candidates_cmd.set_defaults(func=cmd_candidates)

    parse_cmd = sub.add_parser("parse", help="offline: parse one saved feed body, no network, no state")
    parse_cmd.add_argument("--feed-xml", type=Path, required=True)
    parse_cmd.set_defaults(func=cmd_parse)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
