"""Offline HTML dashboard of the jobseek pipeline (tracker + ranked postings).

Ported from ai-job-search's /html-report; see jobseek/NOTICE.
"""

from .build import build_dashboard, collect, default_output_path, render_html, write_dashboard

__all__ = ["build_dashboard", "collect", "default_output_path", "render_html", "write_dashboard"]
