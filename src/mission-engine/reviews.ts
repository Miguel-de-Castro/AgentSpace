import { getDb, runInTransaction } from "../db/client.js";
import { newId } from "../util/id.js";
import { eventBus } from "../api/eventBus.js";
import type { Finding, FindingSeverity, RecommendationOutcome, Review, ReviewAuthorType } from "../domain/types.js";

interface ReviewRow {
  id: string;
  mission_id: string;
  author_type: ReviewAuthorType;
  author_role: string | null;
  recommendation_outcome: RecommendationOutcome;
  recommendation_rationale: string;
  created_at: string;
}

function attachChildren(row: ReviewRow): Review {
  const db = getDb();
  const findings = db.prepare("SELECT * FROM findings WHERE review_id = ? ORDER BY created_at ASC").all(row.id) as unknown as Finding[];
  const artifactRows = db.prepare("SELECT artifact_id FROM review_artifacts WHERE review_id = ?").all(row.id) as unknown as { artifact_id: string }[];
  return { ...row, findings, artifact_ids: artifactRows.map((r) => r.artifact_id) };
}

export function listReviews(missionId: string): Review[] {
  const rows = getDb()
    .prepare("SELECT * FROM reviews WHERE mission_id = ? ORDER BY created_at DESC")
    .all(missionId) as unknown as ReviewRow[];
  return rows.map(attachChildren);
}

export function getReview(id: string): Review | undefined {
  const row = getDb().prepare("SELECT * FROM reviews WHERE id = ?").get(id) as unknown as ReviewRow | undefined;
  return row ? attachChildren(row) : undefined;
}

export interface SubmitReviewInput {
  artifact_ids: string[];
  recommendation_outcome: RecommendationOutcome;
  recommendation_rationale: string;
  findings?: { artifact_id: string; evidence_id?: string | null; text: string; severity: FindingSeverity }[];
}

/**
 * docs/07-SCHEMA_API_CONTRACT.md §7.4 — `author_type` is always set here to
 * the value the caller is authorized for, never trusted from request body
 * fields the client could forge. This function is for human-authored
 * Reviews (submitted via the API, author resolved from the session by the
 * route layer); AI-authored Reviews use submitAiReview below, called
 * directly by Execution Engine from Provider Adapter output — never
 * through the public HTTP surface.
 */
export function submitHumanReview(missionId: string, input: SubmitReviewInput): Review {
  return submitReview(missionId, "human", null, input);
}

export function submitAiReview(missionId: string, authorRole: string, input: SubmitReviewInput): Review {
  return submitReview(missionId, "ai_team_member", authorRole, input);
}

function submitReview(
  missionId: string,
  authorType: ReviewAuthorType,
  authorRole: string | null,
  input: SubmitReviewInput
): Review {
  const db = getDb();
  const id = newId();

  const insert = () => runInTransaction(db, () => {
    db.prepare(
      `INSERT INTO reviews (id, mission_id, author_type, author_role, recommendation_outcome, recommendation_rationale)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, missionId, authorType, authorRole, input.recommendation_outcome, input.recommendation_rationale);

    const linkArtifact = db.prepare("INSERT INTO review_artifacts (review_id, artifact_id) VALUES (?, ?)");
    for (const artifactId of input.artifact_ids) linkArtifact.run(id, artifactId);

    const insertFinding = db.prepare(
      `INSERT INTO findings (id, review_id, artifact_id, evidence_id, text, severity) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const finding of input.findings ?? []) {
      insertFinding.run(newId(), id, finding.artifact_id, finding.evidence_id ?? null, finding.text, finding.severity);
    }
  });

  insert();
  eventBus.emitNotification({ type: "review.submitted", id });

  const review = getReview(id);
  if (!review) throw new Error("Failed to read back submitted review");
  return review;
}
