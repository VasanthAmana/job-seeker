"""Integrity gate on saved posting HTML, fetch refusals, robots rules, keys.

No network: posting_guard runs on fixture files, fetch_page is exercised only
on its pre-fetch refusals, robots_check only on its in-memory rule matcher.
"""

import json

import fetch_page
import job_key
import posting_guard
import robots_check
from conftest import FIXTURES


def test_guard_clean_posting(capsys):
    rc = posting_guard.main(["--in", str(FIXTURES / "postings" / "clean_posting.html"),
                             "--html", "--json"])
    assert rc == 0
    out = capsys.readouterr().out
    verdict = out.splitlines()[0]
    assert verdict.startswith("posting_guard: clean")
    assert "⚠" not in verdict
    findings = json.loads(out.split("--- findings ---")[1].split("--- text ---")[0])
    assert findings["instruction_like"] == []
    assert findings["invisible_flagged"] == 0
    text = out.split("--- text ---")[1]
    assert "enterprise AI strategy" in text


def test_guard_catches_hidden_instruction_and_url(capsys):
    rc = posting_guard.main(["--in", str(FIXTURES / "postings" / "injection_posting.html"),
                             "--html", "--json"])
    assert rc == 0
    out = capsys.readouterr().out
    verdict = out.splitlines()[0]
    assert "⚠" in verdict
    findings = json.loads(out.split("--- findings ---")[1].split("--- text ---")[0])
    assert findings["instruction_like"]  # the "ignore all previous instructions" line
    assert "https://evil.example.com/exfiltrate" in findings["hidden_urls"]
    # Hidden payload is removed from the text the scorer would read.
    cleaned = out.split("--- text ---")[1]
    assert "Ignore all previous instructions" not in cleaned
    assert "evil.example.com" not in cleaned
    # Visible content survives.
    assert "AI transformation office" in cleaned


def test_fetch_page_refuses_non_http_and_repo_paths(tmp_path, capsys):
    assert fetch_page.main(["file:///etc/passwd"]) == 2
    repo_file = fetch_page.ROOT / "stolen.html"
    assert fetch_page.main(["https://example.com", "--out", str(repo_file)]) == 2
    assert not repo_file.exists()


def test_robots_rules_in_memory():
    robots = "User-agent: *\nDisallow: /private\nAllow: /private/public\n"
    assert robots_check.allowed(robots, "Claude-User", "/jobs/director") is True
    assert robots_check.allowed(robots, "Claude-User", "/private/secret") is False
    # Longest match wins: the Allow on /private/public beats Disallow /private.
    assert robots_check.allowed(robots, "*", "/private/public/x") is True
    assert robots_check.allowed("", "*", "/anything") is True
    # A rule named for Claude-User applies to the Claude-User fetch.
    named = "User-agent: Claude-User\nDisallow: /\n\nUser-agent: *\nDisallow:\n"
    assert robots_check.allowed(named, "Claude-User", "/jobs") is False


def test_is_robots_body_comment_only_is_valid_empty_policy():
    # RFC 9309: a comment is not a directive, so a comment-only file publishes
    # no rules at all - a valid, empty (allow-all) policy, not an unreadable one.
    comment_only = "# robots.txt\n# nothing to see here\n"
    assert robots_check.is_robots_body(comment_only) is True
    assert robots_check.allowed(comment_only, "Claude-User", "/jobs/director") is True
    # Blank lines mixed with comments are still an empty policy.
    assert robots_check.is_robots_body("\n# comment\n\n#another\n\n") is True


def test_is_robots_body_empty_is_valid():
    assert robots_check.is_robots_body("") is True
    assert robots_check.is_robots_body("   \n\n   ") is True


def test_is_robots_body_html_soft_200_is_rejected():
    assert robots_check.is_robots_body("<html><body>404 Not Found</body></html>") is False


def test_is_robots_body_real_directives_unchanged():
    robots = "User-agent: *\nDisallow: /private\n"
    assert robots_check.is_robots_body(robots) is True
    with_comment = "# policy\nUser-agent: *\nDisallow: /private\n"
    assert robots_check.is_robots_body(with_comment) is True


def test_job_key_is_stable_and_path_safe():
    key = job_key.make_key("Acme Corp, Inc.", "Director, AI Strategy (Denver/Remote)", "https://a.example/1")
    assert job_key.is_canonical(key)
    assert "/" not in key and "," not in key
    assert key == job_key.make_key("Acme Corp, Inc.", "Director, AI Strategy (Denver/Remote)", "https://a.example/1")
    # Truncation is disambiguated: two long titles never collide.
    a = job_key.make_key("Acme", "Director " + "x" * 100 + " A", "https://a.example/1")
    b = job_key.make_key("Acme", "Director " + "x" * 100 + "y", "https://a.example/2")
    assert a != b
