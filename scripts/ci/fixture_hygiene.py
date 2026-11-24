#!/usr/bin/env python3
"""Fixture-hygiene scan (execution plan section 2, rule 3).

Fixtures are committed to a public repository, so they must only ever use
fictional people and fictional addresses. This scan fails CI when a tracked
fixture file contains:

- an email address outside the fictional domains (example.com, example.org,
  example.net, anything under .example or .test), other than the small
  allowlist of the services' own public alert-sender mailboxes the Gmail
  alert fixtures quote (they are the vendors' addresses, not personal data);
- a home-directory path (/Users/<name>, C:\\Users\\<name>, /home/<name>),
  which would name a real person's machine.

Scan it with: python3 scripts/ci/fixture_hygiene.py
"""

import re
import subprocess
import sys

FICTIONAL_DOMAIN = re.compile(
    r"^[\w.+-]+@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|example|test)$",
    re.IGNORECASE,
)

# Public mailboxes of the alert services themselves, quoted by the Gmail
# alert fixtures. Not personal data. Vendor addresses only; a person's
# address never belongs here.
ALLOWED_ADDRESSES = {
    "jobs-noreply@linkedin.com",
    "jobalerts-noreply@linkedin.com",
    "messages-noreply@linkedin.com",
    "alert@indeed.com",
    "noreply@indeed.com",
    "alerts@theladders.com",
    "noreply@theladders.com",
}

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")

HOME_PATH = re.compile(
    r"(?:/Users/|[A-Za-z]:\\\\Users\\\\|/home/)(?P<user>[A-Za-z0-9._-]+)"
)
# Placeholder accounts that are fine in fixtures.
ALLOWED_HOME_USERS = {"user", "runner", "example", "demo", "test", "you", "your-username"}


def fixture_files() -> list[str]:
    files = subprocess.run(
        ["git", "ls-files"], check=True, capture_output=True, text=True
    ).stdout.splitlines()
    return [f for f in files if "fixtures/" in f or f.startswith("fixtures/")]


def main() -> int:
    findings: list[str] = []
    for path in fixture_files():
        try:
            with open(path, encoding="utf-8", errors="strict") as handle:
                text = handle.read()
        except (UnicodeDecodeError, ValueError):
            continue  # binary fixture; nothing to scan for these patterns
        for lineno, line in enumerate(text.splitlines(), start=1):
            for address in EMAIL.findall(line):
                if address.lower() in ALLOWED_ADDRESSES:
                    continue
                if FICTIONAL_DOMAIN.match(address):
                    continue
                findings.append(
                    f"{path}:{lineno}: non-fictional email address {address!r} "
                    "(fixtures use example.com/.example.test addresses)"
                )
            for match in HOME_PATH.finditer(line):
                if match.group("user").lower() not in ALLOWED_HOME_USERS:
                    findings.append(
                        f"{path}:{lineno}: home-directory path names user "
                        f"{match.group('user')!r} (fixtures use placeholders)"
                    )
    if findings:
        print("fixture-hygiene scan failed:", file=sys.stderr)
        for finding in findings:
            print(f"  {finding}", file=sys.stderr)
        return 1
    print(f"fixture-hygiene scan: {len(fixture_files())} fixture files clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
