#!/usr/bin/env python3
"""Secret scan (execution plan section 2, rule 3).

This repository is public. The scan fails CI when a tracked file contains
something shaped like a credential: a private key block, a well-known token
format (AWS, GitHub, GitLab, Slack, Anthropic, OpenAI, Google), or a
long quoted value assigned to a secret-sounding name. It complements the
.gitignore rules that keep credential files out of the index; both exist so
a mistake fails loudly in CI instead of reaching the public remote.

Scan it with: python3 scripts/ci/secret_scan.py
"""

import re
import subprocess
import sys

TOKEN_PATTERNS = [
    ("private key block", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b")),
    ("GitHub fine-grained token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,}\b")),
    ("GitLab token", re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("Anthropic API key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b")),
    ("OpenAI API key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
]

SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|"
    r"refresh[_-]?token|client[_-]?secret)[\"']?\s*[:=]\s*"
    r"[\"'](?P<value>[A-Za-z0-9_/+.\-]{16,})[\"']"
)

# Assigned values that are documentation, not a credential.
PLACEHOLDER_VALUES = (
    "example",
    "placeholder",
    "your-",
    "xxxx",
)


def tracked_files() -> list[str]:
    return subprocess.run(
        ["git", "ls-files"], check=True, capture_output=True, text=True
    ).stdout.splitlines()


def main() -> int:
    findings: list[str] = []
    for path in tracked_files():
        try:
            with open(path, encoding="utf-8", errors="strict") as handle:
                lines = handle.read().splitlines()
        except (UnicodeDecodeError, ValueError):
            continue  # binary file; token shapes are ASCII text
        for lineno, line in enumerate(lines, start=1):
            for name, pattern in TOKEN_PATTERNS:
                if pattern.search(line):
                    findings.append(f"{path}:{lineno}: {name}")
            for match in SECRET_ASSIGNMENT.finditer(line):
                value = match.group("value").lower()
                if not any(marker in value for marker in PLACEHOLDER_VALUES):
                    findings.append(f"{path}:{lineno}: secret-sounding assignment")
    if findings:
        print("secret scan failed:", file=sys.stderr)
        for finding in findings:
            print(f"  {finding}", file=sys.stderr)
        return 1
    print(f"secret scan: {len(tracked_files())} tracked files clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
