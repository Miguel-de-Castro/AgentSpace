// Domain types mirroring the schema in src/db/schema.sql / docs/07-SCHEMA_API_CONTRACT.md.
// Canonical vocabulary is docs/20-UBIQUITOUS_LANGUAGE.md — do not introduce a
// synonym here (e.g. "Task", "Agent") that document forbids.

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
  // .claude/plans/20-plano-consolidado.md Phase 3 — continuing a 'waiting' Mission.
  | "resume-after-limit"
  | "resume-after-input";

// .claude/plans/20-plano-consolidado.md Phase 3 (D1) — why a Mission is 'waiting'.
// usage-limit is informational (AgentSpace resumes it on its own); needs-input
// and plan-review need the supervisor.
export type WaitingReason = "usage-limit" | "needs-input" | "plan-review";
export type ExecutionOutcome = "success" | "failure" | "interrupted";

// .claude/plans/18-mock-provider-safety-and-prod-start.md — which Provider
// Adapter actually ran an Execution. Persisted per-Execution so a simulation
// (mock) can never be silently mistaken for real agent work in the UI.
export type ProviderName = "claude-code" | "mock";

export type ArtifactKind = "diff" | "new_file" | "document" | "test_report";

export type ReviewAuthorType = "human" | "ai_team_member";
export type RecommendationOutcome = "approve" | "iterate" | "reject-suggested";

export type FindingSeverity = "info" | "warning" | "blocking";

// 'plan' (plan 20 Phase 3.3): the supervisor's call on a plan checkpoint.
// Never part of the Trust Ledger, which counts binding Decisions only.
export type DecisionTier = "binding" | "lightweight" | "plan";
export type BindingOutcome = "approved" | "rejected";
export type PlanOutcome = "plan-approved" | "plan-revised" | "plan-discarded";
export type LightweightOutcome = "acknowledged-good" | "acknowledged-not-wanted" | "flag-for-later";
export type DecisionOutcome = BindingOutcome | LightweightOutcome | PlanOutcome;

// .claude/plans/20-plano-consolidado.md Phase 4 (D4) — a criterion the user
// wrote in New Mission, or one the Planner added to fill a gap.
export interface AcceptanceCriterion {
  text: string;
  source: "user" | "planner";
}

export type EdgeType = "triggered-by" | "informed-by" | "superseded-by";
export type EdgeNodeKind = "mission" | "decision" | "review" | "artifact";

export interface TeamRosterEntry {
  role: string; // "Planner" | "Developer" | "QA" | "Reviewer" | future roles
  enabled: boolean;
}

export interface AssignedTeamEntry {
  role: string;
}

export interface BranchProtection {
  protected_branches: string[];
  source: "detected" | "implicit-fallback";
}

// .claude/plans/project-permission-policy.md — a human-set capability
// boundary per Project, the same shape of decision as branch protection
// (00-VISION.md): what a Project's Missions are allowed to *attempt*, set in
// advance by a developer, never inferred or risk-scored by AgentSpace itself
// (docs/03-ARCHITECTURE.md §9 — no custom risk-scoring model).
export type PermissionMode = "read-only" | "can-edit" | "can-edit-and-run" | "custom";

export interface PermissionPolicy {
  mode: PermissionMode;
  /** Only meaningful when mode === "custom" — passed verbatim to the provider's --allowedTools. */
  allowed_tools?: string[];
  /** Only meaningful when mode === "custom" — passed verbatim to the provider's --disallowedTools. */
  disallowed_tools?: string[];
}

// "can-edit-and-run": `acceptEdits` plus an allow-list of common test/build
// runners, and a deny-list for anything that talks to a remote. Confirmed with
// the real CLI (2026-09-30): `node -e` runs, `git push` is denied. It is a
// runner allow-list, not a sandbox: a test script can still do what scripts do.
export const RUN_ALLOWED_TOOLS = [
  "Bash(npm:*)",
  "Bash(npx:*)",
  "Bash(node:*)",
  "Bash(pnpm:*)",
  "Bash(yarn:*)",
  "Bash(bun:*)",
  "Bash(python:*)",
  "Bash(python3:*)",
  "Bash(pytest:*)",
  "Bash(go test:*)",
  "Bash(cargo test:*)",
  "Bash(cargo build:*)",
  "Bash(cargo check:*)",
  "Bash(dotnet test:*)",
  "Bash(dotnet build:*)",
  "Bash(make:*)",
];
export const RUN_DISALLOWED_TOOLS = ["Bash(git push:*)", "Bash(git remote:*)", "Bash(curl:*)", "Bash(wget:*)"];

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = { mode: "read-only" };

// .claude/plans/20-plano-consolidado.md item 1.2 (F2) — a per-role ceiling on
// what a Team Member's invocation may use, always INTERSECTED with the
// Project's permission_policy (it can only narrow, never widen):
//   - "read-only": investigate only (Read/Grep/Glob) — Planner, Reviewer.
//   - "read-and-run": investigate + execute commands (Bash), but never
//     Edit/Write — QA, which only reports (decision D2).
//   - "project-policy": whatever the Project allows — Developer, and any role
//     outside this map (so a future role never silently loses capability).
// Decided by AgentSpace, never by the repo's own .claude/agents/ (D5).
export type RoleToolCeiling = "read-only" | "read-and-run" | "project-policy";

export const ROLE_TOOL_CEILING: Record<string, RoleToolCeiling> = {
  Planner: "read-only",
  Developer: "project-policy",
  QA: "read-and-run",
  Reviewer: "read-only",
};

export function roleToolCeiling(role: string | undefined): RoleToolCeiling {
  return (role && ROLE_TOOL_CEILING[role]) || "project-policy";
}

export interface Workspace {
  id: string;
  name: string;
  created_at: string;
}

// .claude/plans/19-clone-git-repository.md — how the repo got onto this
// machine: 'local' = a path the user already had (removing a Project only
// disconnects it, never touches the directory); 'cloned' = AgentSpace cloned it
// into a managed dir, so removing the Project may delete that directory too.
export type ProjectOriginKind = "local" | "cloned" | "cached";

export interface Project {
  id: string;
  workspace_id: string;
  name: string;
  repo_path: string;
  default_branch: string;
  branch_protection: BranchProtection;
  team_roster: TeamRosterEntry[];
  permission_policy: PermissionPolicy;
  /**
   * .claude/plans/20-plano-consolidado.md Phase 6 (D3) — when a reviewer reports
   * a blocking finding or an unmet criterion, start one correction round on
   * its own (each round counts toward the iterate cap). Off by default.
   */
  auto_fix_loop: boolean;
  /**
   * Phase 7.1 (D5) — extra guidance for this Project's team, ADDED to
   * AgentSpace's own role instructions (never replacing them): one text for
   * every role, plus optional per-role text.
   */
  instructions: string | null;
  role_instructions: Record<string, string>;
  /**
   * .claude/plans/24-ideias-para-analisar.md item 7 — optional ceiling (API-equivalent
   * USD, rolling 7 days). Null = off. Routines and the automatic correction loop
   * stop when it's reached; a Mission the supervisor starts by hand never does.
   */
  weekly_budget_usd: number | null;
  /**
   * Plan 24 item 2 — short texts of ideas the supervisor told routines never to
   * propose again. Listed in every routine prompt and matched against new
   * proposals; editable (removable) in Settings.
   */
  routine_exclusions: string[];
  /**
   * Plan 25 - how "Run" starts this Project's app. Null means "detect from
   * package.json" (and a `{PORT}` placeholder in a command is replaced by the
   * port in use). `preview_port` pins a port for apps that ignore PORT.
   */
  run_command: string | null;
  install_command: string | null;
  preview_port: number | null;
  origin_kind: ProjectOriginKind;
  /** Source URL when origin_kind === 'cloned'; null for local Projects. */
  clone_url: string | null;
  created_at: string;
  /**
   * Computed on read, never stored: false when repo_path no longer exists on
   * disk (the folder was moved or deleted). Surfaced so the UI can say so and
   * offer to point the Project at the new location, instead of Missions
   * failing with a bare `git ENOENT`.
   */
  repo_available: boolean;
}

export interface Mission {
  id: string;
  project_id: string;
  brief: string;
  status: MissionStatus;
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
  /** Phase 3.3: the plan the supervisor approved (later roles build from it). */
  approved_plan: string | null;
  /** Phase 4: what "done" means for this Mission. */
  acceptance_criteria: AcceptanceCriterion[];
  /** Phase 7.7: the Mission whose branch this one is stacked on, if any. */
  base_mission_id: string | null;
  /** Phase 7.7: that branch's name when this Mission started. */
  base_branch: string | null;
}

export type RoutineCadence = "daily" | "weekly";

/** Phase 7.7 (21-N): a recurring look at a Project that can only PROPOSE Missions. */
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
  /**
   * .claude/plans/20-plano-consolidado.md item 1.6 — summed from the provider's
   * `result` events once the Execution ends (never live). With a subscription
   * login this is the API-equivalent price, not money actually charged. Null
   * while running, for Executions predating it, or when the provider reported
   * nothing (mock).
   */
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
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
// rebase+push mechanics triggered by a binding 'approved' Decision. Never
// persisted as its own row — it's a one-time mechanical outcome, reported
// back on the Decision response and nothing else.
export type PushResult =
  | { pushed: true; branch_name: string }
  | {
      pushed: false;
      // .claude/plans/18-mock-provider-safety-and-prod-start.md P0 item 4 —
      // 'mock-run' means the latest Execution ran in simulation mode; a
      // simulation must never reach the merge flow, so approveAndPush refuses
      // to push it (belt-and-suspenders with the route-level guard).
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

/** docs/07-SCHEMA_API_CONTRACT.md §6 — schema stores the domain enum only; this is presentation-layer text. */
export const MISSION_STATUS_DISPLAY_LABEL: Record<MissionStatus, string> = {
  proposed: "Proposed — not yet started",
  queued: "Queued",
  running: "Running",
  "awaiting-approval": "Waiting on you",
  waiting: "Paused",
  completed: "Completed",
  rejected: "Rejected",
  failed: "Failed",
  cancelled: "Cancelled",
};
