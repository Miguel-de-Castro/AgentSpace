import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getDb, getWorkspaceId, runInTransaction } from "../db/client.js";
import { newId } from "../util/id.js";
import type { BranchProtection, PermissionPolicy, Project, ProjectOriginKind, TeamRosterEntry } from "../domain/types.js";

// Default roster is deliberately lean: only Developer + Reviewer are enabled,
// so a Mission created without an explicit `assigned_team` runs 2 sequential
// `claude -p` invocations, not 4. Planner and QA stay in the roster (so the
// Team UI can offer them, plan 10) but start disabled — the supervisor opts
// into the heavier composition when a Mission actually warrants it. This
// replaces the earlier all-4-enabled default, whose real cost (up to 4x the
// invocations of the pre-multi-agent era, plan 14) was never surfaced.
const DEFAULT_ROSTER: TeamRosterEntry[] = [
  { role: "Planner", enabled: false },
  { role: "Developer", enabled: true },
  { role: "QA", enabled: false },
  { role: "Reviewer", enabled: true },
  // .claude/plans/20-cross-model-review-council.md Phase 1 — an independent
  // adversarial reviewer of the diff (recorded as an AI Review, shown as advice
  // in the Approval Gate). Disabled by default: it's one extra provider call, so
  // the supervisor opts in per Mission when they want a second opinion.
  { role: "Challenger", enabled: false },
];

interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  repo_path: string;
  default_branch: string;
  branch_protection: string;
  team_roster: string;
  permission_policy: string;
  origin_kind: ProjectOriginKind;
  clone_url: string | null;
  created_at: string;
  github_token: string | null;
  auto_fix_loop: number;
  instructions: string | null;
  role_instructions: string | null;
  weekly_budget_usd: number | null;
  routine_exclusions: string | null;
  run_command: string | null;
  install_command: string | null;
  preview_port: number | null;
}

const VALID_PERMISSION_MODES = new Set(["read-only", "can-edit", "can-edit-and-run", "custom"]);

// Explicitly excludes github_token (never spread) — a credential must never
// round-trip through a GET response just because it happens to share a row
// with public Project fields (.claude/plans/completed/05-checks-approval-gate.md).
// permission_policy, by contrast, is not a secret — it's a policy the
// developer set, meant to be visible (.claude/plans/project-permission-policy.md).
/**
 * A roster saved before a role existed (e.g. Challenger, added after most
 * Projects were connected) would otherwise never offer that role in Settings.
 * Missing default roles are appended, disabled — nothing changes behavior
 * until the supervisor opts in.
 */
function withAllDefaultRoles(roster: TeamRosterEntry[]): TeamRosterEntry[] {
  const present = new Set(roster.map((r) => r.role));
  return [...roster, ...DEFAULT_ROSTER.filter((r) => !present.has(r.role)).map((r) => ({ role: r.role, enabled: false }))];
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    repo_path: row.repo_path,
    default_branch: row.default_branch,
    branch_protection: JSON.parse(row.branch_protection),
    team_roster: withAllDefaultRoles(JSON.parse(row.team_roster)),
    permission_policy: JSON.parse(row.permission_policy),
    auto_fix_loop: row.auto_fix_loop === 1,
    instructions: row.instructions ?? null,
    role_instructions: row.role_instructions ? JSON.parse(row.role_instructions) : {},
    weekly_budget_usd: row.weekly_budget_usd ?? null,
    routine_exclusions: row.routine_exclusions ? JSON.parse(row.routine_exclusions) : [],
    run_command: row.run_command ?? null,
    install_command: row.install_command ?? null,
    preview_port: row.preview_port ?? null,
    origin_kind: row.origin_kind ?? "local",
    clone_url: row.clone_url ?? null,
    created_at: row.created_at,
    repo_available: existsSync(row.repo_path),
  };
}

// Phase 7.1 — Project instructions are prompt text, so they're bounded: a
// pasted novel would crowd out the brief in every role's prompt.
const MAX_INSTRUCTIONS_CHARS = 4000;
function cleanInstructions(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  return t ? t.slice(0, MAX_INSTRUCTIONS_CHARS) : null;
}
function cleanRoleInstructions(map: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, text] of Object.entries(map ?? {})) {
    const t = cleanInstructions(typeof text === "string" ? text : "");
    if (t) out[role] = t;
  }
  return out;
}

const MAX_EXCLUSIONS = 30;
const MAX_EXCLUSION_CHARS = 200;
export function cleanExclusions(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const text = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_EXCLUSION_CHARS);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.slice(-MAX_EXCLUSIONS);
}

/** Appends one "never propose this again" idea to the Project's list. */
export function addRoutineExclusion(projectId: string, text: string): Project {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  return updateProject(projectId, { routine_exclusions: [...project.routine_exclusions, text] });
}

const MAX_COMMAND_CHARS = 500;
function cleanCommand(value: string | null): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  if (/[\r\n]/.test(text)) throw new Error("A command must be a single line.");
  return text.slice(0, MAX_COMMAND_CHARS);
}

function cleanPort(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("The port must be a whole number between 1024 and 65535 (or empty to pick one automatically).");
  }
  return value;
}

function cleanBudget(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value <= 0) throw new Error("The weekly budget must be a positive number (or empty to turn it off).");
  return Math.round(value * 100) / 100;
}

/** Whether `path` exists and is inside a git work tree (read-only check). */
export function isGitRepoPath(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: path, encoding: "utf-8" }).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Journey 9 / docs/07-SCHEMA_API_CONTRACT.md §7.1: read the repo's own
 * branch protection rather than inventing a new risk model. A real
 * implementation would call the hosting provider's API (e.g. GitHub) for
 * actual branch-protection rules; that requires remote credentials this
 * scaffold doesn't have, so v1 here uses the "implicit-protection fallback"
 * docs/00-VISION.md already names for the no-remote-config case: the
 * repo's own default branch is treated as protected until real detection
 * is wired up.
 */
function detectBranchProtection(repoPath: string): { defaultBranch: string; protection: BranchProtection } {
  let defaultBranch = "main";
  try {
    const head = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
    // Strip only the remote prefix, so a default branch like "release/x" keeps its slash.
    defaultBranch = head.replace(/^refs\/remotes\/origin\//, "") || "main";
  } catch {
    try {
      defaultBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repoPath,
        encoding: "utf-8",
      }).trim();
    } catch {
      // Fresh/empty repo with no commits yet — fall back to the conventional default.
      defaultBranch = "main";
    }
  }

  return {
    defaultBranch,
    protection: {
      protected_branches: [defaultBranch],
      source: "implicit-fallback",
    },
  };
}

export function listProjects(): (Project & { needs_attention_count: number })[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as unknown as ProjectRow[];

  const countStmt = db.prepare(
    // Plan 20 Phase 3/7.3 — a question or a plan to review needs the
    // supervisor too; a usage-limit pause does not (it resumes on its own).
    `SELECT COUNT(*) AS n FROM missions WHERE project_id = ? AND (
       status IN ('awaiting-approval', 'proposed')
       OR (status = 'waiting' AND waiting_reason IN ('needs-input', 'plan-review'))
     )`
  );

  return rows.map((row) => {
    const { n } = countStmt.get(row.id) as unknown as { n: number };
    return { ...rowToProject(row), needs_attention_count: n };
  });
}

export function getProject(id: string): Project | undefined {
  const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as ProjectRow | undefined;
  return row ? rowToProject(row) : undefined;
}

export function onboardProject(input: {
  repo_path: string;
  name?: string;
  // .claude/plans/19-clone-git-repository.md — set by the onboarding route after
  // it clones a URL; a plain local connection leaves these at their defaults.
  origin_kind?: ProjectOriginKind;
  clone_url?: string;
}): Project {
  const { defaultBranch, protection } = detectBranchProtection(input.repo_path);
  const id = newId();
  const name = input.name ?? input.repo_path.split(/[\\/]/).filter(Boolean).pop() ?? input.repo_path;

  getDb()
    .prepare(
      `INSERT INTO projects (id, workspace_id, name, repo_path, default_branch, branch_protection, team_roster, origin_kind, clone_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      getWorkspaceId(),
      name,
      input.repo_path,
      defaultBranch,
      JSON.stringify(protection),
      JSON.stringify(DEFAULT_ROSTER),
      input.origin_kind ?? "local",
      input.clone_url ?? null
    );

  const project = getProject(id);
  if (!project) throw new Error("Failed to read back newly onboarded project");
  return project;
}

/**
 * .claude/plans/19-clone-git-repository.md P0 — is any Mission of this Project
 * still live? The delete route refuses while one is (killing/cleaning a running
 * Execution is a different flow); this keeps the DB-row cascade below from
 * yanking a Project out from under an in-flight Execution.
 */
export function projectHasLiveMissions(projectId: string): boolean {
  const { n } = getDb()
    .prepare("SELECT COUNT(*) AS n FROM missions WHERE project_id = ? AND status IN ('queued', 'running')")
    .get(projectId) as unknown as { n: number };
  return n > 0;
}

/**
 * .claude/plans/19-clone-git-repository.md P0 — remove a Project and everything
 * hanging off it (the first DELETE path in the product). foreign_keys=ON means
 * children must go before parents, so this deletes in dependency order inside
 * one transaction, using subqueries scoped to the Project so no id arrays need
 * materializing. Deleting the on-disk directory (for a cloned Project) is the
 * route's job afterward (Execution Engine owns the filesystem/git — AT #7); this
 * only touches DB rows. mission_graph_edges carries no FK, but its rows are
 * cleaned too so the graph doesn't keep dangling references to deleted nodes.
 */
export function deleteProject(projectId: string): void {
  const db = getDb();
  const missionSub = "SELECT id FROM missions WHERE project_id = ?";
  const reviewSub = `SELECT id FROM reviews WHERE mission_id IN (${missionSub})`;
  const execSub = `SELECT id FROM executions WHERE mission_id IN (${missionSub})`;
  const artifactSub = `SELECT id FROM artifacts WHERE execution_id IN (${execSub})`;

  runInTransaction(db, () => {
    db.prepare(`DELETE FROM findings WHERE review_id IN (${reviewSub})`).run(projectId);
    db.prepare(`DELETE FROM review_artifacts WHERE review_id IN (${reviewSub})`).run(projectId);
    // Graph edges reference missions / reviews / decisions / artifacts by id —
    // clear any edge that points at a node we're about to delete.
    db.prepare(
      `DELETE FROM mission_graph_edges
       WHERE from_id IN (${missionSub}) OR to_id IN (${missionSub})
          OR from_id IN (${reviewSub}) OR to_id IN (${reviewSub})
          OR to_id IN (${artifactSub})`
    ).run(projectId, projectId, projectId, projectId, projectId);
    db.prepare(`DELETE FROM decisions WHERE mission_id IN (${missionSub})`).run(projectId);
    db.prepare(`DELETE FROM artifacts WHERE execution_id IN (${execSub})`).run(projectId);
    db.prepare(`DELETE FROM evidence WHERE execution_id IN (${execSub})`).run(projectId);
    // Phase 3 added per-role sessions (for --resume); removing a Project missed them.
    db.prepare(`DELETE FROM execution_role_sessions WHERE execution_id IN (${execSub})`).run(projectId);
    db.prepare(`DELETE FROM reviews WHERE mission_id IN (${missionSub})`).run(projectId);
    db.prepare(`DELETE FROM executions WHERE mission_id IN (${missionSub})`).run(projectId);
    db.prepare("DELETE FROM routines WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_env WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM missions WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  });
}

// .claude/plans/completed/05-checks-approval-gate.md — server-side only, never exposed
// through rowToProject/the public Project shape. Read by
// integrations/github.ts when the Approval Gate needs to fetch Checks context.
export function getGithubToken(projectId: string): string | null {
  const row = getDb().prepare("SELECT github_token FROM projects WHERE id = ?").get(projectId) as
    | unknown as { github_token: string | null } | undefined;
  return row?.github_token ?? null;
}

export function setGithubToken(projectId: string, token: string | null): void {
  getDb().prepare("UPDATE projects SET github_token = ? WHERE id = ?").run(token, projectId);
}

export function updateProject(
  id: string,
  patch: {
    name?: string;
    team_roster?: TeamRosterEntry[];
    permission_policy?: PermissionPolicy;
    repo_path?: string;
    auto_fix_loop?: boolean;
    instructions?: string | null;
    role_instructions?: Record<string, string>;
    /** null clears the ceiling. */
    weekly_budget_usd?: number | null;
    routine_exclusions?: string[];
    /** Plan 25: empty string / null clears (back to auto-detect). */
    run_command?: string | null;
    install_command?: string | null;
    preview_port?: number | null;
  }
): Project {
  const existing = getProject(id);
  if (!existing) throw new Error(`Project ${id} not found`);

  // A local repo that was moved on disk: point the Project at its new folder
  // instead of reconnecting (which would lose the Mission history). Only for
  // 'local' Projects — a cloned one's folder is managed by AgentSpace — and
  // never while a Mission is live (its worktree hangs off the old path).
  let repoPath = existing.repo_path;
  // resolve() normalizes separators and trailing slashes, so the same folder
  // typed as C:/x or C:\x\ is stored (and uniqueness-checked) one way.
  if (patch.repo_path !== undefined && patch.repo_path.trim() && resolve(patch.repo_path.trim()) !== existing.repo_path) {
    const next = resolve(patch.repo_path.trim());
    if (existing.origin_kind !== "local") throw new Error("A cloned Project's folder is managed by AgentSpace and can't be changed.");
    if (projectHasLiveMissions(id)) throw new Error("A Mission is still running in this Project — wait for it or cancel it first.");
    if (!isGitRepoPath(next)) throw new Error(`'${next}' doesn't exist or isn't a git repository.`);
    const taken = getDb().prepare("SELECT id FROM projects WHERE repo_path = ? AND id != ?").get(next, id);
    if (taken) throw new Error("Another Project is already connected to that folder.");
    repoPath = next;
  }

  const name = patch.name ?? existing.name;
  // Note: branch_protection is intentionally not patchable here (§7.1) — it
  // always reflects what's actually detected in the repo, never a client override.
  const roster = patch.team_roster ?? existing.team_roster;

  const policy = patch.permission_policy ?? existing.permission_policy;
  if (patch.permission_policy) {
    if (!VALID_PERMISSION_MODES.has(policy.mode)) {
      throw new Error(`Invalid permission_policy.mode '${policy.mode}'`);
    }
    if (policy.mode !== "custom" && (policy.allowed_tools?.length || policy.disallowed_tools?.length)) {
      throw new Error("allowed_tools/disallowed_tools are only meaningful when mode is 'custom'");
    }
  }

  getDb()
    .prepare(
      "UPDATE projects SET name = ?, team_roster = ?, permission_policy = ?, repo_path = ?, auto_fix_loop = ?, instructions = ?, role_instructions = ?, weekly_budget_usd = ?, routine_exclusions = ?, run_command = ?, install_command = ?, preview_port = ? WHERE id = ?"
    )
    .run(
      name,
      JSON.stringify(roster),
      JSON.stringify(policy),
      repoPath,
      (patch.auto_fix_loop ?? existing.auto_fix_loop) ? 1 : 0,
      patch.instructions !== undefined ? cleanInstructions(patch.instructions) : existing.instructions,
      JSON.stringify(patch.role_instructions !== undefined ? cleanRoleInstructions(patch.role_instructions) : existing.role_instructions),
      patch.weekly_budget_usd !== undefined ? cleanBudget(patch.weekly_budget_usd) : existing.weekly_budget_usd,
      JSON.stringify(patch.routine_exclusions !== undefined ? cleanExclusions(patch.routine_exclusions) : existing.routine_exclusions),
      patch.run_command !== undefined ? cleanCommand(patch.run_command) : existing.run_command,
      patch.install_command !== undefined ? cleanCommand(patch.install_command) : existing.install_command,
      patch.preview_port !== undefined ? cleanPort(patch.preview_port) : existing.preview_port,
      id
    );

  const updated = getProject(id);
  if (!updated) throw new Error("Failed to read back updated project");
  return updated;
}
