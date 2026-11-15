import { getDb } from "../db/client.js";

export interface TrustLedgerAggregate {
  outcome: string;
  count: number;
}

/** docs/07-SCHEMA_API_CONTRACT.md §5 — Trust Ledger: aggregate over Decisions, always a query. Binding tier only (Journey 8's "approved/rejected/needed changes" framing). */
export function projectTrustLedger(projectId: string, opts: { since?: string; pathPrefix?: string } = {}): TrustLedgerAggregate[] {
  const db = getDb();

  if (opts.pathPrefix) {
    return db
      .prepare(
        `SELECT d.outcome AS outcome, COUNT(DISTINCT d.id) AS count
         FROM decisions d
         JOIN missions m ON m.id = d.mission_id
         JOIN mission_graph_edges e ON e.from_id = d.id AND e.from_kind = 'decision' AND e.edge_type = 'informed-by'
         JOIN artifacts a ON (e.to_kind = 'artifact' AND e.to_id = a.id)
         WHERE d.tier = 'binding' AND m.project_id = ? AND a.title LIKE ?
           AND (? IS NULL OR d.created_at >= ?)
         GROUP BY d.outcome`
      )
      .all(projectId, `${opts.pathPrefix}%`, opts.since ?? null, opts.since ?? null) as unknown as TrustLedgerAggregate[];
  }

  return db
    .prepare(
      `SELECT outcome, COUNT(*) AS count
       FROM decisions d
       JOIN missions m ON m.id = d.mission_id
       WHERE d.tier = 'binding' AND m.project_id = ?
         AND (? IS NULL OR d.created_at >= ?)
       GROUP BY outcome`
    )
    .all(projectId, opts.since ?? null, opts.since ?? null) as unknown as TrustLedgerAggregate[];
}

/** docs/02-DOMAIN.md — "aggregated across every Mission, every Project, over time." */
export function workspaceTrustLedger(opts: { since?: string } = {}): TrustLedgerAggregate[] {
  return getDb()
    .prepare(
      `SELECT outcome, COUNT(*) AS count
       FROM decisions
       WHERE tier = 'binding'
         AND (? IS NULL OR created_at >= ?)
       GROUP BY outcome`
    )
    .all(opts.since ?? null, opts.since ?? null) as unknown as TrustLedgerAggregate[];
}
