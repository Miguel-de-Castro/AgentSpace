import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../db/client.js";

/**
 * .claude/plans/20-plano-consolidado.md item 1.8 (decision D7) — the usage
 * limit is never forced just to test it, so we don't yet know exactly what
 * `claude -p` emits when it hits one. This "capture trap" records the raw
 * evidence the first time it happens naturally: any rate_limit_event whose
 * status isn't "allowed", or a `result` line flagged as an error. The ADR for
 * the Phase 3 pause-and-resume work gets written from these files, not from
 * guesses.
 */
export interface UsageCaptureTrigger {
  kind: "rate_limit_status" | "result_error";
  role: string | null;
  occurred_at: string;
  raw: unknown;
}

export function usageCaptureTrigger(
  eventType: string,
  raw: unknown,
  role: string | undefined,
  occurredAt: string
): UsageCaptureTrigger | undefined {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return undefined;
  if (eventType === "rate_limit_event" && typeof r.status === "string" && r.status !== "allowed") {
    return { kind: "rate_limit_status", role: role ?? null, occurred_at: occurredAt, raw };
  }
  if (eventType === "stream_json_line" && r.type === "result" && r.is_error === true) {
    return { kind: "result_error", role: role ?? null, occurred_at: occurredAt, raw };
  }
  return undefined;
}

/**
 * Writes one diagnostic file per Execution that tripped the trap, next to the
 * DB (`<dataDir>/diagnostics/`), and returns its path. `context` carries the
 * exit codes and stderr of the same Execution, which only exist once the
 * provider process has closed.
 */
export function writeUsageCapture(
  executionId: string,
  triggers: UsageCaptureTrigger[],
  context: { exits: unknown[]; stderr: unknown[] }
): string {
  const dir = join(getDataDir(), "diagnostics");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `usage-capture-${executionId}.json`);
  writeFileSync(
    file,
    JSON.stringify({ execution_id: executionId, captured_at: new Date().toISOString(), triggers, ...context }, null, 2) + "\n"
  );
  return file;
}
