"""Tests for tools/notion_sync.py - filtering (min_score/all/rebuild) and
the no-op-when-disconnected path. The Notion client is always a fake
in-memory implementation here: no live OAuth, no real network call."""

import json
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(TOOLS))
import config as jobseek_config  # noqa: E402
import notion_client  # noqa: E402
import notion_sync  # noqa: E402


class FakeNotionClient:
    """Records every call; create_page/update_page/archive_page/
    create_database behave like the real API without touching the network."""

    def __init__(self):
        self.pages = {}  # page_id -> properties
        self.archived = []
        self.created_databases = []
        self._next_id = 0

    def create_database(self, parent_page_id, title, schema):
        self.created_databases.append((parent_page_id, title))
        return "db-created-1"

    def create_page(self, database_id, properties):
        self._next_id += 1
        page_id = f"page-{self._next_id}"
        self.pages[page_id] = properties
        return page_id

    def update_page(self, page_id, properties):
        self.pages[page_id] = properties

    def archive_page(self, page_id):
        self.archived.append(page_id)


def entry(title, company, url, score, **extra):
    base = {
        "title": title, "company": company, "url": url, "source": "linkedin",
        "status": "ranked", "rank_score": score, "location_verdict": "PASS",
        "seniority_gate": "PASS", "engineering_role": False,
        "reason": "Director-level AI strategy scope.", "deadline": None,
    }
    base.update(extra)
    return base


def write_config(tmp_path, *, database_id="db-1", parent_page_id=None, top_n=5):
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({
        "accounts": [{"name": "test", "account_dir": str(tmp_path / "gmail-missing")}],
        "paths": {
            "state_dir": "state",
            "seen_jobs": str(state_dir / "seen_jobs.json"),
            "last_run": str(state_dir / "last_run.json"),
            "tracker": str(tmp_path / "tracker.csv"),
        },
        "ranking": {"top_n": top_n},
        "notion": {
            "account_dir": str(tmp_path / "notion-acct"),
            "database_id": database_id,
            "parent_page_id": parent_page_id,
        },
    }), encoding="utf-8")
    return jobseek_config.load_config(cfg_path)


def write_seen(tmp_path, entries: dict):
    state_dir = tmp_path / "state"
    (state_dir / "seen_jobs.json").write_text(json.dumps({"seen": entries}), encoding="utf-8")


# --- select_entries (pure filtering logic) ---------------------------------


class TestSelectEntries:
    def test_default_returns_eligible_top_n_sorted_by_score(self):
        seen = {
            "a": entry("A", "Acme", "u1", 50),
            "b": entry("B", "Beta", "u2", 90),
            "c": entry("C", "Gamma", "u3", 70),
        }
        result = notion_sync.select_entries(seen, top_n=2)
        assert [k for k, _ in result] == ["b", "c"]

    def test_min_score_filters_without_top_n_cap(self):
        seen = {
            "a": entry("A", "Acme", "u1", 50),
            "b": entry("B", "Beta", "u2", 90),
            "c": entry("C", "Gamma", "u3", 70),
        }
        result = notion_sync.select_entries(seen, min_score=70, top_n=1)
        assert sorted(k for k, _ in result) == ["b", "c"]

    def test_all_includes_vetoed_and_unranked(self):
        seen = {
            "a": entry("A", "Acme", "u1", 50),
            "b": entry("B", "Beta", "u2", 10, status="expired"),
            "c": entry("C", "Gamma", "u3", 20, seniority_gate="FAIL"),
        }
        result = notion_sync.select_entries(seen, all_=True)
        assert sorted(k for k, _ in result) == ["a", "b", "c"]

    def test_default_excludes_vetoed_entries(self):
        seen = {
            "a": entry("A", "Acme", "u1", 95, seniority_gate="FAIL"),
            "b": entry("B", "Beta", "u2", 60, engineering_role=True),
            "c": entry("C", "Gamma", "u3", 40, location_verdict="FAIL"),
            "d": entry("D", "Delta", "u4", 55),
        }
        result = notion_sync.select_entries(seen, top_n=5)
        assert [k for k, _ in result] == ["d"]


# --- build_properties -------------------------------------------------------


def test_build_properties_shape():
    e = entry("Director, AI Strategy", "Acme", "https://acme.example/job", 82, deadline="2026-12-01")
    props = notion_sync.build_properties("acme::director-ai-strategy", e)
    assert props["Title"]["title"][0]["text"]["content"] == "Director, AI Strategy"
    assert props["Company"]["rich_text"][0]["text"]["content"] == "Acme"
    assert props["Score"]["number"] == 82
    assert props["URL"]["url"] == "https://acme.example/job"
    assert props["Deadline"]["date"]["start"] == "2026-12-01"
    assert props["JobKey"]["rich_text"][0]["text"]["content"] == "acme::director-ai-strategy"


def test_build_properties_handles_missing_deadline():
    e = entry("A", "Acme", "u1", 50)
    props = notion_sync.build_properties("k", e)
    assert props["Deadline"]["date"] is None


# --- sync(): no-op when disconnected ---------------------------------------


class TestSyncDisconnected:
    def test_no_token_reports_not_connected_and_makes_no_changes(self, tmp_path):
        cfg = write_config(tmp_path)
        write_seen(tmp_path, {"a": entry("A", "Acme", "u1", 90)})
        result = notion_sync.sync(cfg)  # no client injected -> real build_client() -> no token
        assert result["connected"] is False
        assert "not connected" in result["message"]
        assert result["synced"] == 0
        seen_after = json.loads((tmp_path / "state" / "seen_jobs.json").read_text())
        assert "notion_page_id" not in seen_after["seen"]["a"]


# --- sync(): with a fake connected client -----------------------------------


class TestSyncConnected:
    def test_missing_state_file_is_a_clean_noop(self, tmp_path):
        cfg = write_config(tmp_path)
        result = notion_sync.sync(cfg, client=FakeNotionClient())
        assert result["connected"] is True
        assert result["synced"] == 0
        assert "not found" in result["message"] or "no postings" in result["message"]

    def test_creates_pages_for_shortlist_and_stores_page_id(self, tmp_path):
        cfg = write_config(tmp_path, top_n=5)
        write_seen(tmp_path, {
            "a": entry("A", "Acme", "u1", 90),
            "b": entry("B", "Beta", "u2", 60),
        })
        client = FakeNotionClient()
        result = notion_sync.sync(cfg, client=client)
        assert result["connected"] is True
        assert result["created"] == 2
        assert result["updated"] == 0
        assert len(client.pages) == 2

        seen_after = json.loads((tmp_path / "state" / "seen_jobs.json").read_text())["seen"]
        assert seen_after["a"]["notion_page_id"].startswith("page-")
        assert seen_after["b"]["notion_page_id"].startswith("page-")

    def test_resync_updates_the_same_page_instead_of_duplicating(self, tmp_path):
        cfg = write_config(tmp_path)
        write_seen(tmp_path, {"a": entry("A", "Acme", "u1", 90)})
        client = FakeNotionClient()
        first = notion_sync.sync(cfg, client=client)
        assert first["created"] == 1

        second = notion_sync.sync(cfg, client=client)
        assert second["created"] == 0
        assert second["updated"] == 1
        assert len(client.pages) == 1  # still one page, not two

    def test_rebuild_creates_fresh_page_and_archives_old_one(self, tmp_path):
        cfg = write_config(tmp_path)
        write_seen(tmp_path, {"a": entry("A", "Acme", "u1", 90)})
        client = FakeNotionClient()
        first = notion_sync.sync(cfg, client=client)
        old_page_id = json.loads((tmp_path / "state" / "seen_jobs.json").read_text())["seen"]["a"]["notion_page_id"]

        second = notion_sync.sync(cfg, client=client, rebuild=True)
        assert second["created"] == 1
        assert second["updated"] == 0
        assert old_page_id in client.archived
        new_page_id = json.loads((tmp_path / "state" / "seen_jobs.json").read_text())["seen"]["a"]["notion_page_id"]
        assert new_page_id != old_page_id

    def test_min_score_and_all_flags_are_passed_through_to_selection(self, tmp_path):
        cfg = write_config(tmp_path, top_n=1)
        write_seen(tmp_path, {
            "a": entry("A", "Acme", "u1", 90),
            "b": entry("B", "Beta", "u2", 40),
        })
        client = FakeNotionClient()
        result = notion_sync.sync(cfg, client=client, min_score=30)
        assert result["synced"] == 2  # both clear min_score=30, unlike the top_n=1 default

        client2 = FakeNotionClient()
        result2 = notion_sync.sync(cfg, client=client2, all_=True)
        assert result2["synced"] == 2
        assert result2["all"] is True

    def test_creates_database_when_only_parent_page_id_configured(self, tmp_path):
        cfg = write_config(tmp_path, database_id=None, parent_page_id="parent-123")
        write_seen(tmp_path, {"a": entry("A", "Acme", "u1", 90)})
        client = FakeNotionClient()
        result = notion_sync.sync(cfg, client=client)
        assert result["database_id"] == "db-created-1"
        assert client.created_databases == [("parent-123", "Job Search Pipeline")]

    def test_no_database_id_and_no_parent_page_id_raises_notion_error(self, tmp_path):
        cfg = write_config(tmp_path, database_id=None, parent_page_id=None)
        write_seen(tmp_path, {"a": entry("A", "Acme", "u1", 90)})
        with pytest.raises(notion_client.NotionError):
            notion_sync.sync(cfg, client=FakeNotionClient())


def test_cli_sync_prints_json_and_exits_0_when_disconnected(tmp_path, capsys):
    cfg = write_config(tmp_path)
    write_seen(tmp_path, {"a": entry("A", "Acme", "u1", 90)})
    cfg_path = tmp_path / "config.json"
    rc = notion_sync.main(["sync", "--config", str(cfg_path)])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["connected"] is False
