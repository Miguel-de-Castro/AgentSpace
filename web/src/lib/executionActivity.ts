// .claude/plans/15-live-execution-feedback.md Part 2 — derive a discrete,
// per-role progress view (never a percentage — guardrail #2) plus a plain-text
// "what it's doing right now" line from an Execution's live Evidence stream.
//
// This mirrors, deliberately compactly, the extraction shape in
// src/execution-engine/reasoningSummary.ts (condenseEvidenceForSummary) — the
// two can't literally share code because web/ is a separate npm project that
// can't import from src/ (see lib/types.ts's header note). Kept intentionally
// minimal: just enough to answer "which role, doing what," not a full summary.
import type { AssignedTeamEntry, Evidence, Execution } from "./types";

// Same fixed v1 order as src/provider-adapter/claudeCodeAdapter.ts's
// CANONICAL_ROLE_ORDER — roles run sequentially in this order, extras last.
const CANONICAL_ROLE_ORDER = ["Planner", "Developer", "QA", "Reviewer"];

export function resolveRoleOrder(assignedTeam: AssignedTeamEntry[]): string[] {
  const assignedRoles = assignedTeam.map((t) => t.role);
  const assignedSet = new Set(assignedRoles);
  const ordered = CANONICAL_ROLE_ORDER.filter((r) => assignedSet.has(r));
  const extras = assignedRoles.filter((r) => !CANONICAL_ROLE_ORDER.includes(r));
  return [...ordered, ...extras];
}

export type RoleState = "done" | "running" | "queued";

export interface RoleProgress {
  role: string;
  state: RoleState;
  /** Plain-text last activity, only set for the currently-running role. */
  detail?: string;
}

function truncate(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * A short plain-language description of the single most recent meaningful
 * action in this slice of Evidence, or null if there's nothing to show yet.
 * Reads the same stream-json line shape the backend records verbatim.
 */
export function latestActivity(evidence: Evidence[]): string | null {
  for (let i = evidence.length - 1; i >= 0; i--) {
    const e = evidence[i];
    const payload = e.payload as Record<string, unknown> | undefined;
    if (!payload) continue;

    if (e.type === "execution_cancelled") return "cancelled";
    if (e.type === "provider_spawn_error") return "provider failed to start";
    if (e.type === "mock_run") return "ran against the mock provider";

    if (e.type !== "stream_json_line") continue;
    const message = payload.message as { content?: unknown[] } | undefined;
    const content = message?.content;
    if (payload.type === "assistant" && Array.isArray(content)) {
      // Prefer a concrete tool call over free text — it's the more useful
      // "doing X" signal. Scan this message's blocks last-first.
      for (let b = content.length - 1; b >= 0; b--) {
        const block = content[b] as Record<string, unknown>;
        if (block.type === "tool_use") return describeToolUse(block);
      }
      for (let b = content.length - 1; b >= 0; b--) {
        const block = content[b] as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          return truncate(block.text);
        }
      }
    }
  }
  return null;
}

function describeToolUse(block: Record<string, unknown>): string {
  const name = String(block.name ?? "tool");
  const input = (block.input ?? {}) as Record<string, unknown>;
  const file = typeof input.file_path === "string" ? input.file_path : undefined;
  switch (name) {
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return file ? `editing ${file}` : "editing a file";
    case "Read":
      return file ? `reading ${file}` : "reading a file";
    case "Bash":
      return typeof input.command === "string" ? `running: ${truncate(input.command, 60)}` : "running a command";
    case "Grep":
    case "Glob":
      return "searching the codebase";
    default:
      return name;
  }
}

/**
 * The at-a-glance state of each role in a running (or just-finished) Execution.
 * Roles run strictly in order, so: everything before the role owning the most
 * recent Evidence is done, that role is running, everything after is queued.
 * A finished Execution reports every role that produced Evidence as done.
 */
export function roleProgress(assignedTeam: AssignedTeamEntry[], execution: Execution, evidence: Evidence[]): RoleProgress[] {
  const roles = resolveRoleOrder(assignedTeam);
  if (roles.length === 0) return [];

  const finished = execution.ended_at !== null;
  const rolesWithEvidence = new Set(evidence.map((e) => e.team_member_role).filter((r): r is string => !!r));

  // The role owning the most recent role-attributed Evidence is the live one.
  let currentRole: string | undefined;
  for (let i = evidence.length - 1; i >= 0; i--) {
    if (evidence[i].team_member_role) {
      currentRole = evidence[i].team_member_role ?? undefined;
      break;
    }
  }
  const currentIndex = currentRole ? roles.indexOf(currentRole) : -1;

  return roles.map((role, index) => {
    if (finished) {
      return { role, state: rolesWithEvidence.has(role) ? "done" : "queued" };
    }
    if (currentIndex === -1) {
      // No role-attributed Evidence yet — the first role is spinning up.
      return { role, state: index === 0 ? "running" : "queued" };
    }
    if (index < currentIndex) return { role, state: "done" };
    if (index === currentIndex) {
      const roleEvidence = evidence.filter((e) => e.team_member_role === role);
      return { role, state: "running", detail: latestActivity(roleEvidence) ?? undefined };
    }
    return { role, state: "queued" };
  });
}
