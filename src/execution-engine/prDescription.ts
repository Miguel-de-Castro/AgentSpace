import type { FileRollup, GateCriterion } from "./gateFacts.js";

/**
 * .claude/plans/24-ideias-para-analisar.md item 6 — a copy-ready pull request
 * title + body, assembled only from what the Mission already recorded (the
 * Reasoning Summary, the file rollup, criteria verdicts, the build check). Pure
 * formatting: no invention beyond the evidenced data (T-003). AgentSpace still
 * never opens the PR itself (plan 13) — this just saves writing the text.
 */

export interface PrDescriptionInput {
  brief: string;
  summary: string;
  rollup: FileRollup | null;
  criteria: GateCriterion[];
  buildSummary: string | null;
}

const MAX_TITLE = 72;
const MAX_FILES = 30;

export function prTitleFromBrief(brief: string): string {
  const first = brief.trim().split("\n")[0].replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  return first.length > MAX_TITLE ? `${first.slice(0, MAX_TITLE - 1).trimEnd()}…` : first;
}

function criterionLine(c: GateCriterion): string {
  if (c.verdicts.length === 0) return `- [ ] ${c.text} (not reviewed)`;
  const allMet = c.verdicts.every((v) => v.verdict === "met");
  const anyNotMet = c.verdicts.some((v) => v.verdict === "not-met");
  const mark = allMet ? "x" : " ";
  const status = allMet ? "met" : anyNotMet ? "not met" : "unclear";
  return `- [${mark}] ${c.text} (${status}, per ${[...new Set(c.verdicts.map((v) => v.by))].join(" and ")})`;
}

export function formatPrDescription(input: PrDescriptionInput): { title: string; body: string } {
  const parts: string[] = ["## Summary", "", input.summary.trim()];

  if (input.rollup && input.rollup.files.length > 0) {
    const shown = input.rollup.files.slice(0, MAX_FILES);
    parts.push("", "## Changes", "");
    parts.push(`${input.rollup.files.length} ${input.rollup.files.length === 1 ? "file" : "files"} changed, +${input.rollup.added} −${input.rollup.removed}.`, "");
    for (const f of shown) {
      const counts = f.added === null || f.removed === null ? "binary" : `+${f.added} −${f.removed}`;
      parts.push(`- \`${f.path}\` (${counts})`);
    }
    if (input.rollup.files.length > shown.length) parts.push(`- …and ${input.rollup.files.length - shown.length} more`);
  }

  if (input.criteria.length > 0) {
    parts.push("", "## Acceptance criteria", "", ...input.criteria.map(criterionLine));
  }

  if (input.buildSummary) {
    parts.push("", "## Verification", "", `- Build check: ${input.buildSummary}`);
  }

  parts.push("", "---", "_Generated from the Mission's recorded Evidence._");
  return { title: prTitleFromBrief(input.brief), body: parts.join("\n") };
}
