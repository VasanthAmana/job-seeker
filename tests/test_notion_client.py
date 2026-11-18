"""Tests for tools/notion_client.py - token loading only. No live OAuth and
no real network call is exercised; HTTP methods are covered via
test_notion_sync.py's fake client instead (sync()'s own logic is what needs
unit coverage, not urllib's plumbing)."""

import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(TOOLS))
import notion_client  # noqa: E402


def test_load_token_missing_folder_returns_none(tmp_path):
    assert notion_client.load_token(tmp_path / "nope") is None


def test_load_token_missing_file_returns_none(tmp_path):
    (tmp_path / "acct").mkdir()
    assert notion_client.load_token(tmp_path / "acct") is None


def test_load_token_malformed_json_returns_none(tmp_path):
    acct = tmp_path / "acct"
    acct.mkdir()
    (acct / "token.json").write_text("not json", encoding="utf-8")
    assert notion_client.load_token(acct) is None


def test_load_token_missing_field_returns_none(tmp_path):
    acct = tmp_path / "acct"
    acct.mkdir()
    (acct / "token.json").write_text(json.dumps({"other": "x"}), encoding="utf-8")
    assert notion_client.load_token(acct) is None


def test_load_token_reads_access_token(tmp_path):
    acct = tmp_path / "acct"
    acct.mkdir()
    (acct / "token.json").write_text(json.dumps({"access_token": "secret-token"}), encoding="utf-8")
    assert notion_client.load_token(acct) == "secret-token"


def test_build_client_none_when_not_connected(tmp_path):
    assert notion_client.build_client(tmp_path / "nope") is None


def test_build_client_returns_client_when_connected(tmp_path):
    acct = tmp_path / "acct"
    acct.mkdir()
    (acct / "token.json").write_text(json.dumps({"access_token": "tok"}), encoding="utf-8")
    client = notion_client.build_client(acct)
    assert isinstance(client, notion_client.NotionClient)
    assert client.token == "tok"
