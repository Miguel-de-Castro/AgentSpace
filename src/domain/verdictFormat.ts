// .claude/plans/20-plano-consolidado.md Phase 4 — the verdict format every AI
// reviewer is asked for (the Reviewer role's prompt in the Provider Adapter and
// the Challenger's in Execution Engine). Lives in the domain layer because it's
// AgentSpace vocabulary shared by both; the parser is execution-engine/verdict.ts.
/** The instructions every AI reviewer gets, so the format stays one. */
export function verdictInstructions(criteria: { text: string }[]): string[] {
  const lines: string[] = [];
  if (criteria.length > 0) {
    lines.push(
      "Judge EACH acceptance criterion against the actual changes, one line each, exactly:",
      "CRITERION <n>: met | not-met | unclear - <short note>"
    );
  }
  lines.push(
    "Report each concrete problem on its own line, most serious first:",
    "FINDING [blocking|warning|info] <path>:<line> - <what is wrong>",
    "(blocking = must be fixed before this ships; warning = should be fixed; info = worth knowing.)",
    "End with exactly one line: VERDICT: approve | iterate | reject-suggested"
  );
  return lines;
}
