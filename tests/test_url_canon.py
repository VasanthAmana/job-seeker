"""Posting URL canonicalisation: tracking params dropped, identity kept."""

from url_canon import canonicalize_url


def test_lowercases_scheme_and_host():
    assert canonicalize_url("HTTPS://Example.COM/Jobs/1") == "https://example.com/Jobs/1"


def test_drops_fragment_and_trailing_slash():
    assert canonicalize_url("https://example.com/jobs/1/#apply") == "https://example.com/jobs/1"


def test_drops_utm_and_generic_tracking_params():
    url = "https://example.com/jobs/1?utm_source=linkedin&utm_campaign=x&trk=abc&refId=9"
    assert canonicalize_url(url) == "https://example.com/jobs/1"


def test_two_linkedin_links_with_different_tracking_canonicalise_equal():
    a = "https://www.linkedin.com/jobs/view/123?currentJobId=123&trk=flagship3_search&trkEmail=abc"
    b = "https://www.linkedin.com/jobs/view/123?trk=nav_responsive&midToken=xyz&currentJobId=123"
    assert canonicalize_url(a) == canonicalize_url(b)


def test_linkedin_current_job_id_is_kept():
    assert "currentJobId=123" in canonicalize_url("https://www.linkedin.com/jobs/view/123?currentJobId=123")


def test_indeed_jk_is_kept_but_tk_and_from_are_dropped():
    url = "https://www.indeed.com/viewjob?jk=abc123&tk=xyz&from=serp&cmp=co"
    assert canonicalize_url(url) == "https://www.indeed.com/viewjob?jk=abc123"


def test_two_indeed_links_with_different_tracking_canonicalise_equal():
    a = "https://www.indeed.com/viewjob?jk=abc123&tk=one&from=serp"
    b = "https://www.indeed.com/viewjob?jk=abc123&tk=two&from=email&alid=9"
    assert canonicalize_url(a) == canonicalize_url(b)


def test_non_tracking_query_params_are_kept():
    assert canonicalize_url("https://example.com/jobs/1?lang=en") == "https://example.com/jobs/1?lang=en"


def test_empty_url_does_not_raise():
    assert canonicalize_url("") == ""
