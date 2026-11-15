import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withPlannerCriteria } from "./roleConventions.js";
import type { ProviderAdapter, ProviderEvent, ProviderRoleSession, ProviderRunInput, ProviderRunResult } from "./types.js";

/**
 * Deterministic stand-in for local development and scaffolding verification
 * without requiring a real, authenticated `claude` CLI install. Selected by
 * default outside production — see provider-adapter/index.ts. Emits one
 * synthetic Evidence event per role and succeeds immediately; it makes no
 * actual code changes in the worktree, so an Execution run against it
 * produces zero Artifacts, which is a legitimate and expected outcome, not
 * an error.
 *
 * .claude/plans/20-plano-consolidado.md Phase 3 — it follows the same role
 * contract as the real adapter (skipRoles, resume.fromRole, stopAfterRole) and
 * returns a final text per role, so the waiting flows are testable without a
 * real provider. `AGENTSPACE_MOCK_SCENARIO` injects the situations we must
 * never force for real (decision D7):
 *   - `usage-limit`: a Mission's first run hits a synthetic 'rejected'
 *     rate_limit_event on its first role (reset after
 *     AGENTSPACE_MOCK_LIMIT_RESET_S, default 60s); the resumed run succeeds.
 *   - `needs-input`: the first role of a first run ends with a question.
 * `AGENTSPACE_MOCK_WRITES=1` makes the Developer write one file, so a mock run
 * produces a real diff and reaches the Approval Gate (UI testing only; the
 * gate still refuses to Allow a mock run).
 */
const MOCK_ROLE_ORDER = ["Planner", "Developer", "QA", "Reviewer"];

function mockFinalText(role: string | undefined, input: ProviderRunInput): string {
  if (role === "Planner") {
    return [
      "Plan (mock): change the smallest set of files that satisfies the brief.",
      "1. Update the module the brief names.",
      "2. Cover it with a test.",
      "FILES: src/example.ts, test/example.test.ts",
      "CRITERION+: The existing tests still pass",
    ].join("\n");
  }
  // AGENTSPACE_MOCK_BLOCKING=1 — the first review finds a blocking problem and
  // the review after a correction round finds none (tests the Phase 6 loop).
  // AGENTSPACE_MOCK_BLOCKING=always never clears (tests the iterate cap).
  const blocking = process.env.AGENTSPACE_MOCK_BLOCKING;
  if (role === "Reviewer" && (blocking === "1" || blocking === "always")) {
    return input.adjustment && blocking !== "always"
      ? "Review (mock): the correction addressed the problem.\nVERDICT: approve"
      : "Review (mock): one blocking problem.\nFINDING [blocking] mock-change.txt:1 - mock blocking problem\nVERDICT: iterate";
  }
  if (role === "Reviewer" && input.acceptanceCriteria?.length) {
    return [
      "Review (mock): no real changes were made, so nothing can be verified.",
      ...input.acceptanceCriteria.map((_, i) => `CRITERION ${i + 1}: unclear - the mock provider made no changes`),
      "FINDING [warning] mock-change.txt:1 - mock finding on the mock file",
      "FINDING [info] README.md:1 - mock review, nothing to report",
      "VERDICT: iterate",
    ].join("\n");
  }
  return `Mock ${role ?? "team"} finished — no real code changes were made.`;
}

export class MockProviderAdapter implements ProviderAdapter {
  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    const assigned = input.assignedTeam.map((t) => t.role).filter((r) => r !== "Challenger");
    let roles: (string | undefined)[] =
      assigned.length > 0
        ? [...MOCK_ROLE_ORDER.filter((r) => assigned.includes(r)), ...assigned.filter((r) => !MOCK_ROLE_ORDER.includes(r))]
        : [undefined];
    if (input.skipRoles?.length) roles = roles.filter((r) => !r || !input.skipRoles!.includes(r));
    if (input.resume?.fromRole && roles.includes(input.resume.fromRole)) roles = roles.slice(roles.indexOf(input.resume.fromRole));
    if (input.stopAfterRole && roles.includes(input.stopAfterRole)) roles = roles.slice(0, roles.indexOf(input.stopAfterRole) + 1);

    const scenario = process.env.AGENTSPACE_MOCK_SCENARIO;
    const events: ProviderEvent[] = [];
    const sessions: ProviderRoleSession[] = [];
    const emit = (event: ProviderEvent) => {
      events.push(event);
      input.onEvent?.(event);
    };

    for (const [i, role] of roles.entries()) {
      emit({
        type: "mock_run",
        raw: {
          message: "MockProviderAdapter ran instead of a real provider — no code changes were made.",
          brief: input.brief,
          // .claude/plans/18-mock-provider-safety-and-prod-start.md — echo the
          // adjustment so an iterate run is exercisable in mock mode too.
          ...(input.adjustment ? { adjustment: input.adjustment } : {}),
          ...(input.resume && i === 0 ? { resumed_with: input.resume.note } : {}),
          ...(input.approvedPlan ? { approved_plan: true } : {}),
          role,
        },
        occurredAt: new Date().toISOString(),
        role,
      });
      const sessionId = `mock-session-${role ?? "team"}-${Date.now()}`;

      // Written before the scenarios below, so a usage-limit pause has partial
      // work to commit (as a real mid-run limit would).
      if (role === "Developer" && process.env.AGENTSPACE_MOCK_WRITES === "1") {
        writeFileSync(join(input.worktreePath, "mock-change.txt"), `mock change for: ${input.brief}\n${input.adjustment ?? ""}\n`);
      }
      if (scenario === "usage-limit" && !input.resume && i === 0) {
        const resetsAt = Math.floor(Date.now() / 1000) + Number(process.env.AGENTSPACE_MOCK_LIMIT_RESET_S ?? 60);
        emit({
          type: "rate_limit_event",
          raw: { status: "rejected", resetsAt, rateLimitType: "five_hour", injected: true },
          occurredAt: new Date().toISOString(),
        });
        sessions.push({ role: role ?? "", sessionId, completed: false });
        return { outcome: "interrupted", events, sessions, paused: { reason: "usage-limit", resetsAt } };
      }

      if (scenario === "needs-input" && !input.resume && i === 0 && input.allowQuestions) {
        const question = "Which database should the new endpoint read from: Postgres or the SQLite cache?";
        sessions.push({ role: role ?? "", sessionId, completed: false, finalText: `I need one detail first.\nNEEDS_INPUT: ${question}` });
        return { outcome: "interrupted", events, sessions, paused: { reason: "needs-input", question, role: role ?? "" } };
      }

      const finalText = mockFinalText(role, input);
      sessions.push({ role: role ?? "", sessionId, completed: true, finalText });
      if (role === "Planner") input = withPlannerCriteria(input, finalText);
    }

    return { outcome: "success", events, sessions };
  }

  async synthesize(prompt: string, _opts?: { signal?: AbortSignal; cwd?: string; tools?: string }): Promise<string> {
    // Phase 7.7: a routine's prompt carries ROUTINE_PROPOSALS; answer it with a fixed finding.
    if (prompt.includes("ROUTINE_PROPOSALS")) {
      return process.env.AGENTSPACE_MOCK_ROUTINE_REPLY ?? '[{"brief":"Mock finding: add a README section describing how to run the tests."}]';
    }
    return `Mock summary — no real provider was called. Prompt was ${prompt.length} characters long.`;
  }
}
