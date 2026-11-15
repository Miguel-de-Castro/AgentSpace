import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import type { ProviderAdapter, ProviderEvent, ProviderRoleSession, ProviderRunInput, ProviderRunResult } from "./types.js";

/** What one `claude -p` invocation produced, before it's folded into the run. */
interface InvocationResult {
  events: ProviderEvent[];
  outcome: ProviderRunResult["outcome"];
  sessionId?: string;
  /** A rate_limit_event with status 'rejected' arrived during this invocation. */
  limitHit?: { resetsAt?: number };
  /** The `result` line's text: the role's final answer. */
  finalText?: string;
}
import { RUN_ALLOWED_TOOLS, RUN_DISALLOWED_TOOLS, roleToolCeiling, type AssignedTeamEntry, type PermissionPolicy } from "../domain/types.js";
import { verdictInstructions } from "../domain/verdictFormat.js";
import { withPlannerCriteria } from "./roleConventions.js";

/**
 * Real integration mechanism, per docs/02-DOMAIN.md Architecture Discovery
 * Findings and docs/03-ARCHITECTURE.md §6 (T-001/T-004, validated):
 *
 *   claude -p --output-format stream-json
 *
 * invoked as a direct CLI subprocess, authenticated via the user's existing
 * subscription login. Never the Claude Agent SDK, never `--bare` — both
 * silently require API-key billing (T-004, `16-ASSUMPTIONS.md`), which
 * would violate the "no paid API required" constraint the whole product is
 * built on.
 *
 * .claude/plans/completed/14-real-multi-agent-execution.md — an Assigned
 * Team is no longer flattened into one prompt string handed to a single
 * invocation. Each assigned role gets its own sequential `claude -p`
 * invocation (recommendation 2 of that plan, chosen over native Claude Code
 * subagents: real per-role Evidence attribution without depending on
 * unconfirmed subagent stream-json shape). All invocations share the same
 * worktree, so hand-off between roles is just "the files are already there"
 * — no explicit hand-off payload is constructed. A Mission with no
 * Assigned Team (or one whose roles don't map onto the canonical order at
 * all) still gets exactly the old single flattened invocation, preserving
 * prior behavior for that case.
 *
 * What this still does NOT do, flagged rather than silently assumed:
 *   - Parse the true `stream-json` line shape into typed ProviderEvents
 *     (this passes each line through as a raw, untyped event — Execution
 *     Engine's schema-defense layer, docs/03-ARCHITECTURE.md §4, is the
 *     place that shape validation belongs, and hasn't been built yet).
 *   - Wire up the blocking-hook enforcement for protected-branch merges
 *     (docs/03-ARCHITECTURE.md §5.1/§6) — that requires a Claude Code hook
 *     configuration this scaffold doesn't install yet.
 *   - Session-resume for `resume-after-approval` triggers (§5.1) — every
 *     run here is currently a fresh `claude -p` invocation.
 *
 * Per-role tool ceilings (14's old "Aberto") are now enforced as real CLI
 * flags, intersected with the Project's policy — see permissionArgsForRole.
 */
export class ClaudeCodeAdapter implements ProviderAdapter {
  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    let roles = resolveRoleOrder(input.assignedTeam);

    if (roles.length === 0) {
      const resumeId = input.resume?.sessions[""];
      const result = await this.runWithResumeFallback(
        resumeId ? input.resume!.note : buildFlattenedPrompt(input),
        () => `${buildFlattenedPrompt(input)}\n\n${input.resume?.note ?? ""}`,
        input,
        undefined,
        resumeId
      );
      const question = input.allowQuestions ? extractQuestion(result.finalText) : undefined;
      return foldResult(result.events, [{ role: "", result }], result.outcome, question ? { question, role: "" } : undefined);
    }

    // .claude/plans/20-plano-consolidado.md Phase 3.3 — the Planner's work is
    // already done (its plan was approved), so later runs skip it.
    if (input.skipRoles?.length) roles = roles.filter((r) => !input.skipRoles!.includes(r));

    // .claude/plans/20-plano-consolidado.md Phase 3 — resuming skips the roles
    // that already finished and continues `fromRole` in its own session.
    if (input.resume?.fromRole && roles.includes(input.resume.fromRole)) {
      roles = roles.slice(roles.indexOf(input.resume.fromRole));
    }

    const allEvents: ProviderEvent[] = [];
    const ran: { role: string; result: InvocationResult }[] = [];
    let outcome: ProviderRunResult["outcome"] = "success";
    let asked: { question: string; role: string } | undefined;

    for (let i = 0; i < roles.length; i++) {
      // .claude/plans/15-live-execution-feedback.md Part 3 — a cancel that
      // arrived between two per-role invocations stops the chain before
      // spawning the next role, rather than only interrupting the one that
      // happened to be live.
      if (input.signal?.aborted) {
        outcome = "interrupted";
        break;
      }
      const role = roles[i];
      const resumeId = i === 0 && input.resume?.fromRole === role ? input.resume.sessions[role] : undefined;
      const freshPrompt = () => buildRolePrompt(role, input, i === 0 && !input.resume);
      const result = await this.runWithResumeFallback(
        resumeId ? input.resume!.note : freshPrompt(),
        () => `${freshPrompt()}\n\n${input.resume?.note ?? ""}`,
        input,
        role,
        resumeId
      );
      allEvents.push(...result.events);
      ran.push({ role, result });

      if (result.outcome !== "success" || result.limitHit) {
        // Stop the chain — running QA/Reviewer against a broken or
        // interrupted state would just produce noise, not a real check.
        outcome = result.limitHit ? "interrupted" : result.outcome;
        break;
      }

      // .claude/plans/20-plano-consolidado.md Phase 3.2 — the role stopped to
      // ask the supervisor something only they know. Later roles would just
      // work around the gap, so the chain stops here and the Mission waits.
      const question = input.allowQuestions ? extractQuestion(result.finalText) : undefined;
      if (question) {
        asked = { question, role };
        outcome = "interrupted";
        break;
      }

      // Phase 3.3 — a plan checkpoint runs the Planner alone.
      if (input.stopAfterRole === role) break;

      // Phase 4 (D4) — criteria the Planner just added apply to the roles after
      // it in this same run (Execution Engine also persists them on the Mission).
      if (role === "Planner") input = withPlannerCriteria(input, result.finalText);
    }

    return foldResult(allEvents, ran, outcome, asked);
  }

  /**
   * ADR-005 — `--resume` works across worktrees, but a session can still be
   * gone (cleared by the user, another machine). When a resumed invocation
   * dies before it even starts a session, run the role fresh instead, with the
   * resume note appended, so an answer/adjustment is never lost to a stale id.
   */
  private async runWithResumeFallback(
    prompt: string,
    freshPrompt: () => string,
    input: ProviderRunInput,
    role: string | undefined,
    resumeId: string | undefined
  ): Promise<InvocationResult> {
    const result = await this.runOneInvocation(prompt, input, role, resumeId);
    if (!resumeId || result.sessionId || result.outcome !== "failure" || input.signal?.aborted) return result;
    input.onEvent?.({
      type: "resume_fallback",
      raw: { message: "The earlier session could not be resumed; this role started a fresh session instead.", session_id: resumeId },
      occurredAt: new Date().toISOString(),
      role,
    });
    const fresh = await this.runOneInvocation(freshPrompt(), input, role);
    return { ...fresh, events: [...result.events, ...fresh.events] };
  }

  private async runOneInvocation(
    prompt: string,
    input: ProviderRunInput,
    role?: string,
    resumeSessionId?: string
  ): Promise<InvocationResult> {
    const events: ProviderEvent[] = [];
    let sessionId: string | undefined;
    let limitHit: InvocationResult["limitHit"];
    let finalText: string | undefined;
    // .claude/plans/15-live-execution-feedback.md Part 1 — record the event
    // both in the aggregate (returned at the end) and, synchronously, upward
    // so Execution Engine can persist it live.
    const emit = (event: ProviderEvent) => {
      events.push(event);
      input.onEvent?.(event);
    };

    return new Promise((resolve) => {
      // `--verbose` is required alongside `--output-format stream-json` in
      // `-p` mode — confirmed empirically 2026-08-12 (the CLI errors
      // immediately without it: "Error: When using --print,
      // --output-format=stream-json requires --verbose").
      const args = [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        ...permissionArgsForRole(input.permissionPolicy, role),
        // ADR-005 (2.1): works from a different cwd even after the original
        // worktree is gone; --fork-session gives this Execution its own id.
        ...(resumeSessionId ? ["--resume", resumeSessionId, "--fork-session"] : []),
      ];
      const child = spawn("claude", args, {
        cwd: input.worktreePath,
      });
      // Nothing is ever written to stdin (the prompt goes via argv above) —
      // closing it immediately avoids the CLI's few-second wait for stdin
      // data before proceeding, confirmed via the same real run.
      child.stdin.end();

      let stderr = "";

      // .claude/plans/15-live-execution-feedback.md Part 3 — real cancel.
      // When the outside signal fires we kill the process tree (see
      // killProcessTree — on Windows a plain SIGTERM leaves `claude`'s own
      // child processes running, which was part of the original bug) and
      // remember that *we* did it, so `close` resolves as "interrupted"
      // rather than the "failure" a non-zero exit would otherwise mean.
      let killedByUs = false;
      const onAbort = () => {
        killedByUs = true;
        emit({
          type: "execution_cancelled",
          raw: { message: "Execution cancelled by the user — the provider process was terminated." },
          occurredAt: new Date().toISOString(),
          role,
        });
        killProcessTree(child);
      };
      if (input.signal) {
        if (input.signal.aborted) {
          // Aborted before we even attached — resolve without spawning work.
          onAbort();
        } else {
          input.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stdout.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf-8").split("\n")) {
          if (!line.trim()) continue;
          const occurredAt = new Date().toISOString();
          try {
            const parsed = JSON.parse(line);
            emit({ type: "stream_json_line", raw: parsed, occurredAt, role });
            // ADR-005: the init line carries this invocation's session id.
            if (parsed?.type === "system" && parsed.subtype === "init" && typeof parsed.session_id === "string") {
              sessionId = parsed.session_id;
            }
            if (parsed?.type === "result" && typeof parsed.result === "string") finalText = parsed.result;
            // Confirmed empirically (.claude/plans/completed/04-usage-rate-limit.md) that
            // real `claude -p --output-format stream-json` output includes this
            // line shape. Pushed as its own distinguished event — in addition
            // to, not instead of, the generic line above — so Execution Engine
            // can react to it without parsing every stream-json line's shape.
            // Deliberately no `role` here — rate-limit state is workspace-scoped,
            // not attributable to one Team Member.
            if (parsed?.type === "rate_limit_event" && parsed.rate_limit_info) {
              emit({ type: "rate_limit_event", raw: parsed.rate_limit_info, occurredAt });
              // .claude/plans/20-plano-consolidado.md Phase 3 (21-A) — the one
              // signal we trust for "the subscription refused": status
              // 'rejected' (seen fields: status, resetsAt, rateLimitType). The
              // exact shape at a real limit is still unconfirmed (D7); the 1.8
              // capture trap records it when it happens.
              if (parsed.rate_limit_info.status === "rejected") {
                const resetsAt = Number(parsed.rate_limit_info.resetsAt);
                limitHit = { resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : undefined };
              }
            }
          } catch {
            emit({ type: "unparsed_line", raw: line, occurredAt, role });
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("error", () => {
        input.signal?.removeEventListener("abort", onAbort);
        // Most commonly: `claude` isn't on PATH. Record as an interrupted
        // run rather than throwing — the caller (Execution Engine) still
        // needs to close out the Execution row cleanly.
        emit({
          type: "provider_spawn_error",
          raw: { message: "Failed to spawn `claude` CLI — is it installed and on PATH?" },
          occurredAt: new Date().toISOString(),
          role,
        });
        resolve({ events, outcome: "interrupted", sessionId, limitHit, finalText });
      });

      child.on("close", (code) => {
        input.signal?.removeEventListener("abort", onAbort);
        if (stderr) {
          emit({ type: "stderr", raw: stderr, occurredAt: new Date().toISOString(), role });
        }
        // .claude/plans/20-plano-consolidado.md item 1.8 — the exit code is part
        // of what the usage-limit capture trap records; nothing else surfaced it.
        emit({ type: "provider_exit", raw: { code, killed_by_user: killedByUs }, occurredAt: new Date().toISOString(), role });
        if (killedByUs) {
          resolve({ events, outcome: "interrupted", sessionId, limitHit, finalText });
          return;
        }
        resolve({ events, outcome: code === 0 ? "success" : "failure", sessionId, limitHit, finalText });
      });
    });
  }

  /**
   * .claude/plans/completed/09-reasoning-summary.md — `--tools ""` confirmed
   * empirically (2026-08-12, ad hoc spike) to genuinely disable every tool
   * and just answer in plain text; no worktree/cwd matters since nothing can
   * touch the filesystem. Deliberately plain-text output, not
   * `--output-format stream-json` — there's no multi-turn tool activity to
   * stream here, just one completion.
   */
  async synthesize(prompt: string, opts: { signal?: AbortSignal; cwd?: string; tools?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      // Phase 7.7: a routine passes a worktree and a read-only tool list; everyone else keeps "no tools".
      const child = spawn("claude", ["-p", prompt, "--tools", opts.tools ?? ""], { cwd: opts.cwd ?? process.cwd() });
      child.stdin.end();

      // .claude/plans/20-plano-consolidado.md item 1.7 — a caller on a
      // latency-sensitive path (branch naming) can give up; kill the process
      // rather than leave it running in the background.
      const onAbort = () => {
        killProcessTree(child);
        reject(new Error("synthesize aborted"));
      };
      if (opts.signal?.aborted) {
        onAbort();
        return;
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("error", () => {
        opts.signal?.removeEventListener("abort", onAbort);
        reject(new Error("Failed to spawn `claude` CLI — is it installed and on PATH?"));
      });

      child.on("close", (code) => {
        opts.signal?.removeEventListener("abort", onAbort);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `claude exited with code ${code}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}

/**
 * .claude/plans/20-plano-consolidado.md Phase 3 — turns the per-role
 * invocations into the provider-agnostic result: which sessions exist (for a
 * later resume) and whether the run paused on a usage limit rather than
 * failing.
 */
function foldResult(
  events: ProviderEvent[],
  ran: { role: string; result: InvocationResult }[],
  outcome: ProviderRunResult["outcome"],
  asked?: { question: string; role: string }
): ProviderRunResult {
  const sessions: ProviderRoleSession[] = ran
    .filter((r) => r.result.sessionId)
    .map((r) => ({
      role: r.role,
      sessionId: r.result.sessionId!,
      // A role that stopped to ask hasn't finished its part: the answer
      // resumes that same session.
      completed: r.result.outcome === "success" && !r.result.limitHit && !(asked && asked.role === r.role),
      ...(r.result.finalText ? { finalText: r.result.finalText } : {}),
    }));
  const limited = ran.find((r) => r.result.limitHit);
  if (limited) {
    return {
      events,
      outcome: "interrupted",
      sessions,
      paused: { reason: "usage-limit", resetsAt: limited.result.limitHit!.resetsAt },
    };
  }
  if (asked) {
    return { events, outcome: "interrupted", sessions, paused: { reason: "needs-input", ...asked } };
  }
  return { events, outcome, sessions };
}

/**
 * .claude/plans/20-plano-consolidado.md Phase 3.2 — the convention every role
 * is told about: a last line `NEEDS_INPUT: <question>`. Only the LAST
 * non-empty line counts, so a role quoting the convention mid-answer isn't
 * mistaken for asking.
 */
const NEEDS_INPUT_MARKER = /^\s*NEEDS_INPUT:\s*(.+?)\s*$/;
export function extractQuestion(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  const match = last?.match(NEEDS_INPUT_MARKER);
  return match?.[1]?.trim() || undefined;
}

/**
 * .claude/plans/15-live-execution-feedback.md Part 3 — kill the whole process
 * tree, not just the `claude` process we spawned. On Windows, Node's
 * `child.kill()` calls TerminateProcess on that one PID only; the tool
 * subprocesses `claude` itself spawns (bash, editors, etc.) survive it, which
 * is exactly the "the process kept running after Cancel" symptom this plan
 * exists to fix. `taskkill /t` terminates the tree; on POSIX a SIGTERM to the
 * process is the straightforward equivalent for this scaffold. Best-effort —
 * an already-dead process just makes this a no-op.
 */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // Process already gone, or taskkill unavailable — nothing left to do.
  }
}

function buildFlattenedPrompt(input: ProviderRunInput): string {
  const team = input.assignedTeam.map((t) => t.role).join(", ");
  const base = team ? `Team: ${team}\n\nBrief:\n${input.brief}` : `Brief:\n${input.brief}`;
  const withRules = [
    base,
    ...criteriaLines(undefined, input),
    ...projectInstructionLines(undefined, input),
    "",
    questionInstruction(input.allowQuestions),
  ].join("\n");
  return input.adjustment ? `${adjustmentPreamble(input.adjustment)}\n\n${withRules}` : withRules;
}

// .claude/plans/20-plano-consolidado.md Phase 7.1 (D5) — the Project's own
// guidance comes AFTER AgentSpace's role definition and is framed as an
// addition: it can refine how the work is done, never change what the role is
// (a QA told "fix things" by a Project note still has no Edit/Write tools).
function projectInstructionLines(role: string | undefined, input: ProviderRunInput): string[] {
  const general = input.projectInstructions?.trim();
  const specific = role ? input.roleInstructions?.[role]?.trim() : undefined;
  if (!general && !specific) return [];
  const lines = ["", "Guidance from this project's owner (follow it in addition to your role above; it does not change your role):"];
  if (general) lines.push(general);
  if (specific) lines.push(`For the ${role}: ${specific}`);
  return lines;
}

// .claude/plans/20-plano-consolidado.md Phase 3.2 — a single question, only
// when it truly blocks, and never once the Mission's question budget is spent.
function questionInstruction(allowQuestions: boolean | undefined): string {
  return allowQuestions
    ? "If you truly cannot continue without information only the user has (not something you can find in the code or reasonably assume), stop and make the LAST line of your answer exactly `NEEDS_INPUT: <one short question>`. Otherwise never use that marker; when something is unclear but guessable, make a sensible assumption and state it."
    : "The user can't be asked questions right now: when something is unclear, make a sensible assumption and state it plainly in your answer.";
}

// .claude/plans/20-plano-consolidado.md Phase 4 (D4) — what "done" means. The
// user's criteria come first; the Planner may add missing ones (marked), the
// Reviewer judges each one.
function criteriaLines(role: string | undefined, input: ProviderRunInput): string[] {
  const criteria = input.acceptanceCriteria ?? [];
  const lines: string[] = [];
  if (criteria.length > 0) {
    lines.push("", "Acceptance criteria (what \"done\" means for this Mission):");
    criteria.forEach((c, i) => lines.push(`${i + 1}. ${c.text}${c.source === "planner" ? " (added by the Planner)" : ""}`));
  }
  if (role === "Planner") {
    lines.push(
      "",
      criteria.length > 0
        ? "If an important acceptance criterion is missing, add it on its own line as `CRITERION+: <text>`. Don't restate the ones above."
        : "The user wrote no acceptance criteria. Propose 2-5 concrete, checkable ones, each on its own line as `CRITERION+: <text>`."
    );
  }
  if (role === "Reviewer") {
    // Phase 4 — the same verdict format the Challenger uses (domain/verdictFormat.ts).
    lines.push("", ...verdictInstructions(criteria));
  }
  return lines;
}

// .claude/plans/18-mock-provider-safety-and-prod-start.md — an iterate run's
// correction is the primary instruction: the previous attempt's work is
// already in the worktree, and this says what to change about it.
function adjustmentPreamble(adjustment: string): string {
  return [
    "This is a follow-up adjustment to earlier work that is already present in this directory.",
    "The user reviewed the previous result and asked for this correction — treat it as the primary instruction:",
    adjustment,
  ].join("\n");
}

// .claude/plans/completed/14-real-multi-agent-execution.md — fixed v1 order
// (no dynamic re-ordering per Mission); roles outside this list run last, in
// whatever order they appear in the Mission's Assigned Team.
const CANONICAL_ROLE_ORDER = ["Planner", "Developer", "QA", "Reviewer"];

function resolveRoleOrder(assignedTeam: AssignedTeamEntry[]): string[] {
  // .claude/plans/20-cross-model-review-council.md Phase 1 — "Challenger" is not
  // an agentic role in the chain; it runs post-hoc as a non-agentic review of
  // the diff (execution-engine/challengerReview.ts). Filter it out here so it's
  // never spawned as a code-touching invocation (nor as an "extra" role below).
  const assignedRoles = assignedTeam.map((t) => t.role).filter((r) => r !== "Challenger");
  const assignedSet = new Set(assignedRoles);
  const ordered = CANONICAL_ROLE_ORDER.filter((r) => assignedSet.has(r));
  const extras = assignedRoles.filter((r) => !CANONICAL_ROLE_ORDER.includes(r));
  return [...ordered, ...extras];
}

// Deliberately brief, plain-English responsibilities — not sourced from any
// doc (docs/02-DOMAIN.md only names the roles, never their job
// descriptions), just reasonable defaults for how each role should behave
// relative to the others in the same worktree.
const ROLE_RESPONSIBILITIES: Record<string, string> = {
  Planner:
    "Investigate the codebase and the brief, then produce a short, concrete plan for how to accomplish it — which files need to change and in what order. Do not edit any files yourself; only investigate and plan.",
  Developer: "Implement the mission's brief — make the actual code changes needed to accomplish it.",
  // .claude/plans/20-plano-consolidado.md item 1.3 (decision D2) — QA only
  // reports. It also has no Edit/Write tools (ROLE_TOOL_CEILING), so this is
  // backed by a real restriction, not just the instruction.
  QA: "Verify the work done so far against the brief by actually running something checkable — the project's tests, its build, a type check, or a small command that exercises the changed code — then report what you ran, what happened, and any bugs or missed cases you found. Never fix anything yourself, not even small issues, and never modify files (including through the shell): only run, observe, and report clearly. If nothing in this project can be run, say so plainly instead of guessing. Report each concrete problem on its own line as `FINDING [blocking|warning|info] <path>:<line> - <what is wrong>` (blocking = must be fixed before this ships).",
  Reviewer:
    "Give a final, critical look at the net changes made so far against the brief. Do not make further code changes yourself — only assess and report your findings plainly.",
};

function buildRolePrompt(role: string, input: ProviderRunInput, isFirstRole: boolean): string {
  const responsibility = ROLE_RESPONSIBILITIES[role] ?? `Contribute to this mission in your role as ${role}.`;
  const lines = [
    `You are the ${role} on a small AI team working on this software engineering mission. ${responsibility}`,
    "",
    `Mission brief: ${input.brief}`,
    // Found in a real run: the Reviewer flagged this file as unrelated work.
    "(`.mcp.json` in this directory is AgentSpace's own tooling config; it is never committed. Ignore it.)",
  ];
  lines.push(...criteriaLines(role, input));
  if (input.approvedPlan && role !== "Planner") {
    lines.push("", "The user reviewed and APPROVED this plan. Build from it; don't re-plan:", input.approvedPlan);
  }
  if (role === "Planner") {
    // Phase 4 — the drift signal compares this list with the real diff.
    lines.push(
      "",
      input.stopAfterRole === "Planner"
        ? "The user will review your plan BEFORE anyone builds anything. Make it concrete and short: the approach, the files to change, and any assumption you had to make."
        : "Keep the plan concrete and short: the approach and the files to change.",
      "Include one line `FILES: <comma-separated paths>` listing the files you expect to change."
    );
  }
  lines.push(...projectInstructionLines(role, input));
  lines.push("", questionInstruction(input.allowQuestions));
  if (input.adjustment) {
    lines.push(
      "",
      "This is a follow-up ADJUSTMENT: earlier work on this brief is already present in this directory, the user reviewed it, and asked for this correction. Treat it as the primary instruction and check the current state of the files rather than starting over:",
      input.adjustment
    );
  }
  if (input.referenceMaterial) {
    lines.push("", `Reference material: ${JSON.stringify(input.referenceMaterial)}`);
  }
  if (!isFirstRole) {
    lines.push(
      "",
      "Other team members may have already worked in this directory before you — check the current state of the files rather than assuming nothing has changed yet."
    );
  }
  return lines.join("\n");
}

/**
 * .claude/plans/completed/06-project-permission-policy.md — the exact mapping
 * confirmed against the real CLI (2026-08-12, spike documented in that plan)
 * rather than assumed from `--help` text alone:
 *   - read-only: `--tools "Read,Grep,Glob"` genuinely removes Bash/Edit/Write
 *     from the session — the model can't call them at all, not just get
 *     denied when it tries.
 *   - can-edit: `--permission-mode acceptEdits`. Corrected 2026-09-29 (plan 20
 *     spike): this auto-approves edits and *filesystem* shell commands
 *     (`printf > file`), but a general command like `node -e …` still comes
 *     back "This command requires approval" — so it does not let a role run
 *     arbitrary tests/builds.
 *   - can-edit-and-run: `acceptEdits` + an allow-list of test/build runners and a
 *     deny-list for remote-touching commands (spike 2026-09-30: `node -e` ran,
 *     `git push` was denied).
 *   - custom: `--allowedTools`/`--disallowedTools` exactly as configured.
 */
function permissionPolicyArgs(policy: PermissionPolicy): string[] {
  switch (policy.mode) {
    case "read-only":
      return ["--tools", READ_ONLY_TOOLS];
    case "can-edit":
      return ["--permission-mode", "acceptEdits"];
    case "can-edit-and-run":
      return [
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        RUN_ALLOWED_TOOLS.join(" "),
        "--disallowedTools",
        RUN_DISALLOWED_TOOLS.join(" "),
      ];
    case "custom": {
      const args: string[] = [];
      if (policy.allowed_tools?.length) args.push("--allowedTools", policy.allowed_tools.join(" "));
      if (policy.disallowed_tools?.length) args.push("--disallowedTools", policy.disallowed_tools.join(" "));
      return args;
    }
  }
}

const READ_ONLY_TOOLS = "Read,Grep,Glob";
const READ_AND_RUN_TOOLS = "Read,Grep,Glob,Bash";

/**
 * .claude/plans/20-plano-consolidado.md item 1.2 (F2) — the role's ceiling
 * (ROLE_TOOL_CEILING) intersected with the Project's policy. `--tools` sets
 * which tools EXIST in the session (confirmed: Write then fails with "No such
 * tool available"), while the policy's flags still decide what gets approved —
 * so the result can only ever be narrower than the Project's policy:
 *   - a read-only Project stays read-only for every role;
 *   - "read-only" roles (Planner/Reviewer) get Read/Grep/Glob only;
 *   - "read-and-run" (QA) gets Read/Grep/Glob/Bash, with the Project's own
 *     approval flags on top — so Bash runs freely only where the Project's
 *     custom policy already allows it (confirmed 2026-09-29: `--tools
 *     "Read,Grep,Glob,Bash" --allowedTools Bash` runs `node -e` and offers no
 *     Write/Edit), and under can-edit it gets exactly the Developer's Bash
 *     approval, never more;
 *   - "project-policy" (Developer, unknown roles, or no role) is unchanged.
 */
export function permissionArgsForRole(policy: PermissionPolicy, role: string | undefined): string[] {
  const ceiling = roleToolCeiling(role);
  if (policy.mode === "read-only" || ceiling === "read-only") return ["--tools", READ_ONLY_TOOLS];
  if (ceiling === "read-and-run") return ["--tools", READ_AND_RUN_TOOLS, ...permissionPolicyArgs(policy)];
  return permissionPolicyArgs(policy);
}
