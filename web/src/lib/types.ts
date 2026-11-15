// Mirrors ../../../src/domain/types.ts exactly (a separate npm project can't import
// it directly). Canonical vocabulary is docs/20-UBIQUITOUS_LANGUAGE.md — do not
// introduce a synonym here ("Task", "Agent") that document forbids.

export type MissionStatus =
  | "proposed"
  | "queued"
  | "running"
  | "awaiting-approval"
  | "waiting"
  | "completed"
  | "rejected"
  | "failed"
  | "cancelled";

export type ExecutionTrigger =
  | "initial"
  | "resume-after-approval"
  | "iterate"
  | "retry-after-failure"
  | "resume-after-limit"
  | "resume-after-input";

// .claude/plans/20-plano-consolidado.md Phase 3 — why a Mission is 'waiting'.
export type WaitingReason = "usage-limit" | "needs-input" | "plan-review";
export type ExecutionOutcome = "success" | "failure" | "interrupted";

// .claude/plans/18-mock-provider-safety-and-prod-start.md — which Provider
// Adapter ran an Execution; surfaced so a simulation never looks like real work.
export type ProviderName = "claude-code" | "mock";

export type ArtifactKind = "diff" | "new_file" | "document" | "test_report";

export type ReviewAuthorType = "human" | "ai_team_member";
export type RecommendationOutcome = "approve" | "iterate" | "reject-suggested";

export type FindingSeverity = "info" | "warning" | "blocking";

export type DecisionTier = "binding" | "lightweight" | "plan";
export type BindingOutcome = "approved" | "rejected";
export type PlanOutcome = "plan-approved" | "plan-revised" | "plan-discarded";
export type LightweightOutcome = "acknowledged-good" | "acknowledged-not-wanted" | "flag-for-later";
export type DecisionOutcome = BindingOutcome | LightweightOutcome | PlanOutcome;

// .claude/plans/20-plano-consolidado.md Phase 4 — mirrors src/domain/types.ts.
export interface AcceptanceCriterion {
  text: string;
  source: "user" | "planner";
}

// Phase 3 — mirrors WaitingDetails in src/execution-engine/index.ts.
export interface WaitingDetails {
  reason: WaitingReason;
  resume_at: string | null;
  question?: string;
  role?: string;
  plan?: string;
  files?: string[];
}

export type EdgeType = "triggered-by" | "informed-by" | "superseded-by";
export type EdgeNodeKind = "mission" | "decision" | "review" | "artifact";

export interface TeamRosterEntry {
  role: string;
  enabled: boolean;
}

export interface AssignedTeamEntry {
  role: string;
}

export interface BranchProtection {
  protected_branches: string[];
  source: "detected" | "implicit-fallback";
}

// .claude/plans/project-permission-policy.md
export type PermissionMode = "read-only" | "can-edit" | "can-edit-and-run" | "custom";

export interface PermissionPolicy {
  mode: PermissionMode;
  allowed_tools?: string[];
  disallowed_tools?: string[];
}

// .claude/plans/19-clone-git-repository.md — 'local' = a path the user already
// had; 'cloned' = AgentSpace cloned it into a managed dir (removable).
export type ProjectOriginKind = "local" | "cloned" | "cached";

// Plan 25 - "Run": the app launched from a Project (or one of its Missions).
export type PreviewState = "installing" | "starting" | "running" | "failed" | "stopped";

export interface PreviewInfo {
  project_id: string;
  mission_id: string | null;
  state: PreviewState;
  port: number | null;
  url: string | null;
  folder: string;
  folder_kind: "mission-live" | "mission-branch" | "project";
  error: string | null;
  logs: string[];
  started_at: string;
}

/** A variable of the repo's .env.example that "Run" needs a value for. */
export interface NeedsEnvVar {
  name: string;
  default: string;
  comment: string | null;
  secret: boolean;
}

export interface RunConfigVar extends NeedsEnvVar {
  has_value: boolean;
  /** Null for a masked (secret) variable: its value is never sent back. */
  value: string | null;
}

export interface RunConfig {
  detected: { install: string | null; run: string | null };
  vars: RunConfigVar[];
}

export interface BudgetStatus {
  limit_usd: number | null;
  spent_usd: number;
  reached: boolean;
  window_days: number;
}

export interface Project {
  id: string;
  workspace_id: string;
  name: string;
  repo_path: string;
  default_branch: string;
  branch_protection: BranchProtection;
  team_roster: TeamRosterEntry[];
  permission_policy: PermissionPolicy;
  /** Phase 6 — automatic correction round on blocking findings / unmet criteria. */
  auto_fix_loop: boolean;
  /** Phase 7.1 — added to AgentSpace's role instructions, never replacing them. */
  instructions: string | null;
  role_instructions: Record<string, string>;
  /** Plan 24 item 7 — optional weekly cost ceiling (API-equivalent USD); null = off. */
  weekly_budget_usd: number | null;
  /** Plan 24 item 2 — ideas routines must not propose again. */
  routine_exclusions: string[];
  /** Plan 25 - how "Run" starts the app; null = detect from package.json. */
  run_command: string | null;
  install_command: string | null;
  preview_port: number | null;
  origin_kind: ProjectOriginKind;
  clone_url: string | null;
  created_at: string;
  /** Computed server-side: false when repo_path no longer exists on disk (folder moved/deleted). */
  repo_available: boolean;
  // Only present on the list endpoint (src/mission-engine/projects.ts's
  // listProjects) — a per-Project count of Missions in 'proposed' or
  // 'awaiting-approval' state, computed server-side so no screen needs to
  // fetch every Mission just to answer "does this need me."
  needs_attention_count?: number;
}

export interface Mission {
  id: string;
  project_id: string;
  brief: string;
  status: MissionStatus;
  display_status: string;
  assigned_team: AssignedTeamEntry[];
  reference_material: unknown | null;
  proposed_by_mission_id: string | null;
  iterate_count: number;
  created_at: string;
  updated_at: string;
  /** Set iff status === 'waiting'. */
  waiting_reason: WaitingReason | null;
  /** usage-limit only: when AgentSpace will try to resume (ISO). */
  resume_at: string | null;
  /** Phase 3.3: run the Planner alone first and wait for the supervisor's OK. */
  plan_checkpoint: boolean;
  approved_plan: string | null;
  /** Phase 4: what "done" means for this Mission. */
  acceptance_criteria: AcceptanceCriterion[];
  /** Phase 7.7: the Mission whose branch this one builds on, if any. */
  base_mission_id: string | null;
  base_branch: string | null;
}

export type RoutineCadence = "daily" | "weekly";

/** Phase 7.7 (21-N): a recurring look at a Project that can only propose Missions. */
export interface Routine {
  id: string;
  project_id: string;
  name: string;
  prompt: string;
  cadence: RoutineCadence;
  enabled: boolean;
  last_run_at: string | null;
  last_summary: string | null;
  created_at: string;
}

export interface Execution {
  id: string;
  mission_id: string;
  seq: number;
  trigger: ExecutionTrigger;
  started_at: string;
  ended_at: string | null;
  outcome: ExecutionOutcome | null;
  git_before_sha: string;
  git_after_sha: string | null;
  worktree_path: string;
  /** .claude/plans/completed/13-real-merge-on-approval.md — null for Executions predating it. */
  branch_name: string | null;
  /** .claude/plans/18-mock-provider-safety-and-prod-start.md — null for Executions predating it. */
  provider: ProviderName | null;
  /** .claude/plans/20-plano-consolidado.md item 1.6 — set once the Execution ends; API-equivalent, not money charged. */
  cost_usd?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  duration_ms?: number | null;
}

export interface Evidence {
  id: string;
  execution_id: string;
  seq: number;
  type: string;
  payload: unknown;
  occurred_at: string;
  /** .claude/plans/completed/14-real-multi-agent-execution.md — null when not attributable to one Team Member. */
  team_member_role: string | null;
}

// .claude/plans/completed/13-real-merge-on-approval.md — result of the
// rebase+push mechanics triggered by a binding 'approved' Decision.
export type PushResult =
  | { pushed: true; branch_name: string }
  | {
      pushed: false;
      reason: "no-remote" | "no-execution" | "conflict" | "push-failed" | "mock-run" | "parent-pending";
      branch_name?: string;
      detail?: string;
    };

export interface Artifact {
  id: string;
  execution_id: string;
  kind: ArtifactKind;
  title: string;
  content_ref: string;
  summary: string | null;
  created_at: string;
}

export interface Finding {
  id: string;
  review_id: string;
  artifact_id: string;
  evidence_id: string | null;
  text: string;
  severity: FindingSeverity;
  created_at: string;
}

export interface Review {
  id: string;
  mission_id: string;
  author_type: ReviewAuthorType;
  author_role: string | null;
  recommendation_outcome: RecommendationOutcome;
  recommendation_rationale: string;
  created_at: string;
  findings?: Finding[];
  artifact_ids?: string[];
}

export interface Decision {
  id: string;
  mission_id: string;
  tier: DecisionTier;
  outcome: DecisionOutcome;
  rationale: string | null;
  created_at: string;
}

export interface MissionGraphEdge {
  id: string;
  edge_type: EdgeType;
  from_kind: EdgeNodeKind;
  from_id: string;
  to_kind: EdgeNodeKind;
  to_id: string;
  created_at: string;
}

export const MISSION_STATUS_DISPLAY_LABEL: Record<MissionStatus, string> = {
  proposed: "Proposed (not yet started)",
  queued: "Queued",
  running: "Running",
  "awaiting-approval": "Waiting on you",
  waiting: "Paused",
  completed: "Completed",
  rejected: "Rejected",
  failed: "Failed",
  cancelled: "Cancelled",
};

export interface TimelineEntry {
  kind: "mission_created" | "execution_started" | "review_submitted" | "decision_recorded";
  id: string;
  at: string;
}

export interface TrustLedgerAggregate {
  outcome: string;
  count: number;
}

// .claude/plans/04-usage-rate-limit.md — the most recent rate_limit_event
// observed from the provider, workspace-scoped (one subscription's window
// shared across every concurrent Execution). Read on demand, never polled.
export interface RateLimitState {
  status: string;
  rate_limit_type: string | null;
  resets_at: number | null;
  is_using_overage: boolean;
  updated_at: string;
}

// .claude/plans/05-checks-approval-gate.md — read-only external context,
// mirrors src/integrations/github.ts's ChecksResult.
export interface MissionChecks {
  configured: boolean;
  error?: string;
  branch?: { name: string; base: string; ahead_by: number; behind_by: number } | null;
  pull_request?: { number: number; state: "open" | "closed"; draft: boolean; html_url: string } | null;
  ci?: { state: "success" | "failure" | "pending" | "none"; total: number; passed: number } | null;
  reviewers_requesting_changes?: number | null;
}

// .claude/plans/20-plano-consolidado.md Phase 1 — mirrors GateFacts in
// src/execution-engine/index.ts. Neutral facts shown at the Approval Gate.
export interface CostTotals {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}

export interface GateFacts {
  rollup: {
    files: { path: string; added: number | null; removed: number | null; artifact_id: string | null }[];
    added: number;
    removed: number;
  } | null;
  secret_paths: string[];
  qa: { command_count: number; commands: string[] } | null;
  cost: { total: CostTotals | null; by_role: ({ role: string | null } & CostTotals)[] };
  // Phase 4
  criteria: {
    text: string;
    source: "user" | "planner";
    verdicts: { by: string; verdict: "met" | "not-met" | "unclear"; note: string }[];
  }[];
  findings: { by: string; severity: "blocking" | "warning" | "info"; path: string | null; line: number | null; text: string }[];
  drift: { planned: string[]; unplanned: string[] } | null;
}
