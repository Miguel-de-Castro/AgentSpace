import { getProviderAdapter } from "../provider-adapter/index.js";
import { submitAiReview } from "../mission-engine/reviews.js";
import { verdictInstructions } from "../domain/verdictFormat.js";
import { parseVerdict, type ParsedVerdict } from "./verdict.js";
import type { AcceptanceCriterion, AssignedTeamEntry, FindingSeverity } from "../domain/types.js";

/**
 * .claude/plans/20-plano-consolidado.md Phase 1 — the "Plan Council" idea from
 * VibeIDE (docs/notes/COMPARATIVO_VIBEIDE.md), adapted to AgentSpace's grain: an
 * independent adversarial review of what the working roles produced, recorded as
 * an AI Review (advice, never a decision — guardrail #8) and surfaced in the
 * Approval Gate.
 *
 * It deliberately uses `synthesize()` (non-agentic, no tools, no worktree) fed
 * the actual git diff, rather than adding another agentic role to the chain:
 * it's cheaper, needs no stream-json parsing, and is genuinely independent (a
 * fresh call that shares no context with whoever wrote the code). It runs on the
 * process's active provider today; plan 20 Phase 5 swaps in a *different*
 * provider here to make the review truly cross-model — the seam is this one
 * `getProviderAdapter()` call.
 *
 * Phase 4 — it now answers in the same verdict format as the Reviewer role
 * (criterion by criterion, findings with severity, one VERDICT line), parsed by
 * execution-engine/verdict.ts.
 */
export const CHALLENGER_ROLE = "Challenger";

export function assignedTeamHasChallenger(assignedTeam: AssignedTeamEntry[]): boolean {
  return assignedTeam.some((t) => t.role === CHALLENGER_ROLE);
}

const MAX_DIFF_CHARS = 20000;

function buildChallengerPrompt(
  brief: string,
  referenceMaterial: unknown | undefined,
  criteria: AcceptanceCriterion[],
  diffText: string
): string {
  const diff = diffText.length > MAX_DIFF_CHARS ? `${diffText.slice(0, MAX_DIFF_CHARS)}\n…(diff truncated)` : diffText;
  return [
    "You are the Challenger: an independent, critical reviewer on an AI software team.",
    "Another agent just made the code changes below to accomplish a mission. You did NOT write them and share no context with whoever did — review them with fresh, skeptical eyes.",
    "",
    "Judge whether these changes actually and correctly accomplish the mission brief. Point out real risks, missed cases, likely bugs, and anything you'd do differently. Be concrete and refer to the diff. Do NOT rewrite the code.",
    "",
    `Mission brief: ${brief}`,
    referenceMaterial ? `Reference material: ${JSON.stringify(referenceMaterial)}` : "",
    ...(criteria.length > 0 ? ["", "Acceptance criteria:", ...criteria.map((c, i) => `${i + 1}. ${c.text}`)] : []),
    "",
    "The changes (git diff):",
    diff || "(no textual diff available)",
    "",
    "Write 2-5 plain sentences of critique, then:",
    ...verdictInstructions(criteria),
    "- approve = the changes look correct and complete for the brief",
    "- iterate = they mostly work but need specific fixes (name them in your findings)",
    "- reject-suggested = wrong approach, or seriously broken",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export interface ChallengerReviewInput {
  missionId: string;
  brief: string;
  referenceMaterial?: unknown;
  criteria: AcceptanceCriterion[];
  diffText: string;
  artifactIds: string[];
  /** Diff Artifact id per changed path, to attach findings to the right file. */
  artifactIdByPath: Map<string, string>;
}

/**
 * Runs the review and returns what it said (parsed), or undefined when the
 * provider call failed or came back empty. An AI Review is recorded only when
 * the Challenger gave an explicit VERDICT: an unparseable answer is kept as
 * free text by the caller, never turned into an invented recommendation.
 */
export async function runChallengerReview(input: ChallengerReviewInput): Promise<ParsedVerdict | undefined> {
  const prompt = buildChallengerPrompt(input.brief, input.referenceMaterial, input.criteria, input.diffText);
  let text: string;
  try {
    text = await getProviderAdapter().synthesize(prompt);
  } catch (err) {
    console.error(`Challenger review for mission ${input.missionId} failed to run:`, err);
    return undefined;
  }
  if (!text.trim()) return undefined;

  const parsed = parseVerdict(text);
  if (parsed.outcome) {
    submitAiReview(input.missionId, CHALLENGER_ROLE, {
      artifact_ids: input.artifactIds,
      recommendation_outcome: parsed.outcome,
      recommendation_rationale: parsed.freeText || "The Challenger gave a verdict without further comment.",
      findings: findingsForArtifacts(parsed, input.artifactIdByPath),
    });
  }
  return parsed;
}

/**
 * Findings whose path is one of the changed files become `findings` rows (the
 * table requires an Artifact). Every finding, matched or not, also lives in the
 * `review_verdict` Evidence the Approval Gate reads.
 */
export function findingsForArtifacts(
  parsed: ParsedVerdict,
  artifactIdByPath: Map<string, string>
): { artifact_id: string; text: string; severity: FindingSeverity }[] {
  const out: { artifact_id: string; text: string; severity: FindingSeverity }[] = [];
  for (const f of parsed.findings) {
    if (!f.path) continue;
    const artifactId = artifactIdByPath.get(f.path) ?? [...artifactIdByPath.entries()].find(([p]) => p.endsWith(f.path!))?.[1];
    if (artifactId) out.push({ artifact_id: artifactId, text: f.line ? `${f.path}:${f.line} - ${f.text}` : `${f.path} - ${f.text}`, severity: f.severity });
  }
  return out;
}
