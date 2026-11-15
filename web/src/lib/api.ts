// Thin client over docs/07-SCHEMA_API_CONTRACT.md §7 (mirrored in src/api/routes/*.ts).
// Never caches: every call re-fetches, matching the SSE model in
// docs/03-ARCHITECTURE.md §7 ("re-read the record, don't trust the notification payload").
import type {
  Artifact,
  BudgetStatus,
  NeedsEnvVar,
  PreviewInfo,
  RunConfig,
  Decision,
  DecisionOutcome,
  DecisionTier,
  Evidence,
  Execution,
  Finding,
  GateFacts,
  Mission,
  WaitingDetails,
  MissionChecks,
  MissionStatus,
  PermissionPolicy,
  Project,
  ProviderName,
  PushResult,
  RateLimitState,
  RecommendationOutcome,
  Review,
  Routine,
  RoutineCadence,
  TeamRosterEntry,
  TimelineEntry,
  TrustLedgerAggregate,
} from "./types";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// -- Projects --------------------------------------------------------------

export function listProjects(): Promise<Project[]> {
  return request("/projects");
}

export function getProject(id: string): Promise<Project> {
  return request(`/projects/${id}`);
}

// .claude/plans/19-clone-git-repository.md — either a local `repo_path` or a
// `clone_url` AgentSpace clones into a managed directory.
// Phase 7.9: `bare_cache` keeps only a bare cache (no working folder) for a cloned URL.
export function onboardProject(input: { repo_path?: string; clone_url?: string; bare_cache?: boolean; name?: string }): Promise<Project> {
  return request("/projects", { method: "POST", body: JSON.stringify(input) });
}

// .claude/plans/17-ux-navigation-polish.md P1 — check a local path before submit.
export function validateRepoPath(repo_path: string): Promise<{ exists: boolean; is_git_repo: boolean }> {
  return request("/projects/validate-path", { method: "POST", body: JSON.stringify({ repo_path }) });
}

// .claude/plans/19-clone-git-repository.md — remove a Project. A cloned Project's
// managed directory is deleted too; a local one is only disconnected.
export function deleteProject(id: string): Promise<{ deleted: boolean; origin_kind: string; directory_removed: boolean }> {
  return request(`/projects/${id}`, { method: "DELETE" });
}

export function updateProject(
  id: string,
  input: {
    name?: string;
    team_roster?: TeamRosterEntry[];
    permission_policy?: PermissionPolicy;
    repo_path?: string;
    auto_fix_loop?: boolean;
    instructions?: string | null;
    role_instructions?: Record<string, string>;
    weekly_budget_usd?: number | null;
    routine_exclusions?: string[];
    run_command?: string | null;
    install_command?: string | null;
    preview_port?: number | null;
  },
): Promise<Project> {
  return request(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

// .claude/plans/11-project-settings-screen.md — write-only, mirrors the
// backend (POST /projects/:id/github-token, §7): the token is stored but never
// echoed back on any GET, so the Settings form can set it but never displays it.
export function setGithubToken(id: string, token: string): Promise<void> {
  return request(`/projects/${id}/github-token`, { method: "POST", body: JSON.stringify({ token }) });
}

// .claude/plans/17-ux-navigation-polish.md — asks the local backend to open the
// Project's repo folder in the OS file manager (a browser can't do this itself).
export function revealProjectFolder(id: string): Promise<void> {
  return request(`/projects/${id}/reveal`, { method: "POST" });
}

export function listMissions(projectId: string, status?: MissionStatus): Promise<Mission[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return request(`/projects/${projectId}/missions${qs}`);
}

export function createMission(
  projectId: string,
  input: {
    brief: string;
    reference_material?: unknown;
    assigned_team?: { role: string }[];
    plan_checkpoint?: boolean;
    acceptance_criteria?: string[];
    /** Phase 7.7: build on another Mission's branch. */
    base_mission_id?: string;
  },
): Promise<Mission> {
  return request(`/projects/${projectId}/missions`, { method: "POST", body: JSON.stringify(input) });
}

// .claude/plans/20-plano-consolidado.md Phase 3 — a 'waiting' Mission's details
// and the two supervisor actions that resume it.
export function getWaitingDetails(missionId: string): Promise<WaitingDetails> {
  return request(`/missions/${missionId}/waiting`);
}

export function resolveConflict(missionId: string): Promise<Mission> {
  return request(`/missions/${missionId}/resolve-conflict`, { method: "POST" });
}

export function answerQuestion(missionId: string, answer: string): Promise<Mission> {
  return request(`/missions/${missionId}/answer`, { method: "POST", body: JSON.stringify({ answer }) });
}

export function reviewPlan(missionId: string, action: "approve" | "revise" | "discard", note?: string): Promise<Mission> {
  return request(`/missions/${missionId}/plan`, { method: "POST", body: JSON.stringify({ action, note }) });
}

export function projectTimeline(projectId: string): Promise<TimelineEntry[]> {
  return request(`/projects/${projectId}/timeline`);
}

export function projectTrustLedger(
  projectId: string,
  opts: { window?: string; pathPrefix?: string } = {},
): Promise<TrustLedgerAggregate[]> {
  const params = new URLSearchParams();
  if (opts.window) params.set("window", opts.window);
  if (opts.pathPrefix) params.set("path_prefix", opts.pathPrefix);
  const qs = params.toString() ? `?${params}` : "";
  return request(`/projects/${projectId}/trust-ledger${qs}`);
}

// -- Missions ----------------------------------------------------------------

export function getMission(id: string): Promise<Mission> {
  return request(`/missions/${id}`);
}

export function confirmMission(id: string): Promise<Mission> {
  return request(`/missions/${id}/confirm`, { method: "POST" });
}

// `exclude` (plan 24 item 2): also tell routines never to propose this again; a
// string is the short text to remember, `true` uses the brief.
export function dismissMission(id: string, exclude?: string | boolean): Promise<Mission> {
  return request(`/missions/${id}/dismiss`, { method: "POST", body: JSON.stringify(exclude ? { exclude } : {}) });
}

export function cancelMission(id: string): Promise<Mission> {
  return request(`/missions/${id}/cancel`, { method: "POST" });
}

// .claude/plans/18-mock-provider-safety-and-prod-start.md P1 (rejection flow) —
// start an "adjustment" Execution on the same branch, applying a correction on
// top of the prior work instead of leaving a rejection as a dead end.
export function iterateMission(id: string, adjustment: string): Promise<Mission> {
  return request(`/missions/${id}/iterate`, { method: "POST", body: JSON.stringify({ adjustment }) });
}

// .claude/plans/18-mock-provider-safety-and-prod-start.md P1 item 11 — discard a
// rejected Mission's local branch so it doesn't linger as an orphan.
export function discardMissionBranch(id: string): Promise<{ deleted: boolean; branch_name?: string }> {
  return request(`/missions/${id}/discard-branch`, { method: "POST" });
}

export function missionTimeline(id: string): Promise<TimelineEntry[]> {
  return request(`/missions/${id}/timeline`);
}

export function listExecutions(missionId: string): Promise<Execution[]> {
  return request(`/missions/${missionId}/executions`);
}

export function listArtifactsForMission(missionId: string): Promise<Artifact[]> {
  return request(`/missions/${missionId}/artifacts`);
}

export function listReviews(missionId: string): Promise<Review[]> {
  return request(`/missions/${missionId}/reviews`);
}

export function getMissionChecks(missionId: string): Promise<MissionChecks> {
  return request(`/missions/${missionId}/checks`);
}

// Plan 24 item 5 — what the last adjustment changed (null: nothing to compare).
export interface AdjustmentChanges {
  from_sha: string;
  to_sha: string;
  files: { path: string; added: number | null; removed: number | null }[];
}

export function getAdjustmentChanges(missionId: string): Promise<AdjustmentChanges | null> {
  return request(`/missions/${missionId}/adjustment-changes`);
}

export function getAdjustmentFileDiff(missionId: string, path: string): Promise<{ diff: string }> {
  return request(`/missions/${missionId}/adjustment-changes/diff?path=${encodeURIComponent(path)}`);
}

// Plan 25 - "Run". Starting can answer "needs values for the .env first" instead of a preview.
export function getPreview(projectId: string): Promise<PreviewInfo | null> {
  return request(`/projects/${projectId}/preview`);
}

export async function startPreview(
  projectId: string,
  missionId?: string
): Promise<{ preview: PreviewInfo } | { needsEnv: NeedsEnvVar[] }> {
  const res = await fetch(`/api/projects/${projectId}/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(missionId ? { mission_id: missionId } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409 && Array.isArray(body.needs_env)) return { needsEnv: body.needs_env };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed: ${res.status}`);
  return { preview: body };
}

export function stopPreview(projectId: string): Promise<{ stopped: boolean }> {
  return request(`/projects/${projectId}/preview`, { method: "DELETE" });
}

export function getRunConfig(projectId: string): Promise<RunConfig> {
  return request(`/projects/${projectId}/run-config`);
}

// `null` keeps the stored value of a masked field the user left alone.
export function saveEnv(projectId: string, values: Record<string, string | null>): Promise<{ saved: boolean }> {
  return request(`/projects/${projectId}/env`, { method: "PUT", body: JSON.stringify({ values }) });
}

export function getProjectBudget(projectId: string): Promise<BudgetStatus> {
  return request(`/projects/${projectId}/budget`);
}

export function getPrDescription(missionId: string): Promise<{ title: string; body: string }> {
  return request(`/missions/${missionId}/pr-description`);
}

export function getGateFacts(missionId: string): Promise<GateFacts> {
  return request(`/missions/${missionId}/gate-facts`);
}

export function submitHumanReview(
  missionId: string,
  input: {
    artifact_ids: string[];
    recommendation_outcome: RecommendationOutcome;
    recommendation_rationale: string;
    findings?: Pick<Finding, "artifact_id" | "evidence_id" | "text" | "severity">[];
  },
): Promise<Review> {
  return request(`/missions/${missionId}/reviews`, { method: "POST", body: JSON.stringify(input) });
}

export function listDecisions(missionId: string): Promise<Decision[]> {
  return request(`/missions/${missionId}/decisions`);
}

// .claude/plans/completed/13-real-merge-on-approval.md — `push` is only
// present when this Decision was tier 'binding' + outcome 'approved'; it
// reports whether the rebase+push actually happened, not just that the
// Decision was recorded.
export function recordDecision(
  missionId: string,
  input: { tier: DecisionTier; outcome: DecisionOutcome; rationale?: string; informed_by?: string[] },
): Promise<Decision & { push?: PushResult }> {
  return request(`/missions/${missionId}/decisions`, { method: "POST", body: JSON.stringify(input) });
}

export function getArtifact(id: string): Promise<Artifact> {
  return request(`/artifacts/${id}`);
}

export function getArtifactDiff(id: string): Promise<{ diff: string }> {
  return request(`/artifacts/${id}/diff`);
}

export function getReview(id: string): Promise<Review> {
  return request(`/reviews/${id}`);
}

// -- Executions ----------------------------------------------------------------

export function getExecution(id: string): Promise<Execution> {
  return request(`/executions/${id}`);
}

export function listEvidence(executionId: string): Promise<Evidence[]> {
  return request(`/executions/${executionId}/evidence`);
}

export function getEvidenceSummary(executionId: string): Promise<{ summary: string }> {
  return request(`/executions/${executionId}/evidence/summary`);
}

// -- Workspace ----------------------------------------------------------------

export function workspaceTrustLedger(opts: { window?: string } = {}): Promise<TrustLedgerAggregate[]> {
  const qs = opts.window ? `?window=${encodeURIComponent(opts.window)}` : "";
  return request(`/workspace/trust-ledger${qs}`);
}

export function getUsageStatus(): Promise<RateLimitState | null> {
  return request("/workspace/usage");
}

// .claude/plans/18-mock-provider-safety-and-prod-start.md P0 item 3 — the active
// provider, so the UI can persistently flag simulation mode.
export function getActiveProvider(): Promise<{ provider: ProviderName }> {
  return request("/workspace/provider");
}

// -- Notifications (SSE) --------------------------------------------------------

export type NotificationSignal = { type: string; id: string };

/** docs/03-ARCHITECTURE.md §7 — signals carry only id+type; callers re-fetch. */
export function subscribeToNotifications(onSignal: (signal: NotificationSignal) => void): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (event) => {
    try {
      onSignal(JSON.parse(event.data));
    } catch {
      // malformed event — ignore rather than crash the subscription
    }
  };
  return () => source.close();
}

export { ApiError };

// .claude/plans/20-plano-consolidado.md Phase 7.7 (21-N): routines only ever propose Missions.
export function listRoutines(projectId: string): Promise<Routine[]> {
  return request(`/projects/${projectId}/routines`);
}
export function createRoutine(projectId: string, input: { name: string; prompt: string; cadence: RoutineCadence }): Promise<Routine> {
  return request(`/projects/${projectId}/routines`, { method: "POST", body: JSON.stringify(input) });
}
export function updateRoutine(id: string, patch: { name?: string; prompt?: string; cadence?: RoutineCadence; enabled?: boolean }): Promise<Routine> {
  return request(`/routines/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}
export function deleteRoutine(id: string): Promise<{ deleted: boolean }> {
  return request(`/routines/${id}`, { method: "DELETE" });
}
export function runRoutineNow(id: string): Promise<{ proposed: number; skipped_duplicates: number; summary: string; ran: boolean }> {
  return request(`/routines/${id}/run`, { method: "POST" });
}
