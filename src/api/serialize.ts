import { MISSION_STATUS_DISPLAY_LABEL, type Mission, type WaitingReason } from "../domain/types.js";

// .claude/plans/20-plano-consolidado.md Phase 3 — a 'waiting' Mission says why,
// in the same calm register: the usage limit is informational (AgentSpace
// resumes it on its own), the other two need the supervisor.
const WAITING_DISPLAY_LABEL: Record<WaitingReason, string> = {
  "usage-limit": "Paused: usage limit",
  "needs-input": "Needs your answer",
  "plan-review": "Plan ready for review",
};

/**
 * docs/07-SCHEMA_API_CONTRACT.md §6 — `missions.status` stores the strict
 * domain enum; the calmer display label ("Running Unattended," "Waiting on
 * you") is presentation-layer text attached here, in the API layer, never
 * in the schema. Keeping copy changes out of a migration.
 */
export function serializeMission(mission: Mission): Mission & { display_status: string } {
  const display_status =
    mission.status === "waiting" && mission.waiting_reason
      ? WAITING_DISPLAY_LABEL[mission.waiting_reason]
      : MISSION_STATUS_DISPLAY_LABEL[mission.status];
  return { ...mission, display_status };
}
