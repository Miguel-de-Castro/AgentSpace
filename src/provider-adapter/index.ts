import { ClaudeCodeAdapter } from "./claudeCodeAdapter.js";
import { MockProviderAdapter } from "./mockAdapter.js";
import type { ProviderAdapter } from "./types.js";

export * from "./types.js";

/**
 * AGENTSPACE_PROVIDER=claude-code opts into spawning the real CLI;
 * anything else (including unset, the default for `npm run dev`) uses the
 * mock so the rest of the stack is exercisable without a Claude Code
 * install. Mission Engine and Execution Engine only ever import this
 * function's return type (ProviderAdapter) — never either concrete class.
 */
export type ProviderName = "claude-code" | "mock";

/**
 * .claude/plans/18-mock-provider-safety-and-prod-start.md P0 item 1 — the
 * single source of truth for "which provider will actually run," resolved the
 * exact same way getProviderAdapter() picks the class. Exported so
 * startExecution can persist it per-Execution (executions.provider) and the
 * workspace/provider endpoint can surface the live mode — the whole point of
 * that plan is that a mock run must never be silently indistinguishable from a
 * real one.
 */
export function getActiveProviderName(): ProviderName {
  return process.env.AGENTSPACE_PROVIDER === "claude-code" ? "claude-code" : "mock";
}

export function getProviderAdapter(): ProviderAdapter {
  return getActiveProviderName() === "claude-code" ? new ClaudeCodeAdapter() : new MockProviderAdapter();
}
