#!/usr/bin/env python3
"""Load jobseek's configuration: Gmail account folders, alert filters,
look-back window, ranking weights, top-N, and output paths.

See `jobseek/config.example.json` for the schema and placeholder values.
Precedence is: built-in DEFAULTS < config.json < explicit CLI flags. A tool
calls `load_config()` once and only falls back to a config value when the
caller did not pass the equivalent flag (argparse defaults of `None`).

The real `config.json` is gitignored - it may name a personal Gmail account
folder - so a missing file is not an error; DEFAULTS cover the owner's
original single-account setup.
"""

from __future__ import annotations

import contextlib
import copy
import fcntl
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # jobseek/
DEFAULT_CONFIG_PATH = ROOT / "config.json"
EXAMPLE_CONFIG_PATH = ROOT / "config.example.json"

DEFAULTS = {
    "accounts": [
        {"name": "default", "account_dir": "~/.gmail-mcp/personal"},
    ],
    "default_account": "default",
    "alert_sources": "alert-sources.json",
    "days": 7,
    "limit": 50,
    "setup_guide": {
        "searches": [],
        "locations": [],
    },
    "ranking": {
        "weights": {"domain": 0.30, "leadership": 0.25, "behavioral": 0.15, "career": 0.30},
        "top_n": 5,
        "candidate_limit": 10,
    },
    "paths": {
        "state_dir": "state",
        "seen_jobs": "state/seen_jobs.json",
        "last_run": "state/last_run.json",
        "tracker": "tracker.csv",
        "upskill_reports": "upskill",
    },
    "notion": {
        "account_dir": "~/.notion-mcp/default",
        "database_name": "Job Search Pipeline",
        "database_id": None,
        "parent_page_id": None,
    },
    "linkedin": {
        "saved_searches": [],
    },
}

REQUIRED_TOP_LEVEL = ("accounts", "ranking", "paths")


class ConfigError(ValueError):
    pass


def _deep_merge(base: dict, override: dict) -> dict:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_config(path: Path | str | None = None) -> dict:
    """DEFAULTS merged with the JSON object at `path` (default jobseek/config.json).

    A missing file applies DEFAULTS unchanged. A present-but-malformed file,
    or one whose top level is not a JSON object, is a ConfigError - silently
    falling back would mask a typo in the owner's own config.

    With no explicit `path`, the `JOBSEEK_CONFIG` environment variable is
    checked before the jobseek/config.json default - mainly so tests and the
    MCP server can point at a fixture config without threading a CLI flag
    through every tool.
    """
    if path is not None:
        resolved = Path(path).expanduser()
    elif os.environ.get("JOBSEEK_CONFIG"):
        resolved = Path(os.environ["JOBSEEK_CONFIG"]).expanduser()
    else:
        resolved = DEFAULT_CONFIG_PATH
    config = copy.deepcopy(DEFAULTS)
    if not resolved.is_file():
        return config
    try:
        data = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError(f"cannot read jobseek config {resolved}: {exc}") from exc
    if not isinstance(data, dict):
        raise ConfigError(f"{resolved}: expected a JSON object at the top level")
    merged = _deep_merge(config, data)
    validate_config(merged, source=resolved)
    return merged


def validate_config(config: dict, source: str | Path = "<config>") -> None:
    if not isinstance(config.get("accounts"), list) or not config["accounts"]:
        raise ConfigError(f"{source}: 'accounts' must be a non-empty array")
    for account in config["accounts"]:
        if not isinstance(account, dict) or not account.get("name") or not account.get("account_dir"):
            raise ConfigError(f"{source}: every account needs a 'name' and an 'account_dir'")
    weights = (config.get("ranking") or {}).get("weights")
    if not isinstance(weights, dict) or not weights:
        raise ConfigError(f"{source}: 'ranking.weights' must be a non-empty object")
    for dim, value in weights.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ConfigError(f"{source}: ranking.weights.{dim} must be a number")
    if not isinstance(config.get("paths"), dict):
        raise ConfigError(f"{source}: 'paths' must be an object")


def resolve_path(config: dict, key: str) -> Path:
    """jobseek/paths.<key>, resolved relative to jobseek/ unless already absolute."""
    try:
        raw = config["paths"][key]
    except KeyError as exc:
        raise ConfigError(f"config is missing paths.{key}") from exc
    p = Path(raw).expanduser()
    return p if p.is_absolute() else ROOT / p


def resolve_alert_sources(config: dict) -> Path:
    raw = config.get("alert_sources") or DEFAULTS["alert_sources"]
    p = Path(raw).expanduser()
    return p if p.is_absolute() else ROOT / p


def list_accounts(config: dict) -> list[dict]:
    return config.get("accounts") or []


def resolve_account(config: dict, name: str | None = None) -> dict:
    """The account named `name`, the configured default_account, or the sole
    configured account - in that order."""
    accounts = list_accounts(config)
    if not accounts:
        raise ConfigError("config has no 'accounts' entries")
    wanted = name or config.get("default_account")
    if wanted:
        for account in accounts:
            if account.get("name") == wanted:
                return account
        if name:
            names = ", ".join(a.get("name", "?") for a in accounts)
            raise ConfigError(f"no account named {wanted!r} in config (have: {names})")
    return accounts[0]


def account_dir(account: dict) -> Path:
    raw = account.get("account_dir")
    if not raw:
        raise ConfigError(f"account {account.get('name')!r} has no account_dir")
    return Path(raw).expanduser()


def ranking_weights(config: dict) -> dict:
    return dict(config["ranking"]["weights"])


def top_n(config: dict) -> int:
    return int(config["ranking"].get("top_n", DEFAULTS["ranking"]["top_n"]))


def candidate_limit(config: dict) -> int:
    return int(config["ranking"].get("candidate_limit", DEFAULTS["ranking"]["candidate_limit"]))


def linkedin_saved_searches(config: dict) -> list[dict]:
    """The `linkedin.saved_searches` the owner configured - query, locations,
    experience_levels, remote, as entered into LinkedIn's own saved-search
    UI - read from this same jobseek config, never a separate file."""
    linkedin = config.get("linkedin") or {}
    searches = linkedin.get("saved_searches")
    return list(searches) if isinstance(searches, list) else []


@contextlib.contextmanager
def state_lock(path: Path):
    """Exclusive advisory lock serializing a read-modify-write of `path`
    across processes - `rank_state`, `alert_state` and `notion_sync` each
    load the state file, mutate it, and atomically replace it, so without
    this a concurrent pair can each read the same version and one's update
    is lost to the other's replace. Held via `fcntl.flock` on a sidecar
    `<path>.lock` file (stdlib only); every writer must hold it for its
    whole load-mutate-save span, not just the final write.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.parent / f".{path.name}.lock"
    with open(lock_path, "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def notion_config(config: dict) -> dict:
    """jobseek/notion.* merged with defaults - account_dir expanded to an
    absolute Path (the OAuth token folder, same shape as a Gmail account
    folder: never committed, holds no repo-tracked secret)."""
    notion = dict(DEFAULTS["notion"])
    notion.update(config.get("notion") or {})
    notion["account_dir"] = Path(notion["account_dir"]).expanduser()
    return notion
