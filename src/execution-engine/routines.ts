import { getProviderAdapter } from "../provider-adapter/index.js";
import * as missionEngine from "../mission-engine/index.js";
import { MAX_OPEN_PROPOSALS, MAX_PROPOSALS_PER_RUN } from "../mission-engine/routines.js";
import { budgetStatus } from "./budget.js";
import { createTempWorktreeAtSha, currentHeadSha, refreshBareCache, removeWorktree } from "./git.js";

/**
 * .claude/plans/20-plano-consolidado.md Phase 7.7 (21-N) — runs ONE routine:
 * looks at the Project with read-only tools and turns what it finds into
 * 'proposed' Missions. It cannot edit, run a command, branch or push (the
 * provider call gets Read/Grep/Glob only) and the only record it can create is
 * a proposal; starting one stays the supervisor's call, like any other.
 *
 * It reads a throwaway detached worktree at the base branch's tip, never the
 * user's own checkout, so a routine can't see half-finished local edits and
 * can't disturb them. For a bare-cache Project that worktree is also the only
 * place there are any files to read.
 */

export const ROUTINE_MARKER = "ROUTINE_PROPOSALS";

export interface RoutineRunResult {
  proposed: number;
  skipped_duplicates: number;
  summary: string;
  ran: boolean;
}

export function buildRoutinePrompt(name: string, instruction: string, limit: number, exclusions: string[] = []): string {
  return [
    `You are doing a recurring, read-only review of this repository (${ROUTINE_MARKER}).`,
    `Routine: ${name}`,
    `What to look for: ${instruction}`,
    "",
    "You may only read files (Read, Grep, Glob). You cannot change anything.",
    `Propose at most ${limit} concrete, self-contained pieces of work that a developer could hand to a teammate.`,
    "Only propose what you actually found evidence for in the code. If nothing is worth doing, propose nothing.",
    ...(exclusions.length > 0
      ? ["", "The supervisor already ruled these out. Do NOT propose them again, or anything close to them:", ...exclusions.map((x) => `- ${x}`)]
      : []),
    "",
    "Reply with ONLY a JSON array, no prose, no code fence. Each item: { \"brief\": \"<one or two sentences saying what to change and where>\" }.",
    "An empty array [] is a valid answer.",
  ].join("\n");
}

/** Pulls the JSON array out of the reply, tolerating a code fence or a stray sentence around it. */
export function parseRoutineReply(reply: string, limit: number): string[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === "string" ? item : typeof (item as { brief?: unknown })?.brief === "string" ? (item as { brief: string }).brief : ""))
      .map((b) => b.trim())
      .filter((b) => b.length >= 10)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function runRoutine(routineId: string): Promise<RoutineRunResult> {
  const routine = missionEngine.getRoutine(routineId);
  if (!routine) throw new Error(`Routine ${routineId} not found`);
  const project = missionEngine.getProject(routine.project_id);
  if (!project) throw new Error(`Project ${routine.project_id} not found`);
  if (!project.repo_available) {
    const summary = "Skipped: the repository folder wasn't found.";
    missionEngine.markRoutineRan(routine.id, summary);
    return { proposed: 0, skipped_duplicates: 0, summary, ran: false };
  }

  // Plan 24 item 7 — a routine is automatic spending, so it stops at the budget.
  if (budgetStatus(project).reached) {
    const summary = "Skipped: this Project reached its weekly budget.";
    missionEngine.markRoutineRan(routine.id, summary);
    return { proposed: 0, skipped_duplicates: 0, summary, ran: false };
  }

  const room = MAX_OPEN_PROPOSALS - missionEngine.openProposalCount(project.id);
  if (room <= 0) {
    const summary = `Skipped: ${MAX_OPEN_PROPOSALS} proposals are already waiting for you.`;
    missionEngine.markRoutineRan(routine.id, summary);
    return { proposed: 0, skipped_duplicates: 0, summary, ran: false };
  }
  const limit = Math.min(MAX_PROPOSALS_PER_RUN, room);

  if (project.origin_kind === "cached") refreshBareCache(project.repo_path, project.default_branch);
  const base = currentHeadSha(project.repo_path, project.origin_kind === "cached" ? project.default_branch : "HEAD");
  const worktree = createTempWorktreeAtSha(project.repo_path, base);
  let reply: string;
  try {
    reply = await getProviderAdapter().synthesize(buildRoutinePrompt(routine.name, routine.prompt, limit, project.routine_exclusions), {
      cwd: worktree,
      tools: "Read,Grep,Glob",
    });
  } catch (err) {
    const summary = `Failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    missionEngine.markRoutineRan(routine.id, summary);
    return { proposed: 0, skipped_duplicates: 0, summary, ran: false };
  } finally {
    removeWorktree(project.repo_path, worktree);
  }

  let proposed = 0;
  let skipped = 0;
  for (const brief of parseRoutineReply(reply, limit)) {
    if (missionEngine.proposeMissionFromRoutine(project.id, brief)) proposed++;
    else skipped++;
  }
  const summary =
    proposed > 0
      ? `Proposed ${proposed} ${proposed === 1 ? "Mission" : "Missions"}${skipped ? ` (${skipped} already open)` : ""}.`
      : skipped > 0
        ? `Nothing new: ${skipped} ${skipped === 1 ? "idea is" : "ideas are"} already open.`
        : "Nothing worth proposing this time.";
  missionEngine.markRoutineRan(routine.id, summary);
  return { proposed, skipped_duplicates: skipped, summary, ran: true };
}

const SCHEDULER_INTERVAL_MS = Number(process.env.AGENTSPACE_ROUTINE_TICK_MS ?? 10 * 60 * 1000);
let ticking = false;

/** One pass: run every due routine, one at a time (they share the provider's usage). */
export async function runDueRoutines(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const routine of missionEngine.dueRoutines()) {
      try {
        await runRoutine(routine.id);
      } catch (err) {
        console.error(`Routine ${routine.id} failed:`, err);
      }
    }
  } finally {
    ticking = false;
  }
}

export function startRoutineScheduler(): void {
  setInterval(() => void runDueRoutines(), SCHEDULER_INTERVAL_MS).unref();
}
