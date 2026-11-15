import type { ProviderRunInput } from "./types.js";

/**
 * .claude/plans/20-plano-consolidado.md Phase 4 (D4) — the Planner adds missing
 * acceptance criteria as `CRITERION+: <text>` lines. Every adapter applies them
 * to the roles that run after the Planner in the same run, so the Reviewer
 * judges the full list (Execution Engine separately persists them on the
 * Mission for later runs). Duplicates of existing criteria are ignored.
 */
export function withPlannerCriteria(input: ProviderRunInput, plannerText: string | undefined): ProviderRunInput {
  if (!plannerText) return input;
  const existing = input.acceptanceCriteria ?? [];
  const seen = new Set(existing.map((c) => c.text.toLowerCase()));
  const added = plannerText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("CRITERION+:"))
    .map((l) => unwrapBackticks(l.slice("CRITERION+:".length)))
    .filter((t) => t && !seen.has(t.toLowerCase()))
    .map((text) => ({ text, source: "planner" as const }));
  return added.length > 0 ? { ...input, acceptanceCriteria: [...existing, ...added] } : input;
}

/**
 * Models often wrap a whole marker value in backticks (`` `math.js` ``). Strip
 * them only when they wrap the ENTIRE value: a value that merely starts with
 * code (`` `clamp` is exported… ``) must keep its backticks (found in a real
 * run, where stripping just the first one produced "clamp` is exported").
 */
export function unwrapBackticks(value: string): string {
  const v = value.trim();
  return v.length > 1 && v.startsWith("`") && v.endsWith("`") && !v.slice(1, -1).includes("`") ? v.slice(1, -1).trim() : v;
}
