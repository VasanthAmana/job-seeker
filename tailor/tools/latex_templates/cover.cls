%% cover.cls - a short, single-page "why-me" note class.
%%
%% Reimplemented from ai-job-search's cover.cls (MIT, see jobseek/NOTICE):
%% a minimal letter-shaped class for a 3-line outreach note, not a full
%% formal cover letter - no date block, no "Dear Hiring Manager" boilerplate,
%% just a clean header and the note body so it reads well as a one-page PDF
%% a recruiter opens alongside the resume.
\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{cover}[2026/01/01 jobseek why-me note class]
\LoadClass[11pt]{article}

\RequirePackage[margin=1in]{geometry}
\RequirePackage[utf8]{inputenc}
\RequirePackage{parskip}
\RequirePackage{hyperref}
\pagestyle{empty}

\newcommand{\sendername}[1]{\def\@sendername{#1}}
\newcommand{\senderemail}[1]{\def\@senderemail{#1}}
\newcommand{\senderphone}[1]{\def\@senderphone{#1}}
\newcommand{\recipientrole}[1]{\def\@recipientrole{#1}}
\newcommand{\recipientcompany}[1]{\def\@recipientcompany{#1}}

\def\@sendername{}
\def\@senderemail{}
\def\@senderphone{}
\def\@recipientrole{}
\def\@recipientcompany{}

\newcommand{\coverheader}{%
  {\large\bfseries\@sendername}\par
  \@senderemail\ \textbar\ \@senderphone\par
  \bigskip
  Re: \@recipientrole\ at \@recipientcompany\par
  \medskip
}

\newenvironment{whyme}{\coverheader}{}
