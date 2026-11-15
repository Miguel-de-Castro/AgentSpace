import { getDb } from "../db/client.js";
import { newId } from "../util/id.js";
import { eventBus } from "../api/eventBus.js";
import type { Mission, Routine, RoutineCadence } from "../domain/types.js";
import { getMission } from "./missions.js";
import { getProject } from "./projects.js";

/**
 * .claude/plans/20-plano-consolidado.md Phase 7.7 (21-N) — Mission Engine's half
 * of routines: the records, and the ONE thing a routine may create, a
 * 'proposed' Mission. Nothing here can start work: a proposal waits for the
 * supervisor exactly like one an AI Team Member raised (Journey 5). Running a
 * routine (reading the repo, calling the provider) is Execution Engine's job.
 */

interface RoutineRow {
  id: string;
  project_id: string;
  name: string;
  prompt: string;
  cadence: RoutineCadence;
  enabled: number;
  last_run_at: string | null;
  last_summary: string | null;
  created_at: string;
}

const CADENCE_MS: Record<RoutineCadence, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** A routine that keeps finding things must not bury the supervisor. */
export const MAX_OPEN_PROPOSALS = 5;
export const MAX_PROPOSALS_PER_RUN = 3;

function rowToRoutine(row: RoutineRow): Routine {
  return { ...row, enabled: row.enabled === 1 };
}

export function listRoutines(projectId: string): Routine[] {
  const rows = getDb().prepare("SELECT * FROM routines WHERE project_id = ? ORDER BY created_at ASC").all(projectId) as unknown as RoutineRow[];
  return rows.map(rowToRoutine);
}

export function getRoutine(id: string): Routine | undefined {
  const row = getDb().prepare("SELECT * FROM routines WHERE id = ?").get(id) as unknown as RoutineRow | undefined;
  return row ? rowToRoutine(row) : undefined;
}

function validateCadence(cadence: unknown): RoutineCadence {
  if (cadence !== "daily" && cadence !== "weekly") throw new Error("cadence must be 'daily' or 'weekly'");
  return cadence;
}

/** New routines start disabled: turning one on is a deliberate act (it costs usage). */
export function createRoutine(projectId: string, input: { name: string; prompt: string; cadence: unknown }): Routine {
  if (!getProject(projectId)) throw new Error(`Project ${projectId} not found`);
  const name = input.name?.trim();
  const prompt = input.prompt?.trim();
  if (!name) throw new Error("name is required");
  if (!prompt) throw new Error("prompt is required");
  const id = newId();
  getDb()
    .prepare("INSERT INTO routines (id, project_id, name, prompt, cadence, enabled) VALUES (?, ?, ?, ?, ?, 0)")
    .run(id, projectId, name, prompt, validateCadence(input.cadence));
  return getRoutine(id)!;
}

export function updateRoutine(id: string, patch: { name?: string; prompt?: string; cadence?: unknown; enabled?: boolean }): Routine {
  const existing = getRoutine(id);
  if (!existing) throw new Error(`Routine ${id} not found`);
  const name = patch.name !== undefined ? patch.name.trim() : existing.name;
  const prompt = patch.prompt !== undefined ? patch.prompt.trim() : existing.prompt;
  if (!name || !prompt) throw new Error("name and prompt can't be empty");
  const cadence = patch.cadence !== undefined ? validateCadence(patch.cadence) : existing.cadence;
  const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
  getDb()
    .prepare("UPDATE routines SET name = ?, prompt = ?, cadence = ?, enabled = ? WHERE id = ?")
    .run(name, prompt, cadence, enabled ? 1 : 0, id);
  return getRoutine(id)!;
}

export function deleteRoutine(id: string): void {
  getDb().prepare("DELETE FROM routines WHERE id = ?").run(id);
}

/** Enabled routines whose cadence has elapsed since their last run (or that never ran). */
export function dueRoutines(now = Date.now()): Routine[] {
  const rows = getDb().prepare("SELECT * FROM routines WHERE enabled = 1 ORDER BY created_at ASC").all() as unknown as RoutineRow[];
  return rows
    .map(rowToRoutine)
    .filter((r) => !r.last_run_at || now - Date.parse(r.last_run_at) >= CADENCE_MS[r.cadence]);
}

export function markRoutineRan(id: string, summary: string): void {
  getDb()
    .prepare("UPDATE routines SET last_run_at = ?, last_summary = ? WHERE id = ?")
    .run(new Date().toISOString(), summary, id);
}

export function openProposalCount(projectId: string): number {
  const { n } = getDb()
    .prepare("SELECT COUNT(*) AS n FROM missions WHERE project_id = ? AND status = 'proposed'")
    .get(projectId) as unknown as { n: number };
  return n;
}

/**
 * Creates a 'proposed' Mission from a routine's finding. Skips a brief the
 * Project already has open (proposed or queued-but-unfinished copies of the
 * same ask), so a daily routine doesn't re-propose what it proposed yesterday.
 * Returns undefined when it was a duplicate.
 */
export function proposeMissionFromRoutine(projectId: string, brief: string): Mission | undefined {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  const text = brief.trim();
  if (!text) return undefined;
  // Item 2 — an idea the supervisor ruled out stays out, even reworded slightly
  // (the check is a case-insensitive containment either way, kept deliberately simple).
  const lower = text.toLowerCase();
  if (project.routine_exclusions.some((x) => lower.includes(x.toLowerCase()) || x.toLowerCase().includes(lower))) return undefined;
  const duplicate = getDb()
    .prepare("SELECT 1 FROM missions WHERE project_id = ? AND brief = ? AND status IN ('proposed', 'queued', 'running', 'waiting', 'awaiting-approval')")
    .get(projectId, text);
  if (duplicate) return undefined;
  const team = project.team_roster.filter((r) => r.enabled).map((r) => ({ role: r.role }));
  const id = newId();
  getDb()
    .prepare("INSERT INTO missions (id, project_id, brief, status, assigned_team) VALUES (?, ?, ?, 'proposed', ?)")
    .run(id, projectId, text, JSON.stringify(team));
  eventBus.emitNotification({ type: "mission.status_changed", id });
  return getMission(id);
}
