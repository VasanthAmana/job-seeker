"""The source registry: the one place a jobseek alert channel is registered.

Fixes F3 (jobseek-cc-flow scout report, section 3.2): `alert_state.py`,
`alert-sources.json` and `run-alerts.md` used to each hard-code their own
copy of the same closed set of source ids (linkedin, indeed, ladders,
employer, other), so adding a portal meant editing code in three places.
Now all three read `SOURCE_IDS` / `REGISTRY` from here.

This is deliberately a small subset of the full per-portal manifest the
report's section 3.2 designs for onboarding *new* portals (each with its own
`sources/<id>/` directory, fixtures and tests) - it only has to
describe the five sources jobseek already knows about, with their existing
behaviour unchanged. Adding a new portal is future work.
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Source:
    id: str
    name: str
    senders: tuple[str, ...] = field(default=())
    posting_host_patterns: tuple[str, ...] = field(default=())


_SOURCES = (
    Source(
        id="linkedin",
        name="LinkedIn job alerts (e-mail)",
        senders=(
            "jobs-noreply@linkedin.com",
            "jobalerts-noreply@linkedin.com",
            "messages-noreply@linkedin.com",
        ),
        posting_host_patterns=("linkedin.com/jobs", "linkedin.com/comm/jobs"),
    ),
    Source(
        id="indeed",
        name="Indeed job alerts (e-mail)",
        senders=("alert@indeed.com", "noreply@indeed.com"),
        posting_host_patterns=(
            "indeed.com/viewjob",
            "indeed.com/rc/clk",
            "click.indeed.com",
            "indeed.com/pagead",
        ),
    ),
    Source(
        id="ladders",
        name="The Ladders job alerts (e-mail)",
        senders=("alerts@theladders.com", "noreply@theladders.com"),
        posting_host_patterns=("theladders.com/job",),
    ),
    Source(
        id="employer",
        name="Employer career-site / ATS notifications (e-mail)",
        posting_host_patterns=(
            "greenhouse.io",
            "lever.co",
            "myworkdayjobs.com",
            "icims.com",
            "smartrecruiters.com",
            "ashbyhq.com",
            "workable.com",
            "taleo.net",
            "successfactors.com",
            "brassring.com",
            "ultipro.com",
            "eightfold.ai",
            "phenompeople.com",
        ),
    ),
    Source(
        id="christiantechjobs",
        name="ChristianTechJobs RSS feed (public, no sign-up)",
    ),
    Source(
        id="other",
        name="Unclassified posting link",
    ),
)

REGISTRY = {source.id: source for source in _SOURCES}
SOURCE_IDS = tuple(REGISTRY)


def is_registered(source_id: str) -> bool:
    return source_id in REGISTRY


def merge_email_sections(config: dict) -> dict:
    """Overlay registered sources' `senders` / `posting_host_patterns` under
    whatever a loaded `alert-sources.json`-shaped dict already supplies, so
    the config file need not repeat what the registry already knows, but a
    per-source entry already in the file still wins (a true override, not a
    deep merge of each source's list)."""
    senders = {sid: list(src.senders) for sid, src in REGISTRY.items() if src.senders}
    senders.update(config.get("senders") or {})
    patterns = {sid: list(src.posting_host_patterns) for sid, src in REGISTRY.items() if src.posting_host_patterns}
    patterns.update(config.get("posting_host_patterns") or {})
    merged = dict(config)
    merged["senders"] = senders
    merged["posting_host_patterns"] = patterns
    return merged
