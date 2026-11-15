import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getDb } from "../db/client.js";
import { newId } from "../util/id.js";
import { eventBus } from "../api/eventBus.js";
import { getActiveProviderName, getProviderAdapter } from "../provider-adapter/index.js";
import { getProject } from "../mission-engine/projects.js";
import {
  addPlannerCriteria,
  decideAutoFix,
  getMission,
  registerIterateAttempt,
  applyExecutionOutcome,
  listUsageLimitResumesDue,
  transitionMissionStatus,
} from "../mission-engine/missions.js";
import type { Artifact, Evidence, Execution, ExecutionTrigger, Mission, PermissionPolicy, Project, WaitingReason } from "../domain/types.js";
import {
  buildExecutionBranchName,
  createTempWorktreeAtSha,
  createWorktree,
  createWorktreeFromBranch,
  currentHeadSha,
  deleteLocalBranch,
  diffContent,
  diffNumstat,
  diffSummary,
  isRebaseInProgress,
  mergeBaseSha,
  refExists,
  refreshBareCache,
  squashAndRebaseOntoBase,
  listWorktrees,
  rebaseAndPushExecutionBranch,
  removeWorktree,
} from "./git.js";
import { buildReportContent, buildVerdict, detectBuildCommand, runBuildCheckWithDeps } from "./buildCheck.js";
import { assignedTeamHasChallenger, findingsForArtifacts, runChallengerReview } from "./challengerReview.js";
import { parseVerdict, type ParsedVerdict } from "./verdict.js";
import { submitAiReview } from "../mission-engine/reviews.js";
import { getRateLimitState, recordRateLimitInfo, type RateLimitInfo } from "./rateLimitState.js";
import type { ProviderRoleSession, ProviderRunInput, ProviderRunResult } from "../provider-adapter/index.js";
import { synthesizeReasoningSummary } from "./reasoningSummary.js";
import { budgetStatus } from "./budget.js";
import { stopPreviewsInFolder } from "./preview.js";
import { formatPrDescription } from "./prDescription.js";
import { synthesizeBranchSlug } from "./branchName.js";
import { unwrapBackticks } from "../provider-adapter/roleConventions.js";
import { slugify } from "../util/slug.js";
import { excludePathspecs, findSecretPaths } from "./secretGuard.js";
import { usageCaptureTrigger, writeUsageCapture, type UsageCaptureTrigger } from "./usageCapture.js";
import {
  branchSpan,
  buildFileRollup,
  criteriaWithVerdicts,
  gateFindings,
  planDrift,
  type GateCriterion,
  type GateFinding,
  qaActivity,
  secretGuardPaths,
  sumExecutionCost,
  type CostBreakdown,
  type FileRollup,
  type QaActivity,
} from "./gateFacts.js";
import type { PushResult } from "../domain/types.js";
export { getRateLimitState } from "./rateLimitState.js";

/**
 * .claude/plans/02-parallel-isolation.md item 1 — a loop-safety bound on how
 * many Executions may have a live provider process at once, same shape as
 * Mission Engine's iterate-cap (missions.ts): a policy counter, never a
 * scheduler or a risk model (docs/03-ARCHITECTURE.md §9's "no custom
 * risk-scoring model" applies here too). Lives here rather than in Mission
 * Engine because enforcing it requires reading live Execution rows, which is
 * this layer's data — the cap *value* is still just a tunable, not an
 * architectural commitment (mirrors §10's framing of the iterate-cap default).
 */
const MAX_CONCURRENT_EXECUTIONS = Number(process.env.AGENTSPACE_MAX_CONCURRENT_EXECUTIONS ?? 2);

/**
 * .claude/plans/15-live-execution-feedback.md Part 3 — one live cancellation
 * handle per in-flight Execution. Aborting the controller reaches the Provider
 * Adapter (via the AbortSignal handed into `run`), which kills the real
 * provider process. Kept in this layer, not Mission Engine, because only this
 * layer owns provider processes (AT #7). Entries are added when an Execution
 * starts and removed in finalizeExecution.
 */
const runningControllers = new Map<string, AbortController>();

/**
 * .claude/plans/15-live-execution-feedback.md Part 3 — throttle for the
 * per-Evidence SSE signal. A single real Execution emits 50–300+ stream-json
 * lines; one notification per raw line would be pure noise. This caps it to
 * roughly one signal per second per Execution, with a trailing flush so the
 * last write is never dropped.
 */
const EVIDENCE_SSE_INTERVAL_MS = 1000;

/**
 * .claude/plans/15-live-execution-feedback.md Part 3 — the mechanical half of
 * a real "Cancel Mission": abort every still-running Execution of this Mission,
 * which kills its provider process. Returns whether anything was actually
 * live to kill. Called from the API route before the (now atomic) status
 * write in Mission Engine — same route-orchestrates-both-layers pattern as
 * plan 13's approveAndPush.
 */
export function killRunningExecution(missionId: string): boolean {
  const rows = getDb()
    .prepare("SELECT id FROM executions WHERE mission_id = ? AND ended_at IS NULL")
    .all(missionId) as unknown as { id: string }[];

  let killed = false;
  for (const { id } of rows) {
    const controller = runningControllers.get(id);
    if (controller) {
      controller.abort();
      killed = true;
    }
  }
  return killed;
}

/**
 * .claude/plans/20-plano-consolidado.md item 1.7 — Missions whose Execution is
 * being set up but has no row yet (startExecution awaits a few seconds for the
 * branch name). They count against the concurrency cap and are skipped by
 * drainQueuedMissions, so a Mission still `queued` during that wait is never
 * started twice.
 */
const startingMissions = new Set<string>();

function countRunningExecutions(): number {
  const { n } = getDb()
    .prepare("SELECT COUNT(*) AS n FROM executions WHERE ended_at IS NULL")
    .get() as unknown as { n: number };
  return n;
}

/**
 * Called after an Execution ends, so a Mission that was held back by the
 * concurrency cap gets picked up the moment a slot frees — without this, a
 * queued Mission would only ever start if something else happened to poke it
 * again. Oldest queued Mission first; starts as many as the freed capacity
 * allows. Fire-and-forget, same error handling as the two HTTP routes that
 * also call startExecution.
 */
function drainQueuedMissions(): void {
  // .claude/plans/20-plano-consolidado.md Phase 3 — queued work stays queued
  // while the subscription is refusing; starting it would only hit the limit.
  if (usageLimitActive()) return;
  const capacity = MAX_CONCURRENT_EXECUTIONS - countRunningExecutions() - startingMissions.size;
  if (capacity <= 0) return;

  const queued = (
    getDb().prepare("SELECT id FROM missions WHERE status = 'queued' ORDER BY created_at ASC").all() as unknown as { id: string }[]
  )
    .filter(({ id }) => !startingMissions.has(id))
    .slice(0, capacity);

  for (const { id } of queued) {
    startExecution(id, "initial").catch((err) => {
      console.error(`Failed to start queued Mission ${id} after a concurrency slot freed:`, err);
    });
  }
}

/**
 * Where the Mission's branch forked from its base branch: the right "before"
 * for "what does this branch change". Using the first Execution's starting
 * commit instead breaks once the branch is rebased onto a newer base (Phase
 * 7.4): the diff would then include the base's own new commits. Falls back to
 * undefined (callers keep their previous baseline) if git can't tell.
 */
function branchForkPoint(missionId: string, tip: string): string | undefined {
  const mission = getMission(missionId);
  const project = mission ? getProject(mission.project_id) : undefined;
  if (!mission || !project) return undefined;
  return mergeBaseSha(project.repo_path, baseBranchFor(project, mission), tip);
}

/**
 * Phase 7.7 (21-L) — what a Mission's branch is measured and rebased against: the
 * Project's base branch, or, for a stacked Mission, its parent's branch. If the
 * parent's branch is gone (merged, then pruned from a bare cache), the work it
 * carried is in the base already, so the base is the right answer again.
 */
function baseBranchFor(project: Project, mission: Mission): string {
  const projectBase = project.branch_protection.protected_branches[0] ?? project.default_branch;
  if (mission.base_branch && refExists(project.repo_path, mission.base_branch)) return mission.base_branch;
  return projectBase;
}

/** Phase 7.9 — a bare cache keeps no working copy, so it must be brought up to origin before use. */
function refreshIfCached(project: Project): void {
  if (project.origin_kind !== "cached") return;
  refreshBareCache(project.repo_path, project.default_branch);
}

const CONFLICT_NOTE_PREFIX = "The branch had to be moved onto the latest base branch before it can be pushed.";

/**
 * .claude/plans/20-plano-consolidado.md Phase 3 — is the provider's usage
 * limit in force right now? True while the last rate_limit_event said
 * 'rejected' and its reset time hasn't passed; with no reset time, for
 * USAGE_LIMIT_FALLBACK_MS after it was seen (a later 'allowed' event clears it).
 */
const USAGE_LIMIT_FALLBACK_MS = 15 * 60 * 1000;
export function usageLimitActive(now = Date.now()): boolean {
  const state = getRateLimitState();
  if (!state || state.status !== "rejected") return false;
  if (state.resets_at) return state.resets_at * 1000 > now;
  return Date.parse(state.updated_at) + USAGE_LIMIT_FALLBACK_MS > now;
}

/**
 * When a paused Mission should be retried: the provider's own reset time when
 * it gave one (plus a small margin), otherwise an exponential backoff on how
 * many times this Mission already had to resume after a limit (15 min, 30,
 * 60, capped at 2 h).
 */
const RESUME_MARGIN_MS = 60 * 1000;
function resumeTimeAfterLimit(missionId: string, resetsAt?: number): string {
  if (resetsAt) return new Date(resetsAt * 1000 + RESUME_MARGIN_MS).toISOString();
  const previous = listExecutions(missionId).filter((e) => e.trigger === "resume-after-limit").length;
  const delay = Math.min(USAGE_LIMIT_FALLBACK_MS * 2 ** previous, 2 * 60 * 60 * 1000);
  return new Date(Date.now() + delay).toISOString();
}

/** The sessions an Execution's roles ran in (Phase 3), in insertion order. */
function listRoleSessions(executionId: string): ProviderRoleSession[] {
  const rows = getDb()
    .prepare("SELECT role, session_id, completed FROM execution_role_sessions WHERE execution_id = ? ORDER BY rowid ASC")
    .all(executionId) as unknown as { role: string; session_id: string; completed: number }[];
  return rows.map((r) => ({ role: r.role, sessionId: r.session_id, completed: r.completed === 1 }));
}

/** Phase 3.4 — what a resumed Developer session is told on an adjustment. */
function adjustmentNote(adjustment: string): string {
  return [
    "The user reviewed the result of your work and asked for this correction. Treat it as the primary instruction; check the current state of the files first:",
    adjustment,
  ].join("\n");
}

const RESUME_AFTER_LIMIT_NOTE = [
  "You were interrupted by the provider's usage limit before finishing. The limit has now reset.",
  "Continue the same work from where you stopped: check the current state of the files first (your earlier edits are there), then finish what the brief asks.",
].join(" ");

/**
 * Builds the adapter's resume input from the previous Execution: continue the
 * first role that didn't finish, in its own session; earlier roles are done.
 * Undefined when there's nothing to resume (no recorded sessions).
 */
function buildResumeInput(
  previous: Execution | undefined,
  note: string,
  /** Continue this role's session instead of the first unfinished one (undefined when it has none). */
  preferRole?: string
): ProviderRunInput["resume"] {
  if (!previous) return undefined;
  const sessions = listRoleSessions(previous.id);
  if (sessions.length === 0) return undefined;
  let from: ProviderRoleSession | undefined;
  if (preferRole !== undefined) {
    from = sessions.find((s) => s.role === preferRole);
    if (!from) return undefined;
  } else {
    from = sessions.find((s) => !s.completed) ?? sessions[sessions.length - 1];
  }
  return {
    sessions: Object.fromEntries(sessions.map((s) => [s.role, s.sessionId])),
    fromRole: from.role || undefined,
    note,
  };
}

/**
 * .claude/plans/20-plano-consolidado.md Phase 3.2 — at most this many questions
 * per Mission; after that the team is told to assume and say so (no ping-pong).
 */
const MAX_QUESTIONS_PER_MISSION = Number(process.env.AGENTSPACE_MAX_QUESTIONS ?? 3);

function countEvidenceOfType(missionId: string, type: string): number {
  const { n } = getDb()
    .prepare("SELECT COUNT(*) AS n FROM evidence v JOIN executions e ON e.id = v.execution_id WHERE e.mission_id = ? AND v.type = ?")
    .get(missionId, type) as unknown as { n: number };
  return n;
}

/** The most recent Evidence payload of a type across the Mission's Executions. */
function latestEvidencePayload<T>(missionId: string, type: string): T | undefined {
  const row = getDb()
    .prepare(
      "SELECT v.payload FROM evidence v JOIN executions e ON e.id = v.execution_id WHERE e.mission_id = ? AND v.type = ? ORDER BY e.seq DESC, v.seq DESC LIMIT 1"
    )
    .get(missionId, type) as unknown as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as T) : undefined;
}

export interface WaitingDetails {
  reason: WaitingReason;
  resume_at: string | null;
  /** needs-input */
  question?: string;
  role?: string;
  /** plan-review */
  plan?: string;
  files?: string[];
  revisions_left?: number;
}

/** Phase 3 — what the MissionDetail panels show for a 'waiting' Mission. */
export function getWaitingDetails(missionId: string): WaitingDetails | undefined {
  const mission = getMission(missionId);
  if (!mission || mission.status !== "waiting" || !mission.waiting_reason) return undefined;
  const details: WaitingDetails = { reason: mission.waiting_reason, resume_at: mission.resume_at };
  if (mission.waiting_reason === "needs-input") {
    const q = latestEvidencePayload<{ question: string; role: string }>(missionId, "clarification_request");
    if (q) Object.assign(details, { question: q.question, role: q.role || undefined });
  }
  if (mission.waiting_reason === "plan-review") {
    const p = latestEvidencePayload<{ plan: string; files: string[] }>(missionId, "plan_proposal");
    if (p) Object.assign(details, { plan: p.plan, files: p.files });
  }
  return details;
}

/**
 * Whether a new Execution could start right now, and if not why — for routes
 * that resume a waiting Mission on the supervisor's action (answer, plan
 * approval) and must say so instead of silently doing nothing.
 */
export function canStartExecutionNow(missionId: string): { ok: true } | { ok: false; reason: string } {
  if (usageLimitActive()) return { ok: false, reason: "The usage limit is in force right now; try again after it resets." };
  if (startingMissions.has(missionId)) return { ok: false, reason: "This Mission is already starting." };
  if (countRunningExecutions() + startingMissions.size >= MAX_CONCURRENT_EXECUTIONS) {
    return { ok: false, reason: "Other Missions are using every slot right now; try again when one finishes." };
  }
  return { ok: true };
}

/** Lines `PREFIX <text>` in a role's final answer (FILES:, CRITERION+:). */
function markerLines(text: string | undefined, prefix: string): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(prefix))
    .map((l) => unwrapBackticks(l.slice(prefix.length)))
    .filter(Boolean);
}

function answerNote(question: string | undefined, answer: string): string {
  return [
    question ? `You asked the user: "${question}"` : "You asked the user a question.",
    `Their answer: ${answer}`,
    "Continue the same work with this answer.",
  ].join("\n");
}

/**
 * .claude/plans/20-plano-consolidado.md Phase 3 (21-A) — once a minute (and
 * once at boot), resume every Mission paused on the usage limit whose resume
 * time has come. startExecution itself re-checks the limit and the
 * concurrency cap, so a still-limited or full workspace just waits for the
 * next tick.
 */
const SWEEP_INTERVAL_MS = 60 * 1000;
export function sweepUsageLimitResumes(): void {
  if (usageLimitActive()) return;
  for (const mission of listUsageLimitResumesDue(new Date().toISOString())) {
    startExecution(mission.id, "resume-after-limit").catch((err) =>
      console.error(`Failed to resume Mission ${mission.id} after the usage limit:`, err)
    );
  }
  // Queued Missions held back during the limit only move when an Execution
  // ends; nothing may be running, so nudge the queue here too.
  drainQueuedMissions();
}

export function startUsageLimitSweeper(): void {
  sweepUsageLimitResumes();
  setInterval(sweepUsageLimitResumes, SWEEP_INTERVAL_MS).unref();
}

export function listExecutions(missionId: string): Execution[] {
  return getDb().prepare("SELECT * FROM executions WHERE mission_id = ? ORDER BY seq ASC").all(missionId) as unknown as Execution[];
}

/**
 * .claude/plans/23-ui-ux-polish.md item 12: Executions that ended before 1.6 have
 * null cost columns. Derive them from Evidence on read; the stored row is untouched.
 */
export function listExecutionsWithCost(missionId: string): Execution[] {
  return listExecutions(missionId).map((e) => {
    if (!e.ended_at || e.cost_usd != null) return e;
    const total = sumExecutionCost(listEvidence(e.id)).total;
    if (!total) return e;
    return { ...e, cost_usd: total.cost_usd, input_tokens: total.input_tokens, output_tokens: total.output_tokens, duration_ms: total.duration_ms };
  });
}

/** The branch a Mission's work lives on (its latest Execution's), if it has one. */
export function latestBranchOf(missionId: string): string | undefined {
  const executions = listExecutions(missionId);
  return executions[executions.length - 1]?.branch_name ?? undefined;
}

export function getExecution(id: string): Execution | undefined {
  return getDb().prepare("SELECT * FROM executions WHERE id = ?").get(id) as unknown as Execution | undefined;
}

export function listEvidence(executionId: string): Evidence[] {
  const rows = getDb().prepare("SELECT * FROM evidence WHERE execution_id = ? ORDER BY seq ASC").all(executionId) as unknown as (Evidence & {
    payload: string;
  })[];
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

/**
 * .claude/plans/09-reasoning-summary.md — replaces the earlier placeholder
 * (`getEvidenceSummary` in src/api/routes/executions.ts) that just listed
 * Evidence type names instead of actually explaining what happened.
 */
export async function getReasoningSummary(executionId: string): Promise<string> {
  const evidence = listEvidence(executionId);
  if (evidence.length === 0) return "No Evidence recorded for this Execution yet.";

  const execution = getExecution(executionId);
  const mission = execution ? getMission(execution.mission_id) : undefined;
  return synthesizeReasoningSummary(evidence, mission?.brief);
}

/**
 * .claude/plans/completed/13-real-merge-on-approval.md — the mechanical
 * action behind "Allow" in the Approval Gate. Called from the API route
 * layer (src/api/routes/missions.ts), never from Mission Engine directly
 * (AT #7 — Mission Engine doesn't touch git). Rebases the Mission's latest
 * Execution branch onto the Project's protected/base branch and pushes it;
 * never merges, never opens a PR (the user does that manually).
 */
export function approveAndPush(missionId: string): PushResult {
  const mission = getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);
  const project = getProject(mission.project_id);
  if (!project) throw new Error(`Project ${mission.project_id} not found`);

  const executions = listExecutions(missionId);
  const latest = executions[executions.length - 1];
  if (!latest) return { pushed: false, reason: "no-execution" };

  const branchName = latest.branch_name ?? `agentspace/${latest.id}`;

  // .claude/plans/18-mock-provider-safety-and-prod-start.md P0 item 4 — a
  // simulation must never reach the merge flow. The API route already blocks
  // an 'approved' Decision on a mock Mission before we get here; this is the
  // belt-and-suspenders in the mechanical layer itself.
  if (latest.provider === "mock") {
    return { pushed: false, reason: "mock-run", branch_name: branchName };
  }
  // Phase 7.7: a stacked Mission goes out after the one it builds on.
  if (mission.base_mission_id) {
    const parent = getMission(mission.base_mission_id);
    if (parent && parent.status !== "completed") {
      return {
        pushed: false,
        reason: "parent-pending",
        branch_name: branchName,
        detail: `Approve "${parent.brief.slice(0, 60)}" first: this Mission is stacked on its branch.`,
      };
    }
  }
  refreshIfCached(project);
  const baseBranch = baseBranchFor(project, mission);

  return rebaseAndPushExecutionBranch(project.repo_path, branchName, baseBranch);
}

/**
 * .claude/plans/18-mock-provider-safety-and-prod-start.md P0 — did this
 * Mission's latest Execution run in simulation (mock) mode? Used by the API
 * route to refuse approving/pushing a mock result, and surfaced to the UI
 * (via the serialized Execution's `provider`) so a simulation never looks
 * like real agent work.
 */
export function isMissionMockRun(missionId: string): boolean {
  const executions = listExecutions(missionId);
  const latest = executions[executions.length - 1];
  return latest?.provider === "mock";
}

/**
 * .claude/plans/18-mock-provider-safety-and-prod-start.md P1 item 11 — discard
 * the local branch of a Mission the user rejected, so a rejected attempt
 * doesn't leave an orphan branch behind. Called from the API route (never
 * Mission Engine — AT #7: only this layer touches git). Deliberately local
 * only: never `origin`, never the base branch. Returns whether a branch was
 * actually deleted, plus the branch name for the UI's confirmation copy.
 */
export function discardMissionBranch(missionId: string): { deleted: boolean; branch_name?: string } {
  const mission = getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);
  const project = getProject(mission.project_id);
  if (!project) throw new Error(`Project ${mission.project_id} not found`);

  const executions = listExecutions(missionId);
  const latest = executions[executions.length - 1];
  const branchName = latest?.branch_name;
  if (!branchName) return { deleted: false };

  const deleted = deleteLocalBranch(project.repo_path, branchName);
  return { deleted, branch_name: branchName };
}

/**
 * .claude/plans/20-plano-consolidado.md Phase 1 — the neutral facts the
 * Approval Gate shows next to the Allow button: files touched (1.5), secrets
 * kept out of the commit (1.1), whether QA actually ran anything (1.4) and
 * what the Mission cost (1.6). Computed on read from what's already recorded;
 * nothing here blocks Allow.
 */
export interface GateFacts {
  rollup: FileRollup | null;
  secret_paths: string[];
  qa: QaActivity | null;
  cost: CostBreakdown;
  /** Phase 4 — what "done" means, judged criterion by criterion. Empty = none written or added. */
  criteria: GateCriterion[];
  findings: GateFinding[];
  /** Phase 4 — files changed outside the Planner's FILES: list; null without a plan list. */
  drift: { planned: string[]; unplanned: string[] } | null;
}

export function getGateFacts(missionId: string): GateFacts {
  const mission = getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);
  const project = getProject(mission.project_id);
  if (!project) throw new Error(`Project ${mission.project_id} not found`);

  const executions = listExecutions(missionId);
  const latest = executions[executions.length - 1];
  const latestEvidence = latest ? listEvidence(latest.id) : [];

  let rollup: FileRollup | null = null;
  const span = branchSpan(executions);
  if (span) {
    try {
      const from = branchForkPoint(missionId, span.afterSha) ?? span.beforeSha;
      rollup = buildFileRollup(diffNumstat(project.repo_path, from, span.afterSha), listArtifactsForMission(missionId));
    } catch (err) {
      // The commits can become unreachable (branch deleted by hand) — just
      // omit the rollup rather than failing the whole gate.
      console.error(`Mission ${missionId}: couldn't compute the file rollup:`, err);
    }
  }

  // Cost covers every Execution of the Mission (an iterate is a real, second
  // spend), grouped by role.
  const allEvidence = executions.flatMap((e) => (e === latest ? latestEvidence : listEvidence(e.id)));

  const plannedFiles = latestEvidencePayload<{ files: string[] }>(missionId, "plan_files")?.files;
  return {
    rollup,
    secret_paths: secretGuardPaths(latestEvidence),
    qa: qaActivity(latestEvidence),
    cost: sumExecutionCost(allEvidence),
    criteria: criteriaWithVerdicts(mission.acceptance_criteria, latestEvidence),
    findings: gateFindings(latestEvidence),
    drift: rollup ? planDrift(plannedFiles, rollup.files.map((f) => f.path)) : null,
  };
}

/**
 * .claude/plans/24-ideias-para-analisar.md item 5 — what the LAST adjustment
 * changed, as opposed to the branch's whole net change (the gate's rollup). Only
 * meaningful when the Mission has at least two Executions on the same branch
 * (an iterate continues its branch); the earlier one's end commit is the
 * "before". Both commits stay reachable in the Project's repo, same as the
 * rollup. Returns null when there is nothing to compare.
 */
export function getAdjustmentChanges(
  missionId: string
): { from_sha: string; to_sha: string; files: { path: string; added: number | null; removed: number | null }[] } | null {
  const mission = getMission(missionId);
  const project = mission ? getProject(mission.project_id) : undefined;
  if (!mission || !project) return null;
  const done = listExecutions(missionId).filter((e) => e.git_after_sha);
  const latest = done[done.length - 1];
  if (!latest?.branch_name) return null;
  const sameBranch = done.filter((e) => e.branch_name === latest.branch_name);
  if (sameBranch.length < 2) return null;
  const from = sameBranch[sameBranch.length - 2].git_after_sha!;
  const to = latest.git_after_sha!;
  if (from === to) return { from_sha: from, to_sha: to, files: [] };
  try {
    return { from_sha: from, to_sha: to, files: diffNumstat(project.repo_path, from, to) };
  } catch (err) {
    console.error(`Mission ${missionId}: couldn't compare the last two attempts:`, err);
    return null;
  }
}

/** One file's diff for getAdjustmentChanges. */
export function getAdjustmentFileDiff(missionId: string, path: string): string | undefined {
  const changes = getAdjustmentChanges(missionId);
  const mission = getMission(missionId);
  const project = mission ? getProject(mission.project_id) : undefined;
  if (!changes || !project) return undefined;
  // Only paths that really changed between the two commits: the path comes from
  // the query string and goes to git, so it must be one git itself listed.
  if (!changes.files.some((f) => f.path === path)) return undefined;
  return diffContent(project.repo_path, changes.from_sha, changes.to_sha, path);
}

/**
 * .claude/plans/24-ideias-para-analisar.md item 6 — copy-ready PR title + body
 * from the Mission's recorded data. Reuses the gate facts and the latest
 * Execution's Reasoning Summary; nothing is stored.
 */
export async function getPrDescription(missionId: string): Promise<{ title: string; body: string }> {
  const mission = getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);
  const executions = listExecutions(missionId);
  const latest = executions[executions.length - 1];
  const facts = getGateFacts(missionId);
  const summary = latest ? await getReasoningSummary(latest.id) : "No work has been recorded for this Mission yet.";
  const buildRow = latest ? listEvidence(latest.id).filter((e) => e.type === "build_check").pop() : undefined;
  const buildSummary = buildRow ? String((buildRow.payload as { summary?: string } | undefined)?.summary ?? "") || null : null;
  return formatPrDescription({
    brief: mission.brief,
    summary,
    rollup: facts.rollup,
    criteria: facts.criteria,
    buildSummary,
  });
}

export function listArtifactsForMission(missionId: string): Artifact[] {
  return getDb()
    .prepare(
      `SELECT a.* FROM artifacts a JOIN executions e ON e.id = a.execution_id WHERE e.mission_id = ? ORDER BY a.created_at DESC`
    )
    .all(missionId) as unknown as Artifact[];
}

export function getArtifact(id: string): Artifact | undefined {
  return getDb().prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as unknown as Artifact | undefined;
}

/**
 * Resolves a 'diff' Artifact's content_ref ("<beforeSha>..<afterSha>:<path>",
 * set in finalizeExecution below) into the actual diff text. Deliberately
 * diffs against the Project's repo_path, never the Execution's worktree path
 * — the worktree is torn down the moment its Execution ends (see
 * removeWorktree below), but the commits on its agentspace/<executionId>
 * branch stay reachable from the main repo's shared object database.
 */
export function getArtifactDiff(artifactId: string): string | undefined {
  const artifact = getArtifact(artifactId);
  if (!artifact || artifact.kind !== "diff") return undefined;

  const execution = getExecution(artifact.execution_id);
  if (!execution) return undefined;
  const mission = getMission(execution.mission_id);
  if (!mission) return undefined;
  const project = getProject(mission.project_id);
  if (!project) return undefined;

  const sepIndex = artifact.content_ref.indexOf("..");
  const beforeSha = artifact.content_ref.slice(0, sepIndex);
  const rest = artifact.content_ref.slice(sepIndex + 2);
  const colonIndex = rest.indexOf(":");
  const afterSha = rest.slice(0, colonIndex);
  const path = rest.slice(colonIndex + 1);

  return diffContent(project.repo_path, beforeSha, afterSha, path);
}

/**
 * Starts a new Execution under a Mission and runs it to completion via
 * whichever Provider Adapter is configured, asynchronously — this function
 * returns as soon as the Execution row exists and the worktree is ready,
 * consistent with Journey 1 ("free to walk away" the moment a Mission
 * begins). Completion is recorded, and notification signals fire, once the
 * provider run actually resolves.
 *
 * Returns `undefined` (instead of starting) when the concurrency cap is
 * already full — the Mission simply stays `queued`; both HTTP call sites
 * already treat this as fire-and-forget and don't use the resolved value,
 * and drainQueuedMissions() picks it back up once a slot frees.
 */
export async function startExecution(
  missionId: string,
  trigger: ExecutionTrigger,
  opts: {
    adjustment?: string;
    /** Phase 3.2 — the supervisor's answer to the team's question. */
    answer?: string;
    /** Phase 3.3 — what to change in the proposed plan. */
    planRevision?: string;
    /** Phase 7.4 — move the branch onto the current base first; the Developer resolves conflicts. */
    resolveConflict?: boolean;
  } = {}
): Promise<Execution | undefined> {
  if (startingMissions.has(missionId)) return undefined;
  if (countRunningExecutions() + startingMissions.size >= MAX_CONCURRENT_EXECUTIONS) return undefined;
  if (usageLimitActive()) return undefined;

  const mission = getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);
  const project = getProject(mission.project_id);
  if (!project) throw new Error(`Project ${mission.project_id} not found`);

  const db = getDb();
  const priorExecutions = listExecutions(missionId);
  const lastSeq = priorExecutions.length > 0 ? priorExecutions[priorExecutions.length - 1].seq : 0;
  const latest = priorExecutions[priorExecutions.length - 1];

  // .claude/plans/18-mock-provider-safety-and-prod-start.md P1 (rejection
  // flow) — an iterate/resume Execution continues the SAME branch the prior
  // Execution built, starting from its tip, so the user's correction is
  // applied on top of the earlier work instead of branching fresh off base.
  // A first run (or one with no prior branch to continue) keeps the original
  // behavior: a new readable branch cut from the Project's current HEAD.
  const continuesPriorBranch =
    (trigger === "iterate" ||
      trigger === "resume-after-approval" ||
      trigger === "resume-after-limit" ||
      trigger === "resume-after-input") &&
    Boolean(latest?.branch_name);

  // .claude/plans/20-plano-consolidado.md Phase 3 — a resume continues the
  // previous Execution's provider sessions, not just its branch:
  //   - after the usage limit: the role that didn't finish;
  //   - after an answer: the role that asked (3.2);
  //   - a plan revision: the Planner (3.3);
  //   - an adjustment: the Developer, so it keeps its context (3.4); roles
  //     before it are skipped, later ones run fresh with the adjustment.
  const hasPlanner = mission.assigned_team.some((t) => t.role === "Planner");
  let resume: ProviderRunInput["resume"];
  let answerRecord: { question?: string; answer: string } | undefined;
  if (trigger === "resume-after-limit") {
    resume = buildResumeInput(latest, RESUME_AFTER_LIMIT_NOTE);
  } else if (trigger === "resume-after-input" && opts.planRevision) {
    resume = buildResumeInput(
      latest,
      `The user reviewed your plan and asked for changes:\n${opts.planRevision}\nWrite the revised plan in full (same format).`,
      "Planner"
    );
  } else if (trigger === "resume-after-input" && opts.answer) {
    const asked = latestEvidencePayload<{ question: string }>(missionId, "clarification_request");
    answerRecord = { question: asked?.question, answer: opts.answer };
    resume = buildResumeInput(latest, answerNote(asked?.question, opts.answer));
  } else if (trigger === "iterate" && opts.adjustment) {
    resume = buildResumeInput(latest, adjustmentNote(opts.adjustment), "Developer");
  }
  // Phase 3.3 — a checkpoint Mission runs the Planner alone until its plan is approved.
  const planOnly = mission.plan_checkpoint && !mission.approved_plan && hasPlanner;

  // .claude/plans/20-plano-consolidado.md item 1.7 — the only await before the
  // Execution row exists; startingMissions holds this Mission's slot meanwhile.
  let branchSlug: string | undefined;
  startingMissions.add(missionId);
  try {
    if (!continuesPriorBranch) branchSlug = await synthesizeBranchSlug(mission.brief);
  } finally {
    startingMissions.delete(missionId);
  }
  // A Cancel may have landed while the name was being synthesized.
  const current = getMission(missionId);
  if (!current || current.status === "cancelled") return undefined;
  // A resume only makes sense while the Mission is still waiting for it.
  if (trigger === "resume-after-limit" && current.status !== "waiting") return undefined;
  if (trigger === "resume-after-input" && current.status !== "waiting") return undefined;

  const id = newId();
  const startedAt = new Date().toISOString();
  const provider = getActiveProviderName();

  let beforeSha: string;
  let branchName: string;
  let worktreePath: string;
  const pendingEvidence: { type: string; payload: unknown }[] = [];
  let conflictAdjustment: string | undefined;
  if (continuesPriorBranch && latest?.branch_name) {
    branchName = latest.branch_name;
    worktreePath = createWorktreeFromBranch(project.repo_path, id, branchName);
    // The branch tip we just checked out is this Execution's baseline, so the
    // diff Artifacts show only what the adjustment changed on top of it.
    beforeSha = currentHeadSha(worktreePath);
    if (opts.resolveConflict) {
      // Phase 7.4 — squash + rebase onto the current base; the baseline is then
      // the base tip, so this Execution's diff is the whole Mission's change.
      refreshIfCached(project);
      const base = baseBranchFor(project, mission);
      const moved = squashAndRebaseOntoBase(worktreePath, base, buildCommitMessage(missionId, id).slice(1).filter((a) => a !== "-m").join("\n\n"));
      beforeSha = moved.baseSha;
      conflictAdjustment =
        moved.conflicts.length > 0
          ? [
              CONFLICT_NOTE_PREFIX,
              `These files now contain git conflict markers (<<<<<<< ======= >>>>>>>): ${moved.conflicts.join(", ")}.`,
              `Edit each one so it keeps the intent of BOTH sides (the latest ${base} and this Mission's change), and remove every marker. Don't run git commands; AgentSpace finishes the rebase when you're done.`,
            ].join("\n")
          : `${CONFLICT_NOTE_PREFIX} It applied cleanly onto the latest ${base}. Check that the change still works with the new base and fix anything that broke.`;
      pendingEvidence.push({ type: "base_rebase", payload: { base, conflicts: moved.conflicts } });
      // The Developer's own session continues, told exactly what to resolve.
      resume = buildResumeInput(latest, adjustmentNote(conflictAdjustment), "Developer");
    }
  } else {
    refreshIfCached(project);
    // Phase 7.7: a stacked Mission starts from its parent's branch tip.
    beforeSha = currentHeadSha(project.repo_path, mission.base_branch && refExists(project.repo_path, mission.base_branch) ? mission.base_branch : "HEAD");
    branchName = buildExecutionBranchName(branchSlug ?? slugify(mission.brief), id);
    worktreePath = createWorktree(project.repo_path, id, branchName, beforeSha);
  }

  db.prepare(
    `INSERT INTO executions (id, mission_id, seq, trigger, started_at, git_before_sha, worktree_path, branch_name, provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, missionId, lastSeq + 1, trigger, startedAt, beforeSha, worktreePath, branchName, provider);

  if (current.status !== "running") transitionMissionStatus(missionId, "running");
  for (const e of pendingEvidence) recordEvidence(id, e.type, e.payload);
  // Phase 3.2 — the answer is part of the record: shown in Process, and the
  // Reasoning Summary can cite it.
  if (answerRecord) recordEvidence(id, "clarification_answer", answerRecord);
  if (opts.planRevision) recordEvidence(id, "plan_revision_request", { note: opts.planRevision });
  eventBus.emitNotification({ type: "execution.started", id });

  // .claude/plans/15-live-execution-feedback.md Part 3 — register a live
  // cancellation handle before the run starts, so a Cancel arriving mid-run
  // can reach the provider process.
  const controller = new AbortController();
  runningControllers.set(id, controller);

  // Fire-and-forget: the caller does not wait on the provider run.
  runToCompletion(id, current, project.permission_policy, worktreePath, beforeSha, controller.signal, {
    adjustment: conflictAdjustment ?? opts.adjustment,
    resume,
    planOnly: planOnly || Boolean(opts.planRevision),
    allowQuestions: countEvidenceOfType(missionId, "clarification_request") < MAX_QUESTIONS_PER_MISSION,
  }).catch((err) => {
    // A crash in the run pipeline itself (not a provider failure). Recorded as
    // a failure, not 'interrupted': an interrupted outcome leaves the Mission's
    // status alone, which left a crashed Mission stuck in 'running' forever
    // (found in plan 20 Phase 3.2 testing). 'failed' offers the adjustment panel.
    console.error(`Execution ${id} crashed outside the provider run:`, err);
    finalizeExecution(id, missionId, worktreePath, beforeSha, "failure").catch((e) =>
      console.error(`Execution ${id}: finalize after crash also failed:`, e)
    );
  });

  const execution = getExecution(id);
  if (!execution) throw new Error("Failed to read back newly started execution");
  return execution;
}

async function runToCompletion(
  executionId: string,
  mission: NonNullable<ReturnType<typeof getMission>>,
  permissionPolicy: PermissionPolicy,
  worktreePath: string,
  beforeSha: string,
  signal: AbortSignal,
  opts: {
    adjustment?: string;
    resume?: ProviderRunInput["resume"];
    planOnly?: boolean;
    allowQuestions?: boolean;
  } = {}
): Promise<void> {
  const db = getDb();

  // .claude/plans/15-live-execution-feedback.md Part 1 — persist Evidence as
  // it arrives, not in one batch at the end. Before this, MissionDetail had
  // literally nothing to show while a Mission ran (now up to 4 sequential
  // role invocations, plan 14), so the user was blind for minutes. A live seq
  // counter replaces the old `events.forEach((e, i) => ...)` in finalize.
  const insertEvidence = db.prepare(
    `INSERT INTO evidence (id, execution_id, seq, type, payload, occurred_at, team_member_role) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // Continue after anything already recorded for this Execution before the
  // run started (e.g. the supervisor's answer, Phase 3.2).
  let seq = (
    db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM evidence WHERE execution_id = ?").get(executionId) as unknown as { s: number }
  ).s;

  // Throttled SSE (see EVIDENCE_SSE_INTERVAL_MS): leading-edge emit, plus a
  // single trailing timer so the final write in a quiet burst still notifies.
  let lastEmit = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    lastEmit = Date.now();
    eventBus.emitNotification({ type: "evidence.recorded", id: executionId });
  };
  const notifyThrottled = () => {
    const elapsed = Date.now() - lastEmit;
    if (elapsed >= EVIDENCE_SSE_INTERVAL_MS) {
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
      flush();
    } else if (!pending) {
      pending = setTimeout(() => {
        pending = null;
        flush();
      }, EVIDENCE_SSE_INTERVAL_MS - elapsed);
    }
  };

  const usageTriggers: UsageCaptureTrigger[] = [];

  const adapter = getProviderAdapter();
  const result = await adapter.run({
    worktreePath,
    brief: mission.brief,
    assignedTeam: mission.assigned_team,
    referenceMaterial: mission.reference_material ?? undefined,
    permissionPolicy,
    adjustment: opts.adjustment,
    resume: opts.resume,
    allowQuestions: opts.allowQuestions,
    acceptanceCriteria: mission.acceptance_criteria,
    projectInstructions: getProject(mission.project_id)?.instructions ?? null,
    roleInstructions: getProject(mission.project_id)?.role_instructions ?? {},
    ...(opts.planOnly ? { stopAfterRole: "Planner" } : {}),
    ...(mission.approved_plan ? { approvedPlan: mission.approved_plan, skipRoles: ["Planner"] } : {}),
    signal,
    onEvent: (event) => {
      seq += 1;
      insertEvidence.run(newId(), executionId, seq, event.type, JSON.stringify(event.raw), event.occurredAt, event.role ?? null);
      // .claude/plans/04-usage-rate-limit.md — kept live too, so the usage
      // pill updates during a long run, not only after it ends.
      if (event.type === "rate_limit_event") recordRateLimitInfo(event.raw as RateLimitInfo);
      const trigger = usageCaptureTrigger(event.type, event.raw, event.role, event.occurredAt);
      if (trigger) usageTriggers.push(trigger);
      notifyThrottled();
    },
  });

  if (pending) {
    clearTimeout(pending);
    pending = null;
  }

  // .claude/plans/20-plano-consolidado.md item 1.8 — written only now, once the
  // provider processes have closed and their exit codes/stderr exist too.
  if (usageTriggers.length > 0) {
    try {
      const file = writeUsageCapture(executionId, usageTriggers, {
        exits: result.events.filter((e) => e.type === "provider_exit").map((e) => ({ role: e.role ?? null, ...(e.raw as object) })),
        stderr: result.events.filter((e) => e.type === "stderr").map((e) => ({ role: e.role ?? null, text: e.raw })),
      });
      console.warn(`Execution ${executionId}: usage-limit capture trap fired — raw evidence saved to ${file}`);
      recordEvidence(executionId, "usage_limit_capture", {
        file,
        triggers: usageTriggers.map((t) => t.kind),
        message: "The provider reported a non-allowed usage status or an error result; raw details were saved for diagnosis.",
      });
    } catch (err) {
      console.error(`Execution ${executionId}: failed to write usage-limit capture:`, err);
    }
  }

  // .claude/plans/20-plano-consolidado.md Phase 3 — remember which provider
  // session each role ran in, so a later Execution can --resume it.
  saveRoleSessions(executionId, result);

  // Phase 4 (D4) — the Planner fills in criteria the user didn't write, and
  // its FILES: line is kept for the drift signal at the gate.
  const planner = result.sessions.find((s) => s.role === "Planner");
  if (planner?.finalText) {
    addPlannerCriteria(mission.id, markerLines(planner.finalText, "CRITERION+:"));
    const files = splitFiles(markerLines(planner.finalText, "FILES:"));
    if (files.length > 0) recordEvidence(executionId, "plan_files", { files });
  }
  const reviewerText = result.sessions.find((s) => s.role === "Reviewer" && s.completed)?.finalText;
  // Phase 6 — QA reports problems as FINDING lines; kept as a verdict (no
  // Review: QA gives no recommendation) so the gate and the loop see them.
  const qaText = result.sessions.find((s) => s.role === "QA" && s.completed)?.finalText;
  if (qaText && result.outcome === "success") {
    const parsed = parseVerdict(qaText);
    if (parsed.findings.length > 0) recordVerdict(executionId, "QA", parsed, mission.acceptance_criteria.map((c) => c.text));
  }

  let paused: { reason: WaitingReason; resetsAt?: number } | undefined;
  if (result.paused?.reason === "usage-limit") {
    paused = { reason: "usage-limit", resetsAt: result.paused.resetsAt };
  } else if (result.paused?.reason === "needs-input") {
    // Phase 3.2 — the question becomes part of the record; the Mission waits.
    recordEvidence(executionId, "clarification_request", { question: result.paused.question, role: result.paused.role });
    paused = { reason: "needs-input" };
  } else if (opts.planOnly && result.outcome === "success") {
    // Phase 3.3 — the Planner's answer IS the plan the supervisor reviews.
    const plan = planner?.finalText?.trim();
    if (plan) {
      recordEvidence(executionId, "plan_proposal", { plan, files: splitFiles(markerLines(plan, "FILES:")) });
      paused = { reason: "plan-review" };
    }
  }

  await finalizeExecution(executionId, mission.id, worktreePath, beforeSha, result.outcome, paused, reviewerText);
}

/** "a.ts, b.ts" lines from FILES: markers into a clean path list. */
function splitFiles(lines: string[]): string[] {
  return [...new Set(lines.flatMap((l) => l.split(",")).map((f) => unwrapBackticks(f)).filter(Boolean))];
}

/**
 * .claude/plans/20-plano-consolidado.md Phase 4 — record what an AI reviewer
 * said in the one verdict format. The Evidence always keeps it (criteria,
 * findings, free text) for the gate; an AI Review is created only when there
 * was an explicit VERDICT, so nothing is ever invented.
 */
function recordVerdict(executionId: string, by: string, parsed: ParsedVerdict, criteriaTexts: string[]): void {
  recordEvidence(executionId, "review_verdict", {
    by,
    outcome: parsed.outcome ?? null,
    criteria: parsed.criteria.map((c) => ({ ...c, text: criteriaTexts[c.n - 1] ?? null })),
    findings: parsed.findings,
    free_text: parsed.freeText.slice(0, 4000),
  });
}

function saveRoleSessions(executionId: string, result: ProviderRunResult): void {
  const insert = getDb().prepare(
    "INSERT OR REPLACE INTO execution_role_sessions (execution_id, role, provider, session_id, completed) VALUES (?, ?, ?, ?, ?)"
  );
  const provider = getActiveProviderName();
  for (const s of result.sessions) insert.run(executionId, s.role, provider, s.sessionId, s.completed ? 1 : 0);
}

/**
 * A readable commit message for the Execution's net changes, derived from the
 * Mission's own brief instead of the opaque `Execution <id>` this used to write.
 * Deterministic (no extra provider call in the commit path): subject = the
 * brief on one line, trimmed to a conventional ~72 chars; the full brief goes
 * in the body when the subject had to truncate it; a trailer keeps the Mission
 * and Execution ids for traceability (the id used to be the whole message).
 * Returns `git commit` args — one `-m` per paragraph, which git separates with
 * blank lines.
 */
const COMMIT_SUBJECT_MAX = 72;
function buildCommitMessage(missionId: string, executionId: string): string[] {
  const mission = getMission(missionId);
  const brief = (mission?.brief ?? "").replace(/\s+/g, " ").trim();
  const subject =
    brief.length > COMMIT_SUBJECT_MAX ? `${brief.slice(0, COMMIT_SUBJECT_MAX - 1).trimEnd()}…` : brief || `Execution ${executionId}`;

  const roles = mission?.assigned_team.map((m) => m.role).join(", ") || "—";
  const args = ["commit", "-m", subject];
  // Only repeat the brief in the body when the subject actually clipped it —
  // no point echoing an identical line.
  if (brief && brief !== subject) args.push("-m", brief);
  args.push("-m", `Mission: ${missionId} · Team: ${roles}\nExecution: ${executionId}`);
  return args;
}

/**
 * Appends one Evidence row after the provider run (build check, secret guard,
 * usage capture…), numbered after whatever the run already wrote. Not
 * attributable to one Team Member, so role is null.
 */
function recordEvidence(executionId: string, type: string, payload: unknown): void {
  const db = getDb();
  const { s } = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM evidence WHERE execution_id = ?")
    .get(executionId) as unknown as { s: number };
  db.prepare(
    `INSERT INTO evidence (id, execution_id, seq, type, payload, occurred_at, team_member_role) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(newId(), executionId, s, type, JSON.stringify(payload), new Date().toISOString(), null);
}

async function finalizeExecution(
  executionId: string,
  missionId: string,
  worktreePath: string,
  beforeSha: string,
  outcome: "success" | "failure" | "interrupted",
  paused?: { reason: WaitingReason; resetsAt?: number },
  reviewerText?: string
): Promise<void> {
  const db = getDb();

  // .claude/plans/15-live-execution-feedback.md Part 3 — the run is over; drop
  // its cancellation handle so a late Cancel can't try to abort a finished
  // process.
  runningControllers.delete(executionId);

  // Evidence is no longer inserted here — it was written incrementally as it
  // arrived (runToCompletion's onEvent, plan 15 Part 1), and the last
  // rate_limit_event was already recorded live along the way.

  // Commit whatever the provider changed in the worktree so there's a real
  // afterSha to diff against — each Execution ends with a commit capturing
  // its net changes, a v1 convention this scaffold adopts to keep "diff
  // between two commits" simple rather than diffing an uncommitted tree.
  let afterSha = beforeSha;
  let changedFiles: { path: string; status: string }[] = [];
  // A usage-limit pause is 'interrupted' too, but its partial work is real and
  // the resumed Execution continues from it, so it IS committed to the branch.
  if (outcome !== "interrupted" || paused) {
    try {
      // .claude/plans/18-mock-provider-safety-and-prod-start.md P2 item 8 —
      // AgentSpace writes .mcp.json into every worktree itself (plan 01), so
      // committing it made it show up as a changed file in EVERY Mission's
      // diff — the exact thing that made a no-op (mock) Mission look like it
      // "created the .mcp.json." Exclude it from staging via a pathspec so it
      // never becomes part of the Mission's commit or diff. A run whose only
      // change was .mcp.json now correctly produces zero Artifacts.
      //
      // .claude/plans/20-plano-consolidado.md item 1.1 — secret-looking files
      // (.env, keys, …) are excluded the same way, and recorded as Evidence
      // so the Approval Gate can flag them. They stay in the worktree only,
      // which is torn down below; they never reach the branch or origin.
      const secretPaths = findSecretPaths(worktreePath).filter((p) => p !== ".mcp.json");
      if (secretPaths.length > 0) {
        recordEvidence(executionId, "secret_guard", {
          excluded_paths: secretPaths,
          message: "These files looked like secrets and were left out of the Mission's commit.",
        });
      }
      execFileSync("git", ["add", "-A", "--", ".", ":(exclude).mcp.json", ...excludePathspecs(secretPaths)], {
        cwd: worktreePath,
      });
      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: worktreePath,
        encoding: "utf-8",
      }).trim();
      if (isRebaseInProgress(worktreePath)) {
        // Phase 7.4 — the conflict-fix Execution: the Developer edited the
        // conflicted files; staging them above resolved the stopped rebase.
        execFileSync("git", ["-c", "core.editor=true", "rebase", "--continue"], { cwd: worktreePath });
      } else if (staged) {
        execFileSync("git", buildCommitMessage(missionId, executionId), { cwd: worktreePath });
      }
      // HEAD is read unconditionally: a role that ran `git commit` itself, or
      // the conflict fix above, moves HEAD with nothing left staged. Reading it
      // only after our own commit used to miss those commits entirely.
      afterSha = currentHeadSha(worktreePath);
      if (afterSha !== beforeSha) changedFiles = diffSummary(worktreePath, beforeSha, afterSha);
    } catch (err) {
      console.error(`Execution ${executionId}: failed to commit/diff worktree changes:`, err);
    }
  }

  const insertArtifact = db.prepare(
    `INSERT INTO artifacts (id, execution_id, kind, title, content_ref) VALUES (?, ?, 'diff', ?, ?)`
  );
  const diffArtifactIds: string[] = [];
  for (const file of changedFiles) {
    const artifactId = newId();
    insertArtifact.run(artifactId, executionId, file.path, `${beforeSha}..${afterSha}:${file.path}`);
    diffArtifactIds.push(artifactId);
  }

  const repoPath = getProject(getMission(missionId)!.project_id)!.repo_path;

  // .claude/plans/16-build-verification.md — run the project's build twice
  // (baseline vs. result) so "completed" can tell "already broken" from "this
  // Mission broke it." Only when the run succeeded and actually changed files:
  // a no-op or interrupted run has nothing to regress. The worktree is still
  // present here (removeWorktree is below), so the "result" build reflects the
  // Mission's output; the baseline runs in a throwaway worktree at beforeSha.
  if (outcome === "success" && changedFiles.length > 0) {
    try {
      runBuildVerification(executionId, repoPath, worktreePath, beforeSha, afterSha);
    } catch (err) {
      console.error(`Execution ${executionId}: build verification crashed (skipped):`, err);
    }
  }

  // .claude/plans/20-cross-model-review-council.md Phase 1 — when the Team
  // includes a Challenger, run an independent adversarial review of the diff and
  // record it as an AI Review (advice, surfaced in the Approval Gate). Done here,
  // before the Mission is transitioned to awaiting-approval below (via
  // applyExecutionOutcome), so the review is already present when the supervisor
  // opens the gate. Only when the run actually produced changes — nothing to
  // challenge otherwise. Best-effort: a failure never blocks finalizing.
  const missionForChallenger = getMission(missionId);
  const criteria = missionForChallenger?.acceptance_criteria ?? [];
  const artifactIdByPath = new Map(changedFiles.map((f, i) => [f.path, diffArtifactIds[i]]));

  // .claude/plans/20-plano-consolidado.md Phase 4 — the Reviewer role's answer
  // in the shared verdict format (criterion by criterion, findings).
  if (outcome === "success" && !paused && reviewerText) {
    try {
      const parsed = parseVerdict(reviewerText);
      recordVerdict(executionId, "Reviewer", parsed, criteria.map((c) => c.text));
      if (parsed.outcome) {
        submitAiReview(missionId, "Reviewer", {
          artifact_ids: diffArtifactIds,
          recommendation_outcome: parsed.outcome,
          recommendation_rationale: parsed.freeText || "The Reviewer gave a verdict without further comment.",
          findings: findingsForArtifacts(parsed, artifactIdByPath),
        });
      }
    } catch (err) {
      console.error(`Execution ${executionId}: recording the Reviewer's verdict failed (skipped):`, err);
    }
  }

  if (
    outcome === "success" &&
    changedFiles.length > 0 &&
    missionForChallenger &&
    assignedTeamHasChallenger(missionForChallenger.assigned_team)
  ) {
    let diffText = "";
    try {
      diffText = execFileSync("git", ["diff", beforeSha, afterSha], { cwd: worktreePath, encoding: "utf-8" });
    } catch (err) {
      console.error(`Execution ${executionId}: couldn't read diff for Challenger review:`, err);
    }
    try {
      const parsed = await runChallengerReview({
        missionId,
        brief: missionForChallenger.brief,
        referenceMaterial: missionForChallenger.reference_material ?? undefined,
        criteria,
        diffText,
        artifactIds: diffArtifactIds,
        artifactIdByPath,
      });
      if (parsed) recordVerdict(executionId, "Challenger", parsed, criteria.map((c) => c.text));
    } catch (err) {
      console.error(`Execution ${executionId}: Challenger review crashed (skipped):`, err);
    }
  }

  // .claude/plans/20-plano-consolidado.md item 1.6 — totals from the
  // provider's own `result` lines, stored once the run is over (never a live
  // gauge, guardrail #2). Null when the provider reported nothing (mock).
  const cost = sumExecutionCost(listEvidence(executionId));
  db.prepare(
    `UPDATE executions SET ended_at = ?, outcome = ?, git_after_sha = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, duration_ms = ? WHERE id = ?`
  ).run(
    new Date().toISOString(),
    outcome,
    afterSha,
    cost.total?.cost_usd ?? null,
    cost.total?.input_tokens ?? null,
    cost.total?.output_tokens ?? null,
    cost.total?.duration_ms ?? null,
    executionId
  );

  // What goes to the gate is the BRANCH, not this Execution's slice of it. An
  // Execution that continues a branch (adjustment, resume after the limit or
  // an answer, auto-fix round) and changes nothing more used to report 0 files
  // and mark the Mission 'completed', skipping approval of the earlier, still
  // unapproved changes (found in plan 20 Phase 6 testing). Counted before the
  // worktree goes away; the commits stay reachable from repoPath anyway.
  let branchChangedFileCount = changedFiles.length;
  const forkPoint = branchForkPoint(missionId, afterSha);
  if (forkPoint && forkPoint !== beforeSha) {
    try {
      branchChangedFileCount = Math.max(branchChangedFileCount, diffSummary(repoPath, forkPoint, afterSha).length);
    } catch (err) {
      console.error(`Execution ${executionId}: couldn't measure the branch's total changes:`, err);
    }
  }

  // Plan 25: an app the supervisor launched from this worktree can't outlive it.
  stopPreviewsInFolder(worktreePath);
  removeWorktree(repoPath, worktreePath);

  eventBus.emitNotification({ type: "execution.ended", id: executionId });

  const applied = applyExecutionOutcome(missionId, {
    outcome,
    changedFileCount: branchChangedFileCount,
    ...(paused
      ? {
          paused: {
            reason: paused.reason,
            ...(paused.reason === "usage-limit" ? { resumeAt: resumeTimeAfterLimit(missionId, paused.resetsAt) } : {}),
          },
        }
      : {}),
  });

  // .claude/plans/20-plano-consolidado.md Phase 6 (D3) — the correction loop.
  // Mission Engine decides; this layer only starts the round it was told to.
  if (applied.status === "awaiting-approval") maybeStartAutoFix(missionId, executionId);

  drainQueuedMissions();
}

function maybeStartAutoFix(missionId: string, executionId: string): void {
  const mission = getMission(missionId);
  const project = mission ? getProject(mission.project_id) : undefined;
  if (!mission || !project?.auto_fix_loop) return;
  const verdicts = listEvidence(executionId)
    .filter((e) => e.type === "review_verdict")
    .map((e) => e.payload as Parameters<typeof decideAutoFix>[1]["verdicts"][number]);
  const adjustment = decideAutoFix(missionId, { autoFixEnabled: true, verdicts });
  if (!adjustment) return;

  // Plan 24 item 7 — an automatic round is spending nobody asked for just now,
  // so it respects the Project's weekly budget; the gate shows the Mission as is.
  if (budgetStatus(project).reached) {
    recordEvidence(executionId, "auto_fix_skipped", { reason: "weekly budget reached" });
    return;
  }

  // Never through 'queued': a queued Mission is drained as a fresh 'initial'
  // run on a new branch. No free slot now → no round; the gate shows it as is.
  const can = canStartExecutionNow(missionId);
  if (!can.ok) {
    recordEvidence(executionId, "auto_fix_skipped", { reason: can.reason });
    return;
  }
  const round = registerIterateAttempt(missionId);
  if (!round.allowed) return;
  recordEvidence(executionId, "auto_fix", { round: round.count, adjustment });
  startExecution(missionId, "iterate", { adjustment }).catch((err) =>
    console.error(`Mission ${missionId}: automatic correction round failed to start:`, err)
  );
}

/**
 * .claude/plans/16-build-verification.md — the build check itself. Runs the
 * detected command against the Mission's result (the Execution worktree, still
 * present) and against the pre-Mission baseline (a throwaway worktree at
 * beforeSha), then records:
 *   - a `test_report` Artifact (kind first populated by this plan) whose
 *     summary is the plain-language verdict and whose content_ref holds the
 *     full output of both runs;
 *   - a `build_check` Evidence row, so the Reasoning Summary (plan 09) can
 *     mention the real result rather than leaving it out.
 * When no npm build/test script exists, records a single `build_check_skipped`
 * Evidence note — never an error, never a fabricated pass.
 */
function runBuildVerification(
  executionId: string,
  repoPath: string,
  worktreePath: string,
  beforeSha: string,
  afterSha: string
): void {
  const db = getDb();
  const insertEvidence = db.prepare(
    `INSERT INTO evidence (id, execution_id, seq, type, payload, occurred_at, team_member_role) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const nextSeq = (): number => {
    const { s } = db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM evidence WHERE execution_id = ?")
      .get(executionId) as unknown as { s: number };
    return s;
  };

  const command = detectBuildCommand(worktreePath);
  if (!command) {
    insertEvidence.run(
      newId(),
      executionId,
      nextSeq(),
      "build_check_skipped",
      JSON.stringify({ message: "No npm build/test script detected — build verification skipped." }),
      new Date().toISOString(),
      null
    );
    return;
  }

  // Result first (Mission's output), then baseline (pre-Mission state).
  const result = runBuildCheckWithDeps(repoPath, worktreePath, command);
  const basePath = createTempWorktreeAtSha(repoPath, beforeSha);
  let baseline;
  try {
    baseline = runBuildCheckWithDeps(repoPath, basePath, command);
  } finally {
    removeWorktree(repoPath, basePath);
  }

  const verdict = buildVerdict(baseline, result);
  const content = buildReportContent(command, baseline, result);

  db.prepare(
    `INSERT INTO artifacts (id, execution_id, kind, title, content_ref, summary) VALUES (?, ?, 'test_report', ?, ?, ?)`
  ).run(newId(), executionId, verdict.title, content, verdict.summary);

  insertEvidence.run(
    newId(),
    executionId,
    nextSeq(),
    "build_check",
    JSON.stringify({
      state: verdict.state,
      summary: verdict.summary,
      baseline_passed: baseline.passed,
      result_passed: result.passed,
      command: command.join(" "),
    }),
    new Date().toISOString(),
    null
  );
}

/**
 * .claude/plans/02-parallel-isolation.md item 2 — if the AgentSpace process
 * dies mid-Execution, its worktree and branch are left behind (finalizeExecution
 * above, which calls removeWorktree, never runs). Called once at server boot
 * (server.ts): anything `git worktree list` reports that isn't backed by a
 * still-`running` Execution row is orphaned — mark it `interrupted` and remove
 * the worktree, rather than leaving a silent, permanently-open Execution.
 */
export function reconcileOrphanedWorktrees(): void {
  const db = getDb();
  const runningExecutions = db
    .prepare("SELECT id, mission_id, worktree_path FROM executions WHERE ended_at IS NULL")
    .all() as unknown as { id: string; mission_id: string; worktree_path: string }[];

  const projects = db.prepare("SELECT id, repo_path FROM projects").all() as unknown as { id: string; repo_path: string }[];

  for (const project of projects) {
    // A moved/deleted repo folder isn't an error worth a stack trace at every
    // boot — the UI already flags it (Project.repo_available).
    if (!existsSync(project.repo_path)) {
      console.warn(`Skipping worktree reconciliation for project ${project.id}: folder not found (${project.repo_path}).`);
      continue;
    }
    let worktreePaths: string[];
    try {
      worktreePaths = listWorktrees(project.repo_path);
    } catch (err) {
      console.error(`Failed to list worktrees for project ${project.id} during boot reconciliation:`, err);
      continue;
    }

    for (const worktreePath of worktreePaths) {
      const owningExecution = runningExecutions.find((e) => e.worktree_path === worktreePath);
      if (owningExecution) continue; // still legitimately running — leave it alone

      console.warn(`Reconciling orphaned worktree from a previous run: ${worktreePath}`);
      removeWorktree(project.repo_path, worktreePath);
    }
  }

  // The inverse case: a running Execution row whose worktree is already gone
  // (e.g. removed by hand). Nothing left to clean up on disk, but the
  // Execution row must not sit open forever pretending to still be live.
  for (const execution of runningExecutions) {
    db.prepare(`UPDATE executions SET ended_at = ?, outcome = 'interrupted' WHERE id = ?`).run(
      new Date().toISOString(),
      execution.id
    );
    eventBus.emitNotification({ type: "execution.ended", id: execution.id });
  }
}
