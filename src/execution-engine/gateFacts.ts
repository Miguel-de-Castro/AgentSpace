import type { Artifact, Evidence, Execution } from "../domain/types.js";

/**
 * .claude/plans/20-plano-consolidado.md Phase 1 — neutral facts shown at the
 * Approval Gate, all computed from what AgentSpace already recorded (Evidence,
 * git, Artifacts). None of them fails an Execution or blocks Allow; they only
 * make the decision better informed (guardrail #8).
 */

// ---- 1.6 cost per Execution ------------------------------------------------

export interface CostTotals {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}

export interface CostBreakdown {
  total: CostTotals | null;
  by_role: ({ role: string | null } & CostTotals)[];
}

function emptyTotals(): CostTotals {
  return { cost_usd: 0, input_tokens: 0, output_tokens: 0, duration_ms: 0 };
}

function addResult(into: CostTotals, r: Record<string, unknown>): void {
  const usage = (r.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  into.cost_usd += n(r.total_cost_usd);
  // Cached input is still input the model read; counted so the number matches
  // what an API bill would reflect, not just the uncached remainder.
  into.input_tokens += n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens);
  into.output_tokens += n(usage.output_tokens);
  into.duration_ms += n(r.duration_ms);
}

/**
 * Sums every `result` stream-json line (one per `claude -p` invocation, so one
 * per role) into an Execution total plus a per-role breakdown. `total` is null
 * when no result line exists at all (mock run, or a spawn that never started).
 */
export function sumExecutionCost(evidence: Evidence[]): CostBreakdown {
  const byRole = new Map<string | null, CostTotals>();
  let found = false;
  for (const e of evidence) {
    if (e.type !== "stream_json_line") continue;
    const p = e.payload as Record<string, unknown> | null;
    if (!p || p.type !== "result") continue;
    found = true;
    const key = e.team_member_role ?? null;
    const bucket = byRole.get(key) ?? emptyTotals();
    addResult(bucket, p);
    byRole.set(key, bucket);
  }
  if (!found) return { total: null, by_role: [] };
  const total = emptyTotals();
  for (const t of byRole.values()) {
    total.cost_usd += t.cost_usd;
    total.input_tokens += t.input_tokens;
    total.output_tokens += t.output_tokens;
    total.duration_ms += t.duration_ms;
  }
  return { total, by_role: [...byRole.entries()].map(([role, t]) => ({ role, ...t })) };
}

// ---- 1.4 "did QA run anything?" ------------------------------------------

export interface QaActivity {
  command_count: number;
  /** First few commands QA ran, trimmed — enough to recognize them, not a log. */
  commands: string[];
}

const MAX_LISTED_COMMANDS = 5;
const MAX_COMMAND_CHARS = 120;

/**
 * Counts the Bash tool calls attributed to QA. Null when QA wasn't part of
 * this Execution at all (no QA-attributed Evidence), so the gate says nothing
 * rather than a misleading "ran nothing."
 */
export function qaActivity(evidence: Evidence[]): QaActivity | null {
  const qaEvidence = evidence.filter((e) => e.team_member_role === "QA");
  if (qaEvidence.length === 0) return null;
  const commands: string[] = [];
  for (const e of qaEvidence) {
    if (e.type !== "stream_json_line") continue;
    const p = e.payload as { type?: string; message?: { content?: unknown[] } } | null;
    if (p?.type !== "assistant" || !Array.isArray(p.message?.content)) continue;
    for (const block of p.message.content as Record<string, unknown>[]) {
      if (block.type !== "tool_use" || block.name !== "Bash") continue;
      const command = String((block.input as { command?: unknown } | undefined)?.command ?? "").trim();
      commands.push(command.length > MAX_COMMAND_CHARS ? `${command.slice(0, MAX_COMMAND_CHARS)}…` : command);
    }
  }
  return { command_count: commands.length, commands: commands.slice(0, MAX_LISTED_COMMANDS) };
}

// ---- 1.1 secret guard ---------------------------------------------------------

export function secretGuardPaths(evidence: Evidence[]): string[] {
  const paths = new Set<string>();
  for (const e of evidence) {
    if (e.type !== "secret_guard") continue;
    for (const p of ((e.payload as { excluded_paths?: string[] })?.excluded_paths ?? [])) paths.add(p);
  }
  return [...paths].sort();
}

// ---- 1.5 file rollup ---------------------------------------------------------

export interface FileRollupEntry {
  path: string;
  added: number | null;
  removed: number | null;
  /** The most recent diff Artifact for this path, for the existing "View diff". */
  artifact_id: string | null;
}

export interface FileRollup {
  files: FileRollupEntry[];
  added: number;
  removed: number;
}

export function buildFileRollup(
  numstat: { path: string; added: number | null; removed: number | null }[],
  artifacts: Artifact[]
): FileRollup {
  // Artifacts arrive newest first (listArtifactsForMission), so the first match
  // is the latest Execution's diff of that path.
  const diffByPath = new Map<string, string>();
  for (const a of artifacts) {
    if (a.kind === "diff" && !diffByPath.has(a.title)) diffByPath.set(a.title, a.id);
  }
  const files = numstat.map((f) => ({ ...f, artifact_id: diffByPath.get(f.path) ?? null }));
  return {
    files,
    added: files.reduce((sum, f) => sum + (f.added ?? 0), 0),
    removed: files.reduce((sum, f) => sum + (f.removed ?? 0), 0),
  };
}

/**
 * The span of the Mission's current branch: from where its first Execution on
 * that branch started to where its latest one ended. An iterate continues the
 * same branch (plan 18), so this is the branch's whole net change — what Allow
 * would actually push — not just the last adjustment.
 */
export function branchSpan(executions: Execution[]): { beforeSha: string; afterSha: string } | undefined {
  const latest = executions[executions.length - 1];
  if (!latest?.git_after_sha) return undefined;
  const sameBranch = latest.branch_name ? executions.filter((e) => e.branch_name === latest.branch_name) : [latest];
  return { beforeSha: sameBranch[0].git_before_sha, afterSha: latest.git_after_sha };
}

// ---- Phase 4: criteria, findings, drift -------------------------------------------

export interface GateCriterion {
  text: string;
  source: "user" | "planner";
  /** One entry per AI reviewer that judged it (Reviewer, Challenger). */
  verdicts: { by: string; verdict: "met" | "not-met" | "unclear"; note: string }[];
}

export interface GateFinding {
  by: string;
  severity: "blocking" | "warning" | "info";
  path: string | null;
  line: number | null;
  text: string;
}

interface VerdictPayload {
  by: string;
  criteria: { n: number; verdict: "met" | "not-met" | "unclear"; note: string }[];
  findings: Omit<GateFinding, "by">[];
}

/** Criteria of the Mission with each reviewer's verdict from the latest Execution. */
export function criteriaWithVerdicts(
  criteria: { text: string; source: "user" | "planner" }[],
  evidence: Evidence[]
): GateCriterion[] {
  const verdicts = evidence.filter((e) => e.type === "review_verdict").map((e) => e.payload as VerdictPayload);
  return criteria.map((c, i) => ({
    ...c,
    verdicts: verdicts.flatMap((v) =>
      v.criteria.filter((x) => x.n === i + 1).map((x) => ({ by: v.by, verdict: x.verdict, note: x.note }))
    ),
  }));
}

const SEVERITY_ORDER = { blocking: 0, warning: 1, info: 2 } as const;

/** Every finding from the latest Execution's reviewers, blocking first (never gating Allow, #8). */
export function gateFindings(evidence: Evidence[]): GateFinding[] {
  return evidence
    .filter((e) => e.type === "review_verdict")
    .flatMap((e) => {
      const v = e.payload as VerdictPayload;
      return v.findings.map((f) => ({ ...f, by: v.by }));
    })
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * Files the branch changed that the Planner's FILES: list didn't mention.
 * Paths are compared loosely (one may be relative to a subfolder), so
 * "src/a.ts" matches "a.ts" and vice versa. Null when there was no plan list.
 */
export function planDrift(plannedFiles: string[] | undefined, changedPaths: string[]): { planned: string[]; unplanned: string[] } | null {
  if (!plannedFiles || plannedFiles.length === 0) return null;
  const norm = (p: string) => p.split("\\").join("/").replace(/^\.\//, "").toLowerCase();
  const planned = plannedFiles.map(norm);
  const unplanned = changedPaths.filter((c) => {
    const n = norm(c);
    return !planned.some((p) => n === p || n.endsWith("/" + p) || p.endsWith("/" + n));
  });
  return { planned: plannedFiles, unplanned };
}
