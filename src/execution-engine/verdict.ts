import type { FindingSeverity, RecommendationOutcome } from "../domain/types.js";

/**
 * .claude/plans/20-plano-consolidado.md Phase 4 — ONE verdict format for every
 * AI reviewer (the Reviewer role and the Challenger), so the Approval Gate can
 * show "criterion by criterion" and "blocking first" the same way whoever
 * wrote it:
 *
 *   CRITERION <n>: met | not-met | unclear - <note>
 *   FINDING [blocking|warning|info] <path>:<line> - <text>
 *   VERDICT: approve | iterate | reject-suggested
 *
 * Lines that don't match stay free text. Nothing is inferred: a missing
 * VERDICT stays missing (`outcome` undefined), a criterion the reviewer didn't
 * judge stays unjudged.
 */
export type CriterionVerdict = "met" | "not-met" | "unclear";

export interface ParsedVerdict {
  criteria: { n: number; verdict: CriterionVerdict; note: string }[];
  findings: { severity: FindingSeverity; path: string | null; line: number | null; text: string }[];
  outcome?: RecommendationOutcome;
  /** Everything that wasn't one of the structured lines, trimmed. */
  freeText: string;
}

const CRITERION_LINE = /^\s*[-*]?\s*`?CRITERION\s+(\d+)\s*:\s*(met|not[- ]met|unclear)\b\s*[-:—–]?\s*(.*?)`?\s*$/i;
const FINDING_LINE = /^\s*[-*]?\s*`?FINDING\s*\[(blocking|warning|info)\]\s*(.*?)`?\s*$/i;
const VERDICT_LINE = /^\s*[-*]?\s*`?VERDICT\s*:\s*(approve|iterate|reject-suggested|reject)\b/i;
// "<path>:<line> - text", "<path> - text", or just text.
const LOCATION = /^([^\s:]+\.[A-Za-z0-9]+)(?::(\d+))?\s*[-:—–]\s*(.*)$/;

export function parseVerdict(text: string): ParsedVerdict {
  const criteria: ParsedVerdict["criteria"] = [];
  const findings: ParsedVerdict["findings"] = [];
  let outcome: RecommendationOutcome | undefined;
  const rest: string[] = [];

  for (const line of text.split("\n")) {
    const c = line.match(CRITERION_LINE);
    if (c) {
      const v = c[2].toLowerCase().replace(" ", "-") as CriterionVerdict;
      criteria.push({ n: Number(c[1]), verdict: v, note: c[3].trim() });
      continue;
    }
    const f = line.match(FINDING_LINE);
    if (f) {
      const body = f[2].trim();
      const loc = body.match(LOCATION);
      findings.push({
        severity: f[1].toLowerCase() as FindingSeverity,
        path: loc ? loc[1] : null,
        line: loc?.[2] ? Number(loc[2]) : null,
        text: (loc ? loc[3] : body).trim(),
      });
      continue;
    }
    const v = line.match(VERDICT_LINE);
    if (v) {
      const raw = v[1].toLowerCase();
      outcome = raw === "approve" ? "approve" : raw === "iterate" ? "iterate" : "reject-suggested";
      continue;
    }
    rest.push(line);
  }

  return { criteria, findings, outcome, freeText: rest.join("\n").trim() };
}
