#!/usr/bin/env python3
"""GitHub: the profile and **every** public repository, not just the pinned ones.

This is ai-job-search `/expand`'s Step 1e, kept at the same depth (the
original is explicit that unpinned repos carry real signal) and re-aimed at
an executive profile: a Director/VP AI-strategy candidate's GitHub is read
for credibility behind the AI claims - what they have actually built or
shipped - rather than for a toolchain inventory.

Everything is read through GitHub's public, unauthenticated REST API and
`raw.githubusercontent.com`, both GET-only through
`read_source.read_url()`, so the robots gate, the bounds and
`posting_guard.py` apply to them exactly as to a job posting. No token is
read, created or sent; nothing is written to GitHub.

JSON is parsed from the raw body rather than from the guard-cleaned text,
because folding whitespace would alter string values - but every prose field
pulled out of it (`bio`, `description`, a README line) passes
`read_source.clean_prose()` before it reaches a Signal, and the page-level
guard verdict is what the proposals file reports for the source.
"""

from __future__ import annotations

import json
import re

from competency_map import SourceReport, cited, inferred
from read_source import clean_prose, is_instruction_like, read_url

API = "https://api.github.com"
REPOS_PER_PAGE = 100
MAX_REPO_PAGES = 3          # 300 repos; past that the account is not a person's
MAX_READMES = 30            # READMEs cost one request each
MAX_TOPICS_PER_REPO = 4
MAX_TERMS_PER_README = 6
README_NAMES = ("README.md", "README.MD", "readme.md", "README.rst", "README")

# A bio that talks like an executive is scope evidence; one that does not is
# still technical-depth evidence. Nothing here invents a title - the bio is
# quoted either way, and the category is the only thing this changes.
EXEC_WORDS = re.compile(
    r"\b(chief|c[a-z]{1,2}o\b|vp\b|vice president|director|head of|board|advisor|adviser"
    r"|strategy|strategist|transformation|governance|executive)\b", re.I)

# Technologies worth inferring from a README, chosen for what an AI-strategy
# executive would be asked about in an interview, not for completeness.
TECH_TERMS = (
    (r"\bpytorch\b", "PyTorch"), (r"\btensorflow\b", "TensorFlow"),
    (r"\bscikit-?learn\b", "scikit-learn"), (r"\bhugging ?face\b", "Hugging Face"),
    (r"\blangchain\b", "LangChain"), (r"\bllama[- ]?index\b", "LlamaIndex"),
    (r"\bretrieval[- ]augmented generation\b|\brag\b", "retrieval-augmented generation"),
    (r"\bfine[- ]?tun\w*\b", "model fine-tuning"), (r"\bevals?\b|\bevaluation harness\b", "model evaluation"),
    (r"\bmlflow\b", "MLflow"), (r"\bkubeflow\b", "Kubeflow"), (r"\bairflow\b", "Apache Airflow"),
    (r"\bdbt\b", "dbt"), (r"\bsnowflake\b", "Snowflake"), (r"\bdatabricks\b", "Databricks"),
    (r"\bkubernetes\b|\bk8s\b", "Kubernetes"), (r"\bterraform\b", "Terraform"),
    (r"\bsagemaker\b", "AWS SageMaker"), (r"\bvertex ai\b", "Google Vertex AI"),
    (r"\bazure (?:open ?ai|ml)\b", "Azure AI"),
    (r"\bmodel (?:risk|governance)\b|\bai governance\b", "AI governance tooling"),
)
TECH_PATTERNS = tuple((re.compile(pattern, re.I), label) for pattern, label in TECH_TERMS)

BADGE = re.compile(r"^\s*(?:\[!\[|!\[|<img|<p align|<div align|={3,}|-{3,}|#+\s*$)")


def _get_json(url: str, reader) -> tuple[object, object]:
    """(parsed JSON or None, SourceRead) - a non-JSON body reads as a failure.

    `fetch_page.py` reports an HTTP status without treating it as an error,
    which is right for a posting but not here: GitHub answers 404 and 403
    with a perfectly valid JSON object, so an unknown username or a
    rate-limited unauthenticated request would otherwise read as a source
    that was scanned and simply had nothing in it. GitHub's error shape -
    a `message` with no `login`/`name` - is caught as the failure it is.
    """
    read = reader(url, "text")
    if not read.ok:
        return None, read
    try:
        data = json.loads(read.raw)
    except json.JSONDecodeError:
        read.status = "error"
        read.reason = "response was not JSON (GitHub may have rate-limited this unauthenticated request)"
        return None, read
    if isinstance(data, dict) and data.get("message") and not (data.get("login") or data.get("name")):
        read.status = "error"
        read.reason = f"GitHub API said: {str(data['message'])[:140]}"
        return None, read
    return data, read


def _readme_summary(text: str) -> str:
    """The first line of a README that reads like a sentence about the project.

    An instruction-shaped line is skipped rather than summarised: the guard
    quotes those lines instead of removing them (see
    `read_source.is_instruction_like`), and a README whose opening sentence
    is a prompt-injection payload must contribute nothing, not contribute
    the payload.
    """
    for line in text.splitlines():
        stripped = line.strip().lstrip("#").strip()
        if len(stripped) < 25 or BADGE.match(line):
            continue
        if stripped.startswith(("|", ">", "```", "<!--")):
            continue
        if is_instruction_like(stripped):
            continue
        return stripped
    return ""


def fetch_repos(user: str, reader):
    """Every public repo of `user` (owner-type, paginated).

    -> (repos, failures, truncated, gate) where `gate` is the (verdict,
    flagged) of the last repository-list response, so each repo row in the
    proposals file can report the gate verdict of the fetch it came from
    rather than an empty cell.
    """
    repos: list = []
    failures: list = []
    truncated = False
    gate = ("", False)
    for page in range(1, MAX_REPO_PAGES + 1):
        url = f"{API}/users/{user}/repos?per_page={REPOS_PER_PAGE}&page={page}&type=owner&sort=updated"
        data, read = _get_json(url, reader)
        if data is None:
            failures.append((url, read.reason or "unreadable"))
            break
        gate = (read.verdict, read.flagged)
        if not isinstance(data, list):
            failures.append((url, "repository list was not a JSON array"))
            break
        repos.extend(item for item in data if isinstance(item, dict))
        if len(data) < REPOS_PER_PAGE:
            break
        if page == MAX_REPO_PAGES:
            truncated = True
    return repos, failures, truncated, gate


def _repo_signals(user: str, repo: dict, out) -> int:
    name = str(repo.get("name") or "").strip()
    if not name:
        return 0
    url = repo.get("html_url") or f"https://github.com/{user}/{name}"
    label = f"GitHub - {user}/{name}"
    count = 0
    description, flagged = clean_prose(str(repo.get("description") or ""))
    if description:
        out.append(cited("technical-depth", f'Public repository "{name}" - {description}',
                         f"repository description: {description}", url, label, flagged))
        count += 1
    language = str(repo.get("language") or "").strip()
    if language:
        out.append(inferred("technical-depth", f"Hands-on familiarity with {language}",
                            f"GitHub reports {language} as the primary language of {name}",
                            url, label))
        count += 1
    topics = [str(t).strip() for t in (repo.get("topics") or []) if str(t).strip()]
    for topic in topics[:MAX_TOPICS_PER_REPO]:
        out.append(inferred("technical-depth", f"Domain exposure: {topic.replace('-', ' ')}",
                            f"{name} is tagged with the topic '{topic}'", url, label))
        count += 1
    return count


def _readme_signals(user: str, repo: dict, reader, out):
    """Signals from one repo's README. -> (count, failure reason, url, gate)."""
    name = str(repo.get("name") or "").strip()
    branch = str(repo.get("default_branch") or "HEAD").strip() or "HEAD"
    label = f"GitHub - {user}/{name} (README)"
    last_reason = ""
    for filename in README_NAMES:
        url = f"https://raw.githubusercontent.com/{user}/{name}/{branch}/{filename}"
        read = reader(url, "text")
        if not read.ok:
            last_reason = read.reason
            continue
        count = 0
        gate = (url, read.verdict, read.flagged)
        summary = _readme_summary(read.text)
        if summary:
            clean, flagged = clean_prose(summary)
            if clean:
                out.append(cited("technical-depth", f'Project "{name}": {clean}',
                                 clean, url, label, flagged or read.flagged))
                count += 1
        found = 0
        for pattern, term in TECH_PATTERNS:
            if found >= MAX_TERMS_PER_README:
                break
            match = pattern.search(read.text)
            if not match:
                continue
            line = next((ln.strip() for ln in read.text.splitlines()
                         if pattern.search(ln) and not is_instruction_like(ln)),
                        match.group(0))
            quote, flagged = clean_prose(line)
            out.append(inferred("technical-depth", f"Working familiarity with {term}",
                                f"the {name} README mentions it: {quote}", url, label,
                                flagged or read.flagged))
            found += 1
            count += 1
        return count, "", gate
    return 0, last_reason or "no README found", (url, "", False)


def scan(user: str, *, reader=read_url, max_readmes: int = MAX_READMES):
    """Scan one GitHub user. -> (signals, reports, needs_review notes)."""
    signals: list = []
    reports: list = []
    needs_review: list = []

    profile_url = f"{API}/users/{user}"
    data, read = _get_json(profile_url, reader)
    if data is None:
        reports.append(SourceReport("github", f"github.com/{user}", "skipped",
                                    reason=read.reason or "profile unreadable"))
        return signals, reports, needs_review
    page_url = str(data.get("html_url") or f"https://github.com/{user}")
    label = f"GitHub - {user}"
    count = 0
    bio, flagged = clean_prose(str(data.get("bio") or ""))
    if bio:
        category = "strategic-leadership" if EXEC_WORDS.search(bio) else "technical-depth"
        signals.append(cited(category, f"GitHub bio: {bio}", bio, page_url, label,
                             flagged or read.flagged))
        count += 1
    company, company_flagged = clean_prose(str(data.get("company") or ""))
    if company:
        signals.append(cited("strategic-leadership", f"GitHub profile lists affiliation: {company}",
                             f"profile company field: {company}", page_url, label,
                             company_flagged or read.flagged))
        count += 1
    public_repos = data.get("public_repos")
    if isinstance(public_repos, int):
        signals.append(cited("technical-depth",
                             f"{public_repos} public repositories on GitHub",
                             f"GitHub profile reports public_repos = {public_repos}",
                             page_url, label, read.flagged))
        count += 1
    reports.append(SourceReport("github", page_url, "scanned", count,
                                verdict=read.verdict, flagged=read.flagged))

    repos, failures, truncated, (repos_verdict, repos_flagged) = fetch_repos(user, reader)
    for url, reason in failures:
        reports.append(SourceReport("github", url, "skipped", reason=reason))
    if truncated:
        needs_review.append(
            f"GitHub: stopped after {MAX_REPO_PAGES * REPOS_PER_PAGE} repositories; "
            "re-run with a narrower source list if this account has more.")

    own = [r for r in repos if not r.get("fork") and not r.get("archived")]
    skipped_forks = len(repos) - len(own)
    if skipped_forks:
        needs_review.append(
            f"GitHub: {skipped_forks} fork(s) or archived repo(s) were not scanned - "
            "the original /expand skips uncustomised forks as competency evidence too.")
    for repo in own:
        repo_signals: list = []
        found = _repo_signals(user, repo, repo_signals)
        reports.append(SourceReport("github", repo.get("html_url") or f"github.com/{user}/{repo.get('name')}",
                                    "scanned", found, verdict=repos_verdict, flagged=repos_flagged))
        signals.extend(repo_signals)

    for repo in own[:max_readmes]:
        readme_signals: list = []
        found, reason, (readme_url, verdict, flagged) = _readme_signals(
            user, repo, reader, readme_signals)
        signals.extend(readme_signals)
        if reason:
            reports.append(SourceReport(
                "github", f"{repo.get('html_url') or repo.get('name')} (README)", "skipped", reason=reason))
        else:
            reports.append(SourceReport("github", readme_url, "scanned", found,
                                        verdict=verdict, flagged=flagged))
    if len(own) > max_readmes:
        needs_review.append(
            f"GitHub: READMEs were read for the {max_readmes} most recently updated repositories "
            f"of {len(own)}; the rest are listed above from their metadata only.")
    return signals, reports, needs_review
