/**
 * Migration 1: every table the basic components need (design 5.2).
 *
 * JSON columns hold documents as text. Timestamps are ISO 8601 UTC strings.
 * Later phases add tables (research, templates, resumes, LinkedIn profile
 * edits) in their own migrations.
 */
export const sql = `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);
CREATE INDEX events_type ON events(type);

CREATE TABLE profile_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('resume_pdf','resume_docx','resume_latex','resume_text','free_text','linkedin_profile','public_page','user_statement')),
  title TEXT,
  sha256 TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  extracted_text TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE UNIQUE INDEX profile_sources_kind_sha ON profile_sources(kind, sha256);

CREATE TABLE profile_versions (
  version INTEGER PRIMARY KEY,
  parent INTEGER REFERENCES profile_versions(version),
  document TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by IN ('user','assistant','ai_adapter','import')),
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('criteria_change','linkedin_profile_edit')),
  subject_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','superseded','expired')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT,
  decided_by TEXT,
  channel TEXT CHECK (channel IS NULL OR channel IN ('chat','cli','mcp_elicitation')),
  user_words TEXT,
  decided_at TEXT
);
CREATE INDEX approvals_status ON approvals(status);

CREATE TABLE criteria_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL
);

CREATE TABLE criteria_changes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('create','modify','archive')),
  target TEXT,
  proposed TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  approval_id TEXT REFERENCES approvals(id),
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','superseded')),
  created_at TEXT NOT NULL
);

CREATE TABLE criteria_versions (
  set_id TEXT NOT NULL REFERENCES criteria_sets(id),
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  change_id TEXT NOT NULL REFERENCES criteria_changes(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (set_id, version)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  canonical_url TEXT,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  title_norm TEXT NOT NULL,
  company_norm TEXT NOT NULL,
  location TEXT,
  workplace TEXT CHECK (workplace IS NULL OR workplace IN ('onsite','hybrid','remote')),
  salary TEXT,
  seniority TEXT,
  description TEXT,
  description_guard TEXT,
  partial INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  posted_at TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','skipped','unreachable','expired')),
  expired_reason TEXT,
  fetch_attempts INTEGER,
  first_unreachable TEXT,
  last_fetch_error TEXT
);
CREATE INDEX jobs_canonical_url ON jobs(canonical_url);
CREATE INDEX jobs_pair ON jobs(company_norm, title_norm);
CREATE INDEX jobs_status ON jobs(status);

CREATE TABLE job_sightings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  connector TEXT NOT NULL,
  binding_id TEXT,
  external_id TEXT,
  raw_url TEXT,
  run_id TEXT,
  criteria_set_id TEXT,
  record TEXT NOT NULL,
  seen_at TEXT NOT NULL
);
CREATE INDEX job_sightings_job ON job_sightings(job_id);

CREATE TABLE job_features (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  skills TEXT NOT NULL DEFAULT '[]',
  normalised_title TEXT,
  certifications TEXT NOT NULL DEFAULT '[]',
  salary TEXT
);

CREATE TABLE job_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  profile_version INTEGER,
  criteria_version TEXT,
  method TEXT NOT NULL CHECK (method IN ('rule','assistant','ai_review')),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  band TEXT NOT NULL,
  gates TEXT NOT NULL DEFAULT '{}',
  vetoed INTEGER NOT NULL DEFAULT 0,
  dimensions TEXT NOT NULL DEFAULT '{}',
  reason TEXT,
  strengths TEXT NOT NULL DEFAULT '[]',
  gaps TEXT NOT NULL DEFAULT '[]',
  guard TEXT,
  basis TEXT,
  scored_at TEXT NOT NULL
);
CREATE INDEX job_scores_job ON job_scores(job_id, method, id);

CREATE TABLE applications (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  state TEXT NOT NULL CHECK (state IN ('found','shortlisted','resume_prepared','applied','interview','offer','rejected')),
  resume_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE application_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  at TEXT NOT NULL,
  reported_by TEXT NOT NULL,
  channel TEXT NOT NULL,
  note TEXT
);
CREATE INDEX application_events_job ON application_events(job_id, id);

CREATE TABLE connector_bindings (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  connector_version TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  secret_refs TEXT NOT NULL DEFAULT '[]',
  health TEXT NOT NULL CHECK (health IN ('ok','degraded','needs_human','auth_expired','failing','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('search','alerts','research','match_review','maintenance')),
  targets TEXT NOT NULL DEFAULT '[]',
  schedule TEXT NOT NULL,
  time_zone TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  trigger TEXT NOT NULL,
  schedule_id TEXT REFERENCES schedules(id),
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_for_human','succeeded','partial','failed','cancelled')),
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  report_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  connector TEXT NOT NULL,
  binding_id TEXT,
  criteria_set_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_for_human','succeeded','needs_human','skipped','failed','cancelled')),
  reason TEXT,
  cursor TEXT,
  counts TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE human_steps (
  id TEXT PRIMARY KEY,
  binding_id TEXT,
  compartment TEXT,
  run_step_id TEXT REFERENCES run_steps(id),
  reason TEXT NOT NULL,
  detail TEXT,
  open_what TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  notified_at TEXT,
  resolved_at TEXT,
  resolution TEXT
);

CREATE TABLE ai_calls (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  backend TEXT NOT NULL,
  model TEXT,
  input_refs TEXT NOT NULL DEFAULT '[]',
  prompt_sha256 TEXT,
  output TEXT,
  validation TEXT,
  duration_ms INTEGER,
  status TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE secret_refs (
  name TEXT PRIMARY KEY,
  backend TEXT NOT NULL CHECK (backend IN ('keychain','file')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE legacy_imports (
  kind TEXT NOT NULL CHECK (kind IN ('seen_job','tracker_row','shortlist')),
  legacy_key TEXT NOT NULL,
  job_id TEXT REFERENCES jobs(id),
  imported_at TEXT NOT NULL,
  PRIMARY KEY (kind, legacy_key)
);
`;
