import { getDb } from "../db/client.js";
import { newId } from "../util/id.js";
import { eventBus } from "../api/eventBus.js";
import type { AcceptanceCriterion, AssignedTeamEntry, Mission, MissionStatus, WaitingReason } from "../domain/types.js";
import { getProject } from "./projects.js";

interface MissionRow {
  id: string;
  project_id: string;
  brief: string;
  status: MissionStatus;
  assigned_team: string;
  reference_material: string | null;
  proposed_by_mission_id: string | null;
  iterate_count: number;
  created_at: string;
  updated_at: string;
  waiting_reason: WaitingReason | null;
  resume_at: string | null;
  plan_checkpoint: number;
  approved_plan: string | null;
  acceptance_criteria: string | null;
  base_mission_id: string | null;
  base_branch: string | null;
}

function rowToMission(row: MissionRow): Mission {
  return {
    ...row,
    assigned_team: JSON.parse(row.assigned_team),
    reference_material: row.reference_material ? JSON.parse(row.reference_material) : null,
    plan_checkpoint: row.plan_checkpoint === 1,
    acceptance_criteria: row.acceptance_criteria ? JSON.parse(row.acceptance_criteria) : [],
  };
}

/**
 * .claude/plans/20-plano-consolidado.md Phase 4 (D4) — criteria the user typed,
 * one per entry; blanks dropped, whitespace trimmed, capped so a pasted wall of
 * text can't become 200 "criteria".
 */
const MAX_CRITERIA = 12;
export function normalizeCriteria(input: unknown, source: AcceptanceCriterion["source"]): AcceptanceCriterion[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, MAX_CRITERIA)
    .map((text) => ({ text, source }));
}

export function listMissions(projectId: string, status?: MissionStatus): Mission[] {
  const db = getDb();
  const rows = status
    ? (db
        .prepare("SELECT * FROM missions WHERE project_id = ? AND status = ? ORDER BY created_at DESC")
        .all(projectId, status) as unknown as MissionRow[])
    : (db
        .prepare("SELECT * FROM missions WHERE project_id = ? AND status != 'cancelled' ORDER BY created_at DESC")
        .all(projectId) as unknown as MissionRow[]);
  return rows.map(rowToMission);
}

export function getMission(id: string): Mission | undefined {
  const row = getDb().prepare("SELECT * FROM missions WHERE id = ?").get(id) as unknown as MissionRow | undefined;
  return row ? rowToMission(row) : undefined;
}

// Any status other than 'waiting' clears the waiting fields (the table's CHECK
// requires waiting_reason IS NULL outside 'waiting'); setWaiting below is the
// only way into 'waiting'.
function setStatus(id: string, status: MissionStatus): void {
  if (status === "waiting") throw new Error("Use setWaiting to put a Mission in 'waiting' (it needs a reason).");
  getDb()
    .prepare(
      "UPDATE missions SET status = ?, waiting_reason = NULL, resume_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    )
    .run(status, id);
  eventBus.emitNotification({ type: "mission.status_changed", id });
}

/**
 * .claude/plans/20-plano-consolidado.md Phase 3 (D1) — the Mission stopped for
 * a reason that isn't failure: the usage limit (AgentSpace resumes it itself at
 * `resumeAt`), a question for the supervisor, or a plan to review.
 */
export function setWaiting(id: string, reason: WaitingReason, resumeAt?: string): void {
  getDb()
    .prepare(
      "UPDATE missions SET status = 'waiting', waiting_reason = ?, resume_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    )
    .run(reason, resumeAt ?? null, id);
  eventBus.emitNotification({ type: "mission.status_changed", id });
}

/**
 * .claude/plans/20-plano-consolidado.md Phase 6 (D3) — the ONE correction loop:
 * Mission Engine decides whether a finished Execution gets an automatic
 * correction round. Only when the Project opted in, the Mission is at the gate,
 * the iterate cap still has room (each round counts, so a stuck Mission can't
 * loop), and a reviewer reported something that must change (a blocking
 * finding or an unmet criterion). Returns the correction to send, or undefined.
 */
export function decideAutoFix(
  missionId: string,
  input: {
    autoFixEnabled: boolean;
    verdicts: {
      by: string;
      criteria: { n: number; verdict: string; note: string; text: string | null }[];
      findings: { severity: string; path: string | null; line: number | null; text: string }[];
    }[];
  }
): string | undefined {
  if (!input.autoFixEnabled) return undefined;
  const mission = getMission(missionId);
  if (!mission || mission.status !== "awaiting-approval" || !canIterate(missionId)) return undefined;

  const problems: string[] = [];
  for (const v of input.verdicts) {
    for (const f of v.findings.filter((x) => x.severity === "blocking")) {
      const where = f.path ? `${f.path}${f.line ? `:${f.line}` : ""}: ` : "";
      problems.push(`- ${where}${f.text} (${v.by})`);
    }
    for (const c of v.criteria.filter((x) => x.verdict === "not-met")) {
      problems.push(`- Criterion not met: ${c.text ?? `#${c.n}`}${c.note ? ` (${c.note})` : ""} (${v.by})`);
    }
  }
  if (problems.length === 0) return undefined;
  return ["The reviewers found problems that must be fixed before this ships. Fix exactly these, nothing else:", ...problems].join("\n");
}

/** Phase 3.3 — the plan the supervisor approved; later roles build from it. */
export function setApprovedPlan(id: string, plan: string | null): void {
  getDb()
    .prepare("UPDATE missions SET approved_plan = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(plan, id);
}

/**
 * Phase 4 (D4) — the Planner filled gaps: its criteria are appended after the
 * user's (never replacing them), marked as the Planner's, without duplicates.
 */
export function addPlannerCriteria(id: string, texts: string[]): void {
  const mission = getMission(id);
  if (!mission || texts.length === 0) return;
  const existing = new Set(mission.acceptance_criteria.map((c) => c.text.toLowerCase()));
  const added = normalizeCriteria(texts, "planner").filter((c) => !existing.has(c.text.toLowerCase()));
  if (added.length === 0) return;
  const merged = [...mission.acceptance_criteria, ...added].slice(0, MAX_CRITERIA);
  getDb()
    .prepare("UPDATE missions SET acceptance_criteria = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(JSON.stringify(merged), id);
}

/** usage-limit Missions whose resume time has come (the sweeper's work list). */
export function listUsageLimitResumesDue(nowIso: string): Mission[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM missions WHERE status = 'waiting' AND waiting_reason = 'usage-limit' AND (resume_at IS NULL OR resume_at <= ?) ORDER BY resume_at ASC"
    )
    .all(nowIso) as unknown as MissionRow[];
  return rows.map(rowToMission);
}

/**
 * Journey 1 / docs/07-SCHEMA_API_CONTRACT.md §7.2: developer-initiated only.
 * AI-proposed Missions never go through this function — see proposeMission below.
 */
export function createMission(
  projectId: string,
  input: {
    brief: string;
    reference_material?: unknown;
    assigned_team?: AssignedTeamEntry[];
    /** Phase 3.3 — only meaningful when the Team includes a Planner. */
    plan_checkpoint?: boolean;
    /** Phase 4 — the user's own criteria (strings). */
    acceptance_criteria?: unknown;
    /** Phase 7.7 — stack this Mission on another Mission's branch. */
    base_mission_id?: string;
    /** Resolved by the caller (Execution Engine owns branch names). */
    base_branch?: string;
  }
): Mission {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  if (input.base_mission_id) {
    const parent = getMission(input.base_mission_id);
    if (!parent || parent.project_id !== projectId) throw new Error("The Mission to stack on isn't in this Project.");
    if (!input.base_branch) throw new Error("That Mission has no branch to build on yet.");
  }

  const assignedTeam =
    input.assigned_team ?? project.team_roster.filter((r) => r.enabled).map((r) => ({ role: r.role }));

  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO missions (id, project_id, brief, status, assigned_team, reference_material, plan_checkpoint, acceptance_criteria, base_mission_id, base_branch)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      projectId,
      input.brief,
      JSON.stringify(assignedTeam),
      input.reference_material ? JSON.stringify(input.reference_material) : null,
      // A checkpoint needs someone to write the plan.
      input.plan_checkpoint && assignedTeam.some((t) => t.role === "Planner") ? 1 : 0,
      JSON.stringify(normalizeCriteria(input.acceptance_criteria, "user")),
      input.base_mission_id ?? null,
      input.base_mission_id ? input.base_branch! : null
    );

  eventBus.emitNotification({ type: "mission.status_changed", id });

  const mission = getMission(id);
  if (!mission) throw new Error("Failed to read back newly created mission");
  return mission;
}

/**
 * Journey 5 / docs/03-ARCHITECTURE.md §5.3: an AI Team Member's observation
 * produces a draft Mission Engine never auto-promotes. Called internally by
 * Execution Engine / Provider Adapter normalization, never by a public API
 * route — there is deliberately no client-facing way to fabricate a
 * proposal that looks AI-originated (docs/07-SCHEMA_API_CONTRACT.md §7.2).
 */
export function proposeMission(
  projectId: string,
  originatingMissionId: string,
  input: { brief: string; assigned_team: AssignedTeamEntry[] }
): Mission {
  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO missions (id, project_id, brief, status, assigned_team, proposed_by_mission_id)
       VALUES (?, ?, ?, 'proposed', ?, ?)`
    )
    .run(id, projectId, input.brief, JSON.stringify(input.assigned_team), originatingMissionId);

  getDb()
    .prepare(
      `INSERT INTO mission_graph_edges (id, edge_type, from_kind, from_id, to_kind, to_id)
       VALUES (?, 'triggered-by', 'mission', ?, 'mission', ?)`
    )
    .run(newId(), id, originatingMissionId);

  eventBus.emitNotification({ type: "mission.status_changed", id });

  const mission = getMission(id);
  if (!mission) throw new Error("Failed to read back newly proposed mission");
  return mission;
}

export function confirmMission(id: string): Mission {
  const mission = getMission(id);
  if (!mission) throw new Error(`Mission ${id} not found`);
  if (mission.status !== "proposed") {
    throw new Error(`Mission ${id} is not in 'proposed' status (currently '${mission.status}')`);
  }
  setStatus(id, "queued");
  const updated = getMission(id);
  if (!updated) throw new Error("Failed to read back confirmed mission");
  return updated;
}

export function dismissMission(id: string): Mission {
  const mission = getMission(id);
  if (!mission) throw new Error(`Mission ${id} not found`);
  if (mission.status !== "proposed") {
    throw new Error(`Mission ${id} is not in 'proposed' status (currently '${mission.status}')`);
  }
  setStatus(id, "cancelled");
  const updated = getMission(id);
  if (!updated) throw new Error("Failed to read back dismissed mission");
  return updated;
}

/**
 * .claude/plans/15-live-execution-feedback.md Part 3 — the real bug fix. The
 * old version read the status, then wrote 'cancelled' — and between the read
 * and the write, a running Execution could finish and move the Mission to
 * 'awaiting-approval'. A user's frustrated Cancel then clobbered a real,
 * successful result (reproduced live: branch
 * agentspace/change-the-app-color-from-red-to-blue-dyks4r). This is now a
 * single atomic conditional UPDATE: it only cancels a Mission still 'queued'
 * or 'running'. If 0 rows change, the Mission already left that state — we
 * return its honest current status instead of pretending to have cancelled it,
 * and never emit a status-change signal for a change that didn't happen.
 *
 * Killing the actual provider process is the API route's job (it calls
 * Execution Engine's killRunningExecution first) — Mission Engine still never
 * touches a process (AT #7).
 */
export function cancelMission(id: string): Mission {
  const result = getDb()
    .prepare(
      "UPDATE missions SET status = 'cancelled', waiting_reason = NULL, resume_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status IN ('queued', 'running', 'waiting')"
    )
    .run(id);

  const updated = getMission(id);
  if (!updated) throw new Error(`Mission ${id} not found`);
  if (result.changes > 0) eventBus.emitNotification({ type: "mission.status_changed", id });
  return updated;
}

/** Transition helper used by decisions.ts / execution-engine — kept here since Mission status is Mission Engine's alone to write. */
export function transitionMissionStatus(id: string, status: MissionStatus): void {
  setStatus(id, status);
}

/**
 * Approval-gate policy (docs/03-ARCHITECTURE.md §5.1) applied after an
 * Execution ends. Kept in Mission Engine, not Execution Engine, per AT #7
 * ("Mission Engine decides what is allowed; Execution Engine only reports
 * mechanics") — Execution Engine calls this with the raw facts (did it
 * succeed, did it produce changes) and never decides the Mission's next
 * status itself.
 *
 * v1 simplification, flagged rather than silently assumed complete: every
 * Project's default branch is protected (docs/07-SCHEMA_API_CONTRACT.md's
 * `branch_protection` is currently always `implicit-fallback` — see
 * mission-engine/projects.ts), so any Execution that produces changes is
 * treated as targeting a protected branch and always needs a Binding
 * Decision. A real merge-target concept (which branch this Execution's
 * changes are actually headed for) isn't in the v1 schema and is a
 * follow-up, not something this function pretends to already resolve.
 */
export function applyExecutionOutcome(
  missionId: string,
  input: {
    outcome: "success" | "failure" | "interrupted";
    changedFileCount: number;
    /**
     * .claude/plans/20-plano-consolidado.md Phase 3 — the run stopped without
     * failing: usage limit (resumeAt = when AgentSpace retries), a question for
     * the supervisor, or a plan to review.
     */
    paused?: { reason: WaitingReason; resumeAt?: string };
  }
): Mission {
  const mission = getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);

  // A Cancel that landed while the run was stopping wins over the pause.
  if (input.paused && mission.status === "running") {
    setWaiting(missionId, input.paused.reason, input.paused.resumeAt);
  } else if (input.outcome === "failure") {
    setStatus(missionId, "failed");
  } else if (input.outcome === "success") {
    setStatus(missionId, input.changedFileCount === 0 ? "completed" : "awaiting-approval");
  }
  // "interrupted": leave status as whatever the caller already set (e.g. the
  // iterate cap forcing awaiting-approval) — Execution Engine doesn't get to
  // silently resolve an interrupted run into a terminal state.

  const updated = getMission(missionId);
  if (!updated) throw new Error("Failed to read back mission after applying execution outcome");
  return updated;
}

/**
 * docs/03-ARCHITECTURE.md §5.2 — iteration bounding. Mission Engine, not the
 * Provider Adapter, decides whether an `iterate` Recommendation is allowed
 * to spin up another Execution. Returns whether iteration may proceed;
 * forces `awaiting-approval` when the cap is hit so a human breaks the loop.
 */
const ITERATE_CAP = Number(process.env.AGENTSPACE_ITERATE_CAP ?? 3); // tunable, not an architectural commitment — see docs/07-SCHEMA_API_CONTRACT.md §8

/**
 * .claude/plans/18-mock-provider-safety-and-prod-start.md P1 (rejection flow) —
 * a side-effect-free check of whether another iterate/adjustment Execution is
 * still within the cap, used by the API route to decide whether to offer/allow
 * an adjustment before it commits to starting one. registerIterateAttempt
 * below is the mutating counterpart that actually consumes an attempt.
 */
export function canIterate(missionId: string): boolean {
  const mission = getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);
  return mission.iterate_count + 1 <= ITERATE_CAP;
}

export function registerIterateAttempt(missionId: string): { allowed: boolean; count: number } {
  const mission = getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);

  const nextCount = mission.iterate_count + 1;

  if (nextCount > ITERATE_CAP) {
    setStatus(missionId, "awaiting-approval");
    return { allowed: false, count: mission.iterate_count };
  }

  getDb()
    .prepare("UPDATE missions SET iterate_count = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(nextCount, missionId);

  return { allowed: true, count: nextCount };
}
