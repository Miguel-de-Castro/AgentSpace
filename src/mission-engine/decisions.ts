import { getDb, runInTransaction } from "../db/client.js";
import { newId } from "../util/id.js";
import { eventBus } from "../api/eventBus.js";
import type { Decision, DecisionOutcome, DecisionTier } from "../domain/types.js";
import { getMission, transitionMissionStatus } from "./missions.js";

export function listDecisions(missionId: string): Decision[] {
  return getDb()
    .prepare("SELECT * FROM decisions WHERE mission_id = ? ORDER BY created_at DESC")
    .all(missionId) as unknown as Decision[];
}

export interface RecordDecisionInput {
  tier: DecisionTier;
  outcome: DecisionOutcome;
  rationale?: string | null;
  informed_by?: { review_ids?: string[]; artifact_ids?: string[] };
}

const BINDING_OUTCOMES = new Set(["approved", "rejected"]);
const LIGHTWEIGHT_OUTCOMES = new Set(["acknowledged-good", "acknowledged-not-wanted", "flag-for-later"]);
const PLAN_OUTCOMES = new Set(["plan-approved", "plan-revised", "plan-discarded"]);

/**
 * docs/03-ARCHITECTURE.md §5.5 / docs/07-SCHEMA_API_CONTRACT.md §7.5: this
 * is the *only* write path capable of producing a Binding Decision — called
 * exclusively from the interactive approval route. There is deliberately no
 * separate "record a decision" surface for automation to call.
 */
export function recordDecision(missionId: string, input: RecordDecisionInput): Decision {
  const mission = getMission(missionId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);

  const validOutcomes =
    input.tier === "binding" ? BINDING_OUTCOMES : input.tier === "plan" ? PLAN_OUTCOMES : LIGHTWEIGHT_OUTCOMES;
  if (!validOutcomes.has(input.outcome)) {
    throw new Error(`Outcome '${input.outcome}' is not valid for tier '${input.tier}'`);
  }

  const db = getDb();
  const id = newId();

  const insert = () => runInTransaction(db, () => {
    db.prepare(`INSERT INTO decisions (id, mission_id, tier, outcome, rationale) VALUES (?, ?, ?, ?, ?)`).run(
      id,
      missionId,
      input.tier,
      input.outcome,
      input.rationale ?? null
    );

    const insertEdge = db.prepare(
      `INSERT INTO mission_graph_edges (id, edge_type, from_kind, from_id, to_kind, to_id) VALUES (?, 'informed-by', 'decision', ?, ?, ?)`
    );
    for (const reviewId of input.informed_by?.review_ids ?? []) insertEdge.run(newId(), id, "review", reviewId);
    for (const artifactId of input.informed_by?.artifact_ids ?? []) insertEdge.run(newId(), id, "artifact", artifactId);

    // docs/07-SCHEMA_API_CONTRACT.md §3.10 — this mapping (which Decision
    // outcomes flip which Mission statuses) is Mission Engine policy, kept
    // here rather than inferred implicitly by the schema.
    //
    // .claude/plans/completed/13-real-merge-on-approval.md — 'approved' is
    // deliberately NOT transitioned here anymore. It used to jump straight
    // to 'completed', but "Allow" now has a real mechanical consequence
    // (rebase + push, src/execution-engine/index.ts's approveAndPush) that
    // only the API route layer can trigger (AT #7 — Mission Engine never
    // touches git). The route decides 'completed' vs staying in
    // 'awaiting-approval' based on whether that push actually succeeded.
    if (input.tier === "binding" && input.outcome === "rejected") {
      transitionMissionStatus(missionId, "rejected");
    }
    // Lightweight Decisions never change Mission status (Journey 4 — non-blocking, always).
  });

  insert();
  eventBus.emitNotification({ type: "decision.recorded", id });

  const decision = db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as unknown as Decision;
  return decision;
}
