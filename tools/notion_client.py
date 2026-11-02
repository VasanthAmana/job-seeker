#!/usr/bin/env python3
"""A minimal Notion API client, authenticated via a local OAuth token folder.

Same shape as Gmail's account-folder pattern (`tools/gmail_alerts.py`): the
Notion MCP's own sign-in writes `<account_dir>/token.json` outside this repo
(gitignored by location, not by name - see jobseek/NOTION_SETUP.md); this
module only ever reads that file. There is no Notion API token stored in
jobseek, and this module makes no write call unless a valid token is found.

This is the one piece of `notion_sync` that talks to the network - kept
separate from `tools/notion_sync.py` (the sync logic: filtering, the
create-vs-update decision) so that logic is unit-testable with a fake
client, never a live OAuth connection.
"""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from pathlib import Path

API_BASE = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"


class NotionError(RuntimeError):
    pass


def tls_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def load_token(account_dir: Path) -> str | None:
    """The access token from `<account_dir>/token.json`, or None when the
    folder/file/field is missing or unreadable - "not connected", not an
    error."""
    token_path = Path(account_dir).expanduser() / "token.json"
    if not token_path.is_file():
        return None
    try:
        data = json.loads(token_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    token = data.get("access_token") if isinstance(data, dict) else None
    return token or None


class NotionClient:
    """Thin wrapper over the Notion REST API's page/database endpoints.

    Every method a `sync()` caller needs, nothing more: this is not a
    general Notion SDK. Network calls are isolated here so tests exercise
    `notion_sync.sync()` against a fake implementing the same methods.
    """

    def __init__(self, token: str):
        self.token = token

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            f"{API_BASE}{path}", data=data, method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, context=tls_context(), timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise NotionError(f"Notion API {method} {path} failed ({exc.code}): {detail}") from exc
        except urllib.error.URLError as exc:
            raise NotionError(f"Notion API {method} {path} unreachable: {exc.reason}") from exc

    def create_database(self, parent_page_id: str, title: str, properties_schema: dict) -> str:
        body = {
            "parent": {"type": "page_id", "page_id": parent_page_id},
            "title": [{"type": "text", "text": {"content": title}}],
            "properties": properties_schema,
        }
        result = self._request("POST", "/databases", body)
        return result["id"]

    def create_page(self, database_id: str, properties: dict) -> str:
        body = {"parent": {"database_id": database_id}, "properties": properties}
        result = self._request("POST", "/pages", body)
        return result["id"]

    def update_page(self, page_id: str, properties: dict) -> None:
        self._request("PATCH", f"/pages/{page_id}", {"properties": properties})

    def archive_page(self, page_id: str) -> None:
        self._request("PATCH", f"/pages/{page_id}", {"archived": True})


def build_client(account_dir: Path) -> NotionClient | None:
    """A NotionClient if a token is present, else None ("not connected")."""
    token = load_token(account_dir)
    return NotionClient(token) if token else None
