import { getDb, runInTransaction } from "../db/client.js";
import { getProject } from "./projects.js";

/**
 * .claude/plans/25-run-do-project.md - the values the supervisor typed for a
 * Project's `.env.example`, kept only so "Run" can write a `.env`. Same posture
 * as the GitHub token: local, never echoed in list responses, never part of a
 * prompt or Evidence. Mission Engine owns the record; writing the file is
 * Execution Engine's job.
 */

const MAX_NAME_CHARS = 120;
const MAX_VALUE_CHARS = 4000;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function getProjectEnv(projectId: string): Record<string, string> {
  const rows = getDb().prepare("SELECT name, value FROM project_env WHERE project_id = ?").all(projectId) as unknown as {
    name: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

/**
 * Saves the given variables. A `null` value keeps what is already stored for
 * that name (so a masked field left alone isn't wiped); a string, including an
 * empty one, replaces it. Names not mentioned are removed.
 */
export function setProjectEnv(projectId: string, values: Record<string, string | null>): void {
  if (!getProject(projectId)) throw new Error(`Project ${projectId} not found`);
  const existing = getProjectEnv(projectId);
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (!NAME_RE.test(name) || name.length > MAX_NAME_CHARS) throw new Error(`'${name}' isn't a valid variable name.`);
    const resolved = value === null ? existing[name] : value;
    if (resolved === undefined) continue;
    if (/[\r\n]/.test(resolved)) throw new Error(`The value of ${name} must be a single line.`);
    next[name] = resolved.slice(0, MAX_VALUE_CHARS);
  }
  const db = getDb();
  runInTransaction(db, () => {
    db.prepare("DELETE FROM project_env WHERE project_id = ?").run(projectId);
    const insert = db.prepare("INSERT INTO project_env (project_id, name, value) VALUES (?, ?, ?)");
    for (const [name, value] of Object.entries(next)) insert.run(projectId, name, value);
  });
}

export function hasProjectEnv(projectId: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 AS x FROM project_env WHERE project_id = ? LIMIT 1").get(projectId));
}
