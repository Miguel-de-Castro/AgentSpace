-- AgentSpace SQLite schema.
-- Source of truth for this file is docs/07-SCHEMA_API_CONTRACT.md — keep them in sync.
-- Do not hand-edit a deployed database; add a new migration file instead once
-- there's more than one of these (v1 ships with a single init script).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT 'My Workspace',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  name              TEXT NOT NULL,
  repo_path         TEXT NOT NULL UNIQUE,
  default_branch    TEXT NOT NULL,
  branch_protection TEXT NOT NULL, -- JSON: { protected_branches: string[], source: "detected"|"implicit-fallback" }
  team_roster       TEXT NOT NULL, -- JSON: [{ role: string, enabled: boolean }]
  origin_kind       TEXT NOT NULL DEFAULT 'local', -- .claude/plans/19-clone-git-repository.md: 'local'|'cloned'
  clone_url         TEXT, -- .claude/plans/19-clone-git-repository.md: source URL when origin_kind='cloned'
  routine_exclusions TEXT, -- plan 24 item 2: JSON string[] of ideas the supervisor said never to propose again
  run_command       TEXT, -- plan 25: how to start the app; NULL = detect from package.json
  install_command   TEXT, -- plan 25: NULL = detect
  preview_port      INTEGER, -- plan 25: fixed port for apps that ignore PORT; NULL = pick a free one
  weekly_budget_usd REAL, -- .claude/plans/24-ideias-para-analisar.md item 7: optional soft cap, NULL = off
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS missions (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id),
  brief                   TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN (
                            'proposed', 'queued', 'running', 'awaiting-approval', 'waiting',
                            'completed', 'rejected', 'failed', 'cancelled'
                          )),
  assigned_team           TEXT NOT NULL, -- JSON: [{ role: string, ... }]
  reference_material      TEXT,          -- JSON, nullable
  proposed_by_mission_id  TEXT REFERENCES missions(id),
  iterate_count           INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- .claude/plans/20-plano-consolidado.md Phase 3 (D1): why a 'waiting' Mission is
  -- waiting, and (usage-limit only) when AgentSpace will try to resume it.
  waiting_reason          TEXT CHECK (waiting_reason IN ('usage-limit', 'needs-input', 'plan-review')),
  resume_at               TEXT,
  -- Phase 3.3: run only the Planner first and wait for the supervisor's OK.
  plan_checkpoint         INTEGER NOT NULL DEFAULT 0,
  -- Phase 3.3: the plan the supervisor approved; later roles build from it.
  approved_plan           TEXT,
  -- Phase 4: JSON [{ text, source: 'user' | 'planner' }].
  acceptance_criteria     TEXT,
  -- Phase 7.7 (21-L): a stacked Mission starts from another Mission's branch.
  base_mission_id         TEXT REFERENCES missions(id),
  base_branch             TEXT,
  CHECK ((status = 'waiting') = (waiting_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_missions_project_status ON missions(project_id, status);

CREATE TABLE IF NOT EXISTS executions (
  id             TEXT PRIMARY KEY,
  mission_id     TEXT NOT NULL REFERENCES missions(id),
  seq            INTEGER NOT NULL,
  trigger        TEXT NOT NULL CHECK (trigger IN (
                   'initial', 'resume-after-approval', 'iterate', 'retry-after-failure',
                   'resume-after-limit', 'resume-after-input'
                 )),
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  outcome        TEXT CHECK (outcome IN ('success', 'failure', 'interrupted')),
  git_before_sha TEXT NOT NULL,
  git_after_sha  TEXT,
  worktree_path  TEXT NOT NULL,
  branch_name    TEXT, -- .claude/plans/completed/13-real-merge-on-approval.md; nullable for rows predating it
  provider       TEXT, -- .claude/plans/18-mock-provider-safety-and-prod-start.md: 'claude-code'|'mock'; nullable for rows predating it
  -- .claude/plans/20-plano-consolidado.md item 1.6: set once the Execution ends.
  cost_usd       REAL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  duration_ms    INTEGER,
  UNIQUE(mission_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_executions_mission ON executions(mission_id);

-- .claude/plans/20-plano-consolidado.md Phase 3 — the provider session each
-- role's invocation ran in, so a later Execution (resume after a usage limit,
-- after an answer, or an adjustment) can continue it with --resume instead of
-- starting cold. Provider-agnostic on purpose (D6: Codex later).
CREATE TABLE IF NOT EXISTS execution_role_sessions (
  execution_id TEXT NOT NULL REFERENCES executions(id),
  role         TEXT NOT NULL, -- Team Member role, or '' for a team-less flattened run
  provider     TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  completed    INTEGER NOT NULL DEFAULT 0, -- 1 when this role's invocation finished normally
  PRIMARY KEY (execution_id, role)
);

CREATE TABLE IF NOT EXISTS evidence (
  id           TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL, -- JSON, normalized shape per `type`
  occurred_at  TEXT NOT NULL,
  team_member_role TEXT, -- .claude/plans/completed/14-real-multi-agent-execution.md; null when not attributable to one role
  UNIQUE(execution_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_evidence_execution ON evidence(execution_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id           TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  kind         TEXT NOT NULL CHECK (kind IN ('diff', 'new_file', 'document', 'test_report')),
  title        TEXT NOT NULL,
  content_ref  TEXT NOT NULL,
  summary      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_artifacts_execution ON artifacts(execution_id);

CREATE TABLE IF NOT EXISTS reviews (
  id                        TEXT PRIMARY KEY,
  mission_id                TEXT NOT NULL REFERENCES missions(id),
  author_type               TEXT NOT NULL CHECK (author_type IN ('human', 'ai_team_member')),
  author_role               TEXT,
  recommendation_outcome    TEXT NOT NULL CHECK (recommendation_outcome IN ('approve', 'iterate', 'reject-suggested')),
  recommendation_rationale  TEXT NOT NULL,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_reviews_mission ON reviews(mission_id);

CREATE TABLE IF NOT EXISTS review_artifacts (
  review_id   TEXT NOT NULL REFERENCES reviews(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  PRIMARY KEY (review_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS findings (
  id           TEXT PRIMARY KEY,
  review_id    TEXT NOT NULL REFERENCES reviews(id),
  artifact_id  TEXT NOT NULL REFERENCES artifacts(id),
  evidence_id  TEXT REFERENCES evidence(id),
  text         TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocking')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_findings_review ON findings(review_id);

CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,
  mission_id   TEXT NOT NULL REFERENCES missions(id),
  tier         TEXT NOT NULL CHECK (tier IN ('binding', 'lightweight', 'plan')),
  outcome      TEXT NOT NULL,
  rationale    TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (tier = 'binding'     AND outcome IN ('approved', 'rejected'))
    OR
    (tier = 'lightweight' AND outcome IN ('acknowledged-good', 'acknowledged-not-wanted', 'flag-for-later'))
    OR
    -- .claude/plans/20-plano-consolidado.md Phase 3.3 — the supervisor's call on
    -- a plan checkpoint. Never counted in the Trust Ledger (binding only).
    (tier = 'plan'        AND outcome IN ('plan-approved', 'plan-revised', 'plan-discarded'))
  )
);

CREATE INDEX IF NOT EXISTS idx_decisions_mission ON decisions(mission_id);
CREATE INDEX IF NOT EXISTS idx_decisions_tier_outcome ON decisions(tier, outcome);

CREATE TABLE IF NOT EXISTS mission_graph_edges (
  id         TEXT PRIMARY KEY,
  edge_type  TEXT NOT NULL CHECK (edge_type IN ('triggered-by', 'informed-by', 'superseded-by')),
  from_kind  TEXT NOT NULL CHECK (from_kind IN ('mission', 'decision', 'review')),
  from_id    TEXT NOT NULL,
  to_kind    TEXT NOT NULL CHECK (to_kind IN ('mission', 'review', 'artifact')),
  to_id      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON mission_graph_edges(from_kind, from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON mission_graph_edges(to_kind, to_id);

-- .claude/plans/04-usage-rate-limit.md — the most recent `rate_limit_event`
-- observed from the provider's stream-json output. Deliberately a single
-- operational-state row, not an Evidence/domain record: it answers "how much
-- of the subscription's rate-limit window is left right now," which is
-- superseded wholesale by the next event, not an immutable fact worth
-- keeping history of the way Evidence and Artifacts are.
CREATE TABLE IF NOT EXISTS provider_rate_limit_state (
  id                 TEXT PRIMARY KEY DEFAULT 'singleton',
  status             TEXT NOT NULL,    -- verbatim from the provider, e.g. 'allowed' | 'rejected'
  rate_limit_type    TEXT,             -- e.g. 'five_hour'
  resets_at          INTEGER,          -- unix seconds, verbatim from the provider
  is_using_overage   INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL
);
-- projects.github_token (.claude/plans/completed/05-checks-approval-gate.md)
-- and projects.permission_policy (.claude/plans/project-permission-policy.md)
-- are added via guarded migrations in db/client.ts, not here — this build's
-- SQLite doesn't support `ADD COLUMN IF NOT EXISTS`, and CREATE TABLE IF NOT
-- EXISTS above is a no-op against an already-existing projects table, so
-- each column needs its own idempotency check in JS.

-- Phase 7.7 (21-N): a routine only ever PROPOSES Missions (status 'proposed');
-- nothing it finds starts work without the supervisor's OK.
CREATE TABLE IF NOT EXISTS routines (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  name         TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  cadence      TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  enabled      INTEGER NOT NULL DEFAULT 0,
  last_run_at  TEXT,
  last_summary TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_routines_project ON routines(project_id);

-- Plan 25: values the supervisor gave for a Project's .env.example, used only to
-- write the .env of a "Run". Local to this machine, same posture as the GitHub
-- token; never sent to the team, Evidence, prompts or list responses.
CREATE TABLE IF NOT EXISTS project_env (
  project_id TEXT NOT NULL REFERENCES projects(id),
  name       TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (project_id, name)
);
