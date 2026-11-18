"""jobseek config loading: defaults, overrides, precedence, bad input.

No network, no real jobseek/config.json is read - every test points
`load_config()` at a fixture path or a missing one.
"""

import json

import pytest

import config


def test_missing_file_returns_defaults(tmp_path):
    cfg = config.load_config(tmp_path / "nope.json")
    assert cfg == config.DEFAULTS
    assert cfg is not config.DEFAULTS  # a copy, not the shared default object


def test_default_account_resolves_to_personal_folder():
    cfg = config.load_config(None)
    account = config.resolve_account(cfg)
    assert account["account_dir"] == "~/.gmail-mcp/personal"


def test_partial_override_merges_not_replaces(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"days": 14}), encoding="utf-8")
    cfg = config.load_config(path)
    assert cfg["days"] == 14
    # Untouched sections keep their defaults.
    assert cfg["ranking"]["weights"] == config.DEFAULTS["ranking"]["weights"]
    assert cfg["accounts"] == config.DEFAULTS["accounts"]


def test_nested_override_merges_one_level_deep(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"ranking": {"top_n": 3}}), encoding="utf-8")
    cfg = config.load_config(path)
    assert cfg["ranking"]["top_n"] == 3
    assert cfg["ranking"]["weights"] == config.DEFAULTS["ranking"]["weights"]
    assert cfg["ranking"]["candidate_limit"] == config.DEFAULTS["ranking"]["candidate_limit"]


def test_multiple_accounts(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({
        "accounts": [
            {"name": "personal", "account_dir": "~/.gmail-mcp/personal"},
            {"name": "jobsearch", "account_dir": "~/.gmail-mcp/jobsearch"},
        ],
        "default_account": "jobsearch",
    }), encoding="utf-8")
    cfg = config.load_config(path)
    assert [a["name"] for a in config.list_accounts(cfg)] == ["personal", "jobsearch"]
    assert config.resolve_account(cfg)["name"] == "jobsearch"
    assert config.resolve_account(cfg, "personal")["account_dir"] == "~/.gmail-mcp/personal"


def test_resolve_account_unknown_name_errors(tmp_path):
    cfg = config.load_config(None)
    with pytest.raises(config.ConfigError):
        config.resolve_account(cfg, "nonexistent")


def test_malformed_json_errors(tmp_path):
    path = tmp_path / "config.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(config.ConfigError):
        config.load_config(path)


def test_non_object_top_level_errors(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")
    with pytest.raises(config.ConfigError):
        config.load_config(path)


def test_empty_accounts_list_errors(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"accounts": []}), encoding="utf-8")
    with pytest.raises(config.ConfigError):
        config.load_config(path)


def test_account_missing_dir_errors(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"accounts": [{"name": "x"}]}), encoding="utf-8")
    with pytest.raises(config.ConfigError):
        config.load_config(path)


def test_non_numeric_weight_errors(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"ranking": {"weights": {"domain": "a lot"}}}), encoding="utf-8")
    with pytest.raises(config.ConfigError):
        config.load_config(path)


def test_resolve_path_relative_to_jobseek_root():
    cfg = config.load_config(None)
    p = config.resolve_path(cfg, "tracker")
    assert p == config.ROOT / "tracker.csv"


def test_resolve_path_absolute_passthrough(tmp_path):
    path = tmp_path / "config.json"
    abs_tracker = str(tmp_path / "tracker.csv")
    path.write_text(json.dumps({"paths": {"tracker": abs_tracker}}), encoding="utf-8")
    cfg = config.load_config(path)
    assert config.resolve_path(cfg, "tracker") == tmp_path / "tracker.csv"


def test_env_var_overrides_default_path(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"days": 21}), encoding="utf-8")
    monkeypatch.setenv("JOBSEEK_CONFIG", str(path))
    cfg = config.load_config(None)
    assert cfg["days"] == 21


def test_explicit_path_wins_over_env_var(tmp_path, monkeypatch):
    env_path = tmp_path / "env.json"
    env_path.write_text(json.dumps({"days": 21}), encoding="utf-8")
    explicit_path = tmp_path / "explicit.json"
    explicit_path.write_text(json.dumps({"days": 3}), encoding="utf-8")
    monkeypatch.setenv("JOBSEEK_CONFIG", str(env_path))
    cfg = config.load_config(explicit_path)
    assert cfg["days"] == 3


def test_example_config_is_valid_and_loadable():
    cfg = config.load_config(config.EXAMPLE_CONFIG_PATH)
    assert len(config.list_accounts(cfg)) >= 2
    assert config.top_n(cfg) > 0
    assert config.candidate_limit(cfg) > 0
    assert cfg["setup_guide"]["locations"]


def test_cli_flag_precedence_over_config(tmp_path):
    """Mirrors gmail_alerts._resolve_run_settings: an explicit CLI value beats
    whatever the config file says, exactly like `args.days or config value`
    is wired in every tool's cmd_* function."""
    import gmail_alerts
    import argparse

    path = tmp_path / "config.json"
    path.write_text(json.dumps({"days": 30, "limit": 99}), encoding="utf-8")

    args = argparse.Namespace(
        account_dir=None, account=None, config=None, jobseek_config=path, days=5, limit=None,
    )
    account_dir, alert_sources, days, limit = gmail_alerts._resolve_run_settings(args)
    assert days == 5          # CLI flag wins over config's 30
    assert limit == 99        # no CLI flag given - config wins over built-in 50
    assert account_dir == config.account_dir(config.resolve_account(config.load_config(None)))
