import { getDb } from "../db/client.js";
import type { Project } from "../domain/types.js";

/**
 * .claude/plans/24-ideias-para-analisar.md item 7 — an optional weekly ceiling
 * per Project. The number is "API-equivalent" cost from each Execution's
 * recorded `cost_usd`, NOT what a subscription bills, and the UI says so. It is
 * a soft limit: routines and the automatic correction loop stop at it, a
 * Mission the supervisor starts by hand never does (they just see a notice).
 */

const WINDOW_DAYS = 7;

export interface BudgetStatus {
  /** The ceiling in USD, or null when none is set. */
  limit_usd: number | null;
  /** Sum of Execution costs in the last 7 days. */
  spent_usd: number;
  /** True only when a ceiling is set and has been reached. */
  reached: boolean;
  window_days: number;
}

export function spentInWindow(projectId: string, now = new Date()): number {
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(e.cost_usd), 0) AS spent
       FROM executions e JOIN missions m ON m.id = e.mission_id
       WHERE m.project_id = ? AND e.started_at >= ?`
    )
    .get(projectId, since) as unknown as { spent: number };
  return row.spent;
}

export function budgetStatus(project: Pick<Project, "id" | "weekly_budget_usd">, now = new Date()): BudgetStatus {
  const spent = spentInWindow(project.id, now);
  const limit = project.weekly_budget_usd;
  return { limit_usd: limit, spent_usd: spent, reached: limit !== null && spent >= limit, window_days: WINDOW_DAYS };
}
