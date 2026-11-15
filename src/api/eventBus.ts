import { EventEmitter } from "node:events";

/**
 * The notification signal types from docs/03-ARCHITECTURE.md §7 /
 * docs/07-SCHEMA_API_CONTRACT.md §4 & §7.7. These are transient — never
 * persisted, never trusted as a cache. A payload is only ever { type, id };
 * the UI is required to re-fetch the actual resource from the API.
 *
 * .claude/plans/15-live-execution-feedback.md Part 1 adds `evidence.recorded`
 * (id = the Execution's id): fired — throttled — as Evidence lands live, so a
 * running Mission's detail view can update without polling. Still just
 * { type, id }; the UI re-reads the Evidence, never renders from the signal.
 */
export type NotificationType =
  | "mission.status_changed"
  | "execution.started"
  | "execution.ended"
  | "evidence.recorded"
  | "review.submitted"
  | "decision.recorded"
  // Plan 25: a Project's "Run" changed state (id = the Project's id); re-read GET /projects/:id/preview.
  | "preview.changed";

export interface Notification {
  type: NotificationType;
  id: string;
}

class MissionEventBus extends EventEmitter {
  emitNotification(notification: Notification): void {
    this.emit("notification", notification);
  }
}

/** One process-wide bus. Mission Engine/Execution Engine publish; the SSE route (api/routes/events.ts) subscribes. */
export const eventBus = new MissionEventBus();
eventBus.setMaxListeners(50);
