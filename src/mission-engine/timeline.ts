import { getDb } from "../db/client.js";

export interface TimelineEntry {
  kind: "mission_created" | "execution_started" | "review_submitted" | "decision_recorded";
  id: string;
  at: string;
}

/** docs/07-SCHEMA_API_CONTRACT.md §5 — Project Timeline: "what happened while I was away." Always a query, never a stored projection. */
export function projectTimeline(projectId: string): TimelineEntry[] {
  return getDb()
    .prepare(
      `SELECT 'mission_created' AS kind, id, created_at AS at FROM missions WHERE project_id = ?
       UNION ALL
       SELECT 'execution_started', e.id, e.started_at FROM executions e
         JOIN missions m ON m.id = e.mission_id WHERE m.project_id = ?
       UNION ALL
       SELECT 'review_submitted', r.id, r.created_at FROM reviews r
         JOIN missions m ON m.id = r.mission_id WHERE m.project_id = ?
       UNION ALL
       SELECT 'decision_recorded', d.id, d.created_at FROM decisions d
         JOIN missions m ON m.id = d.mission_id WHERE m.project_id = ?
       ORDER BY at DESC`
    )
    .all(projectId, projectId, projectId, projectId) as unknown as TimelineEntry[];
}

/** Mission Timeline — same projection, filtered to one Mission (the drill-in zoom level). */
export function missionTimeline(missionId: string): TimelineEntry[] {
  return getDb()
    .prepare(
      `SELECT 'mission_created' AS kind, id, created_at AS at FROM missions WHERE id = ?
       UNION ALL
       SELECT 'execution_started', id, started_at FROM executions WHERE mission_id = ?
       UNION ALL
       SELECT 'review_submitted', id, created_at FROM reviews WHERE mission_id = ?
       UNION ALL
       SELECT 'decision_recorded', id, created_at FROM decisions WHERE mission_id = ?
       ORDER BY at DESC`
    )
    .all(missionId, missionId, missionId, missionId) as unknown as TimelineEntry[];
}
