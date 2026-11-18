# job-seeker

A single-user job-search engine that runs on your own machine and works alongside the AI assistant you already use (Claude Desktop, Codex or any MCP client).

Like the Seeker chasing the golden snitch, it keeps looking for the right job in the background. It brings back ranked matches, market research and a tailored resume for each role you choose.

## Design principle

You already have an AI assistant, so job-seeker does not rebuild what it does well: chat, cover letters, general writing, or filling in application forms.
Instead it supplies what an assistant lacks:

- **Saved state:** your profile, search criteria, jobs seen and applications.
- **Connectors:** official APIs first, a browser where there is no API, and logged-in sessions that persist.
- **Unattended runs:** scheduled searches and reports that work with no assistant connected.
- **Research data:** structured, evidence-backed information about what the market wants for your profile.
- **Resumes:** high-quality output from LaTeX templates.

Everything is exposed to your assistant over MCP, so the assistant does the judgement and job-seeker keeps the record.

## What it will do

- **Profile:** builds your profile from a resume, a written description or your LinkedIn profile, and traces every skill to its source.
- **Search:** searches with saved criteria across connectors, removes duplicates and ranks the results against your profile.
- **Connectors:** LinkedIn, Naukri, iimjobs, ExecThread, Adzuna, Built In and more.
- **Browser sessions:** one saved profile per site that runs headless. It opens a window only when a captcha or login needs you, then carries on headless.
- **Research:** suggests the skills, roles and markets in demand for your profile.
- **Criteria changes:** proposes new search criteria from that research, and applies them only after you approve.
- **Resumes:** tailors a resume to each job from several LaTeX templates, without ever inventing experience.
- **Applications:** your assistant submits them, and job-seeker prepares the resume and tracks the application's progress.
- **Schedules and reports:** runs and reports on a schedule you set.
- **MCP server:** the main way in, so you can do the whole flow from your assistant.

## Scope

- **One person per installation:** no accounts, roles or sharing.
- **Local:** data, credentials and browser profiles stay on your machine.
- **Site rules:** it respects each site's terms and rate limits, and a captcha is always left to a person.

## Status

Early design. The design document and a phased build plan come first, then the code.
