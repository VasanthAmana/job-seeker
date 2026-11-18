"""Offline test rig for expand.

No test here touches the network. Every read goes through the real
`read_source.read_url()` - and therefore the real `page_decode` and
`posting_guard` - with a `fetcher` that serves a saved fixture file instead
of running `fetch_page.py`. That keeps the integrity gate under test rather
than stubbed: a fixture carrying a hidden-instruction payload has to be
caught by `posting_guard.py` itself, not by a weaker check written here.
"""

import sys
from pathlib import Path

EXPAND_TOOLS = Path(__file__).resolve().parent.parent / "tools"
JOBSEEK_ROOT = EXPAND_TOOLS.parent.parent
for path in (str(EXPAND_TOOLS), str(JOBSEEK_ROOT / "tools"), str(JOBSEEK_ROOT / "mcp")):
    if path not in sys.path:
        sys.path.insert(0, path)

FIXTURES = Path(__file__).resolve().parent / "fixtures"

import read_source  # noqa: E402

ROBOTS_REFUSAL = (
    "DISALLOWED for * - do not retry, go to step 3\n"
    "fetch_page: refused - robots.txt does not permit this path, so the browser-header "
    "retry does not run."
)


def fixture_reader(pages, *, unknown="robots"):
    """A `read_url`-shaped callable serving `pages` (url -> fixture filename).

    A URL that is not in the map comes back the way an unreachable source
    does: `unknown="robots"` for a robots.txt refusal, `"error"` for a
    transport failure. Both exercise the real skipped-source path.
    """
    def fetcher(url, out):
        name = pages.get(url)
        if name is None:
            if unknown == "error":
                return 2, "fetch_page: RuntimeError: curl exit 6: could not resolve host"
            return 1, ROBOTS_REFUSAL
        out.write_bytes((FIXTURES / name).read_bytes())
        return 0, "ALLOWED - robots.txt permits this path\nHTTP 200 size=1024"

    def reader(url, mode="html"):
        return read_source.read_url(url, mode, fetcher=fetcher)

    return reader


GITHUB_USER = "https://api.github.com/users/dokonkwo"
GITHUB_REPOS = ("https://api.github.com/users/dokonkwo/repos"
                "?per_page=100&page=1&type=owner&sort=updated")
GITHUB_PAGES = {
    GITHUB_USER: "github_user.json",
    GITHUB_REPOS: "github_repos.json",
    "https://raw.githubusercontent.com/dokonkwo/aurora-ledger/main/README.md":
        "github_readme_aurora.md",
    "https://raw.githubusercontent.com/dokonkwo/governance-playbook/main/README.md":
        "github_readme_injection.md",
}
SCHOLAR_URL = "https://scholar.example-test.invalid/citations?user=DANA123"
PRESS_URL = "https://news.example-test.invalid/dana-okonkwo-ai-strategy"
TALKS_URL = "https://summit.example-test.invalid/speakers/dana-okonkwo"
LINKEDIN_URL = "https://www.linkedin.com/in/dana-okonkwo/"

ALL_PAGES = {
    **GITHUB_PAGES,
    SCHOLAR_URL: "scholar_profile.html",
    PRESS_URL: "press_injection.html",
    TALKS_URL: "talks_page.html",
}
