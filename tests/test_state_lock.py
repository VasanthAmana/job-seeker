"""F9: seen_jobs.json's read-modify-write writers must not lose updates to a
concurrent writer. rank_state, alert_state and notion_sync each load the
store, mutate it, and atomically replace it (os.replace) - two such cycles
interleaved around the same stale read lose whichever one replaces first.
These tests force that interleaving with an injected delay between the load
and the save and assert both writers' keys survive."""

import argparse
import json
import sys
import threading
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(TOOLS))
import alert_state  # noqa: E402
import config as jobseek_config  # noqa: E402
import notion_client  # noqa: E402
import notion_sync  # noqa: E402


def _widen_load_state(monkeypatch, module, delay=0.05):
    """Wrap `module.load_state` so each caller sleeps right after reading -
    the race window a lock must close."""
    original = module.load_state

    def slow_load_state(path):
        doc, seen = original(path)
        time.sleep(delay)
        return doc, seen

    monkeypatch.setattr(module, "load_state", slow_load_state)


def _job(tag):
    return {
        "title": f"Title {tag}",
        "company": f"Company {tag}",
        "url": f"https://example.com/job-{tag}",
        "source": "linkedin",
        "first_seen": "2026-11-01",
        "status": "new",
    }


def test_concurrent_alert_state_store_survives_both_writers(tmp_path, monkeypatch):
    _widen_load_state(monkeypatch, alert_state)

    state = tmp_path / "state" / "seen_jobs.json"
    tracker = tmp_path / "tracker.csv"

    results_a = tmp_path / "a.json"
    results_b = tmp_path / "b.json"
    results_a.write_text(json.dumps([_job("a")]), encoding="utf-8")
    results_b.write_text(json.dumps([_job("b")]), encoding="utf-8")

    errors = []

    def worker(results_path):
        try:
            args = argparse.Namespace(command="store", results=results_path, state=state, tracker=tracker)
            alert_state.run(args)
        except Exception as exc:  # pragma: no cover - surfaced via `errors`
            errors.append(exc)

    t1 = threading.Thread(target=worker, args=(results_a,))
    t2 = threading.Thread(target=worker, args=(results_b,))
    t1.start()
    time.sleep(0.01)  # ensures t2's load lands inside t1's widened window
    t2.start()
    t1.join()
    t2.join()

    assert not errors
    doc = json.loads(state.read_text(encoding="utf-8"))
    seen = doc.get("seen", doc)
    assert len(seen) == 2, f"expected both concurrent writers' keys, got {list(seen)}"


class _FakeNotionClient:
    def __init__(self):
        self._next_id = 0

    def create_database(self, parent_page_id, title, schema):
        return "db-1"

    def create_page(self, database_id, properties):
        self._next_id += 1
        return f"page-{self._next_id}"

    def update_page(self, page_id, properties):
        pass

    def archive_page(self, page_id):
        pass


def test_concurrent_notion_sync_and_alert_state_survive(tmp_path, monkeypatch):
    """A concurrent MCP `notion_sync` and a `run-alerts` `alert_state store`
    race on the same file - the scenario F9 names directly."""
    _widen_load_state(monkeypatch, alert_state)

    state = tmp_path / "state" / "seen_jobs.json"
    state.parent.mkdir(parents=True, exist_ok=True)
    existing = {"seen": {"company-ranked-url": {
        "title": "Already Ranked", "company": "Ranked Co", "url": "https://example.com/ranked",
        "source": "linkedin", "first_seen": "2026-11-01", "status": "ranked", "rank_score": 80,
        "location_verdict": "PASS", "seniority_gate": "PASS", "engineering_role": False,
    }}}
    state.write_text(json.dumps(existing), encoding="utf-8")

    tracker = tmp_path / "tracker.csv"
    results_a = tmp_path / "a.json"
    results_a.write_text(json.dumps([_job("a")]), encoding="utf-8")

    config = jobseek_config.load_config()
    config = jobseek_config._deep_merge(
        config, {"paths": {"seen_jobs": str(state)}, "notion": {"database_id": "db-1"}}
    )

    # notion_sync's own load/save pair races the same way; widen it too so
    # both writers' windows overlap regardless of scheduling order.
    original_load_seen = notion_sync._load_seen

    def slow_load_seen(path):
        loaded = original_load_seen(path)
        time.sleep(0.05)
        return loaded

    monkeypatch.setattr(notion_sync, "_load_seen", slow_load_seen)

    errors = []

    def alert_worker():
        try:
            args = argparse.Namespace(command="store", results=results_a, state=state, tracker=tracker)
            alert_state.run(args)
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    def notion_worker():
        try:
            notion_sync.sync(config, all_=True, client=_FakeNotionClient())
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    t1 = threading.Thread(target=alert_worker)
    t2 = threading.Thread(target=notion_worker)
    t1.start()
    time.sleep(0.01)
    t2.start()
    t1.join()
    t2.join()

    assert not errors
    doc = json.loads(state.read_text(encoding="utf-8"))
    seen = doc.get("seen", doc)
    assert "company-ranked-url" in seen, "notion_sync's notion_page_id write must survive"
    assert seen["company-ranked-url"].get("notion_page_id"), "notion_sync should have written back a page id"
    assert any(e.get("company") == "Company a" for e in seen.values() if e is not existing["seen"]["company-ranked-url"]), (
        "alert_state's new posting must survive the concurrent notion_sync write"
    )
