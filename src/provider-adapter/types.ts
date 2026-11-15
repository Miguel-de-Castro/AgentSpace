import type { AssignedTeamEntry, PermissionPolicy } from "../domain/types.js";

/**
 * Raw, provider-shaped event emitted upward for Execution Engine to
 * normalize into the domain's Evidence shape (docs/03-ARCHITECTURE.md §4).
 * `raw` is intentionally unknown — Execution Engine's schema-defense layer
 * (T-006, AT #9) is responsible for validating and normalizing it, not this
 * type. Provider Adapter never persists anything itself.
 */
export interface ProviderEvent {
  type: string;
  raw: unknown;
  occurredAt: string;
  /**
   * .claude/plans/completed/14-real-multi-agent-execution.md — which Team
   * Member role this event belongs to, when the Provider Adapter ran the
   * Execution as separate per-role invocations. Undefined for events not
   * attributable to one role (e.g. rate_limit_event) or when the adapter
   * ran a single flattened invocation (no Team assigned).
   */
  role?: string;
}

export interface ProviderRunInput {
  worktreePath: string;
  brief: string;
  assignedTeam: AssignedTeamEntry[];
  referenceMaterial?: unknown;
  /**
   * .claude/plans/project-permission-policy.md — Mission Engine's resolved
   * policy for what this Project's Executions may attempt. Provider Adapter
   * only translates this into provider-specific mechanism (AT #7); it never
   * decides the policy itself.
   */
  permissionPolicy: PermissionPolicy;
  /**
   * .claude/plans/18-mock-provider-safety-and-prod-start.md P1 (rejection
   * flow) — extra, user-supplied direction for an `iterate` Execution ("that
   * wasn't the right token, use --secondary"). Prepended to each role prompt
   * as the primary instruction when present, so the follow-up run acts on the
   * correction rather than re-running the original brief blind. Undefined for
   * a first/initial run.
   */
  adjustment?: string;
  /**
   * .claude/plans/15-live-execution-feedback.md Part 1 — called synchronously
   * as each ProviderEvent is produced, so Execution Engine can persist
   * Evidence incrementally (and fire an SSE signal) *while* the run is still
   * going, instead of only seeing the whole batch when `run()` resolves.
   * Additive: `run()` still returns the full aggregated `ProviderRunResult`
   * for callers that only want the final result.
   */
  onEvent?: (event: ProviderEvent) => void;
  /**
   * .claude/plans/15-live-execution-feedback.md Part 3 — when this fires, the
   * adapter kills its current live provider process (and stops before
   * starting any further per-role invocation), resolving the run as
   * `outcome: "interrupted"` rather than `"failure"`. This is how a real
   * "Cancel Mission" reaches down and stops the actual `claude` process,
   * which the old cancel never did. Optional: a run with no signal never
   * cancels.
   */
  signal?: AbortSignal;
  /**
   * .claude/plans/20-plano-consolidado.md Phase 3 — continue an earlier
   * Execution instead of starting cold. `sessions` maps a role ('' for a
   * team-less run) to the provider session it ran in; roles before `fromRole`
   * already finished and are skipped; `fromRole` continues its own session
   * with `note` as the new instruction; later roles start fresh as usual.
   * Provider-agnostic: each adapter maps it to its own resume mechanism
   * (Claude: `--resume <id> --fork-session`, ADR-005).
   */
  resume?: {
    sessions: Record<string, string>;
    fromRole?: string;
    note: string;
  };
  /** Phase 3.3 — stop the chain after this role (the Planner, for a plan checkpoint). */
  stopAfterRole?: string;
  /** Phase 3.3 — roles already covered (the Planner, once its plan is approved). */
  skipRoles?: string[];
  /** Phase 3.3 — the plan the supervisor approved; every role builds from it. */
  approvedPlan?: string;
  /** Phase 4 — what "done" means; the Planner may add to it, the Reviewer judges it. */
  acceptanceCriteria?: { text: string; source: "user" | "planner" }[];
  /**
   * Phase 3.2 — whether a role may stop to ask the supervisor something
   * (`NEEDS_INPUT: <question>` as its last line). False once the Mission used
   * its question budget, so the team makes a stated assumption instead.
   */
  allowQuestions?: boolean;
  /**
   * Phase 7.1 (D5) — the Project's own guidance, ADDED after AgentSpace's role
   * instructions (never replacing them): one text for every role, plus
   * per-role text keyed by role name.
   */
  projectInstructions?: string | null;
  roleInstructions?: Record<string, string>;
}

/** One role's provider session within a run — what a later resume needs. */
export interface ProviderRoleSession {
  role: string; // '' for a team-less flattened run
  sessionId: string;
  /** false when the invocation was cut short (limit, cancel, failure). */
  completed: boolean;
  /** The role's final answer text (the plan, the review, a question…), when there was one. */
  finalText?: string;
}

export interface ProviderRunResult {
  events: ProviderEvent[];
  outcome: "success" | "failure" | "interrupted";
  /** .claude/plans/20-plano-consolidado.md Phase 3 — every session this run used, in order. */
  sessions: ProviderRoleSession[];
  /**
   * Set when the run stopped because the provider refused to continue (usage
   * limit), as opposed to a failure or a user cancel. Outcome is then
   * 'interrupted'; Mission Engine turns it into a 'waiting' Mission.
   * `resetsAt` is epoch seconds when the provider said when the limit lifts.
   */
  paused?:
    | { reason: "usage-limit"; resetsAt?: number }
    // Phase 3.2 — a role ended with `NEEDS_INPUT: <question>`.
    | { reason: "needs-input"; question: string; role: string };
}

/**
 * The narrow contract every Provider Adapter implements (docs/03-ARCHITECTURE.md
 * §6): start/observe/cancel/resume one provider's execution. Mission Engine
 * and Execution Engine depend only on this interface — never on
 * `ClaudeCodeAdapter` directly — so a second provider is addable without
 * touching either of them (AT #8).
 */
export interface ProviderAdapter {
  /** Runs one Execution to completion (or interruption) inside the given worktree. */
  run(input: ProviderRunInput): Promise<ProviderRunResult>;

  /**
   * .claude/plans/09-reasoning-summary.md — a single, non-agentic text
   * completion (no worktree, no tools, no persisted Evidence) used to
   * synthesize a Reasoning Summary from an already-grounded prompt. Kept on
   * the same interface as `run` because it's still "talk to this provider,"
   * just a different shape of interaction — Execution Engine builds the
   * grounded prompt, this only ever turns it into text.
   */
  synthesize(prompt: string, opts?: { signal?: AbortSignal; cwd?: string; tools?: string }): Promise<string>;
}
