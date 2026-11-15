import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * .claude/plans/16-build-verification.md — run the project's build/test command
 * against both the pre-Mission state (git_before_sha baseline) and the Mission's
 * result, so "completed" can actually distinguish "nothing broke" from "already
 * broken" from "this Mission broke it." Repository/process mechanics, so it
 * lives in Execution Engine alongside git.ts (AT #7), never Mission Engine.
 *
 * v1 scope (deliberately narrow, per the plan): Node/npm only — detected from
 * package.json's scripts.build (fallback scripts.test). No automatic
 * `npm install`; no other ecosystems.
 */

// Always run through a shell: on Windows npm is a `.cmd` shim, and since the
// CVE-2024-27980 mitigation Node refuses to spawn `.cmd`/`.bat` directly
// (throws EINVAL) unless `shell: true` — the command then resolves `npm`
// itself. Our args are fixed and contain no shell metacharacters, so shell
// interpolation is not a concern here.
const NPM = "npm";

// A hard cap so a runaway/watch-mode build can never hang an Execution's
// teardown forever. Tunable, not an architectural commitment.
const BUILD_TIMEOUT_MS = Number(process.env.AGENTSPACE_BUILD_TIMEOUT_MS ?? 300_000);
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface BuildCheckResult {
  passed: boolean;
  output: string;
  durationMs: number;
}

export type BuildVerdictState = "passed" | "already-broken" | "fixed" | "regression";

export interface BuildVerdict {
  state: BuildVerdictState;
  title: string;
  summary: string;
}

/**
 * The build/test command, or null when there's nothing to run (not an error —
 * a project with no detectable npm build simply skips verification rather than
 * pretending to have checked something).
 */
export function detectBuildCommand(worktreePath: string): string[] | null {
  const pkgPath = join(worktreePath, "package.json");
  if (!existsSync(pkgPath)) return null;

  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return null;
  }

  const scripts = pkg.scripts ?? {};
  if (typeof scripts.build === "string") return [NPM, "run", "build"];
  if (typeof scripts.test === "string") return [NPM, "run", "test"];
  return null;
}

/**
 * Runs the command in the worktree, capturing combined output, pass/fail, and
 * wall-clock duration. Never throws — a failing build is a normal, expected
 * result here, not an exception.
 */
export function runBuildCheck(worktreePath: string, command: string[]): BuildCheckResult {
  const start = Date.now();
  try {
    const output = execFileSync(command[0], command.slice(1), {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    return { passed: true, output, durationMs: Date.now() - start };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n") || e.message || String(err);
    return { passed: false, output, durationMs: Date.now() - start };
  }
}

/**
 * Runs a build check in a worktree, transparently letting it see the Project's
 * already-installed node_modules.
 *
 * Why this exists (a real gap the plan didn't call out): a git worktree never
 * contains node_modules — it's gitignored, so it lives only in the primary
 * repo. Without this, EVERY Node project's build would fail on missing
 * dependencies in both the baseline and result worktrees, making the whole
 * check useless and alarming. This is NOT `npm install` (which the plan
 * forbids): nothing is installed, no lockfile is touched — we just point the
 * worktree at the deps that already exist, read-only, via a directory junction
 * (Windows) / symlink (POSIX).
 *
 * Safety: the link is removed here, in `finally`, the instant the build ends —
 * always before any `git worktree remove` runs — and only ever the LINK is
 * removed, never recursing into the real node_modules it points at. If the
 * worktree already has its own node_modules (e.g. the agent ran an install),
 * we leave it entirely alone.
 */
export function runBuildCheckWithDeps(repoPath: string, worktreePath: string, command: string[]): BuildCheckResult {
  const linked = linkNodeModulesIfMissing(repoPath, worktreePath);
  try {
    return runBuildCheck(worktreePath, command);
  } finally {
    if (linked) unlinkNodeModulesLink(worktreePath);
  }
}

function linkNodeModulesIfMissing(repoPath: string, worktreePath: string): boolean {
  const src = join(repoPath, "node_modules");
  const dest = join(worktreePath, "node_modules");
  if (!existsSync(src) || existsSync(dest)) return false;
  try {
    // "junction" is a directory-only reparse point that needs no admin rights
    // on Windows; the type arg is ignored on POSIX (a normal symlink is made).
    symlinkSync(src, dest, "junction");
    return true;
  } catch (err) {
    console.error("build check: could not link node_modules (build may fail on missing deps):", err);
    return false;
  }
}

function unlinkNodeModulesLink(worktreePath: string): void {
  const dest = join(worktreePath, "node_modules");
  try {
    // recursive:false is deliberate — a junction/symlink is removed as a single
    // link; this must never recurse into the real node_modules it targets.
    rmSync(dest, { recursive: false, force: true });
  } catch (err) {
    console.error("build check: could not remove node_modules link:", err);
  }
}

/**
 * Classifies the two runs into a single plain-language verdict. Kept pure and
 * exported so the classification is unit-testable without spawning builds.
 * Titles double as the UI's visual-state key (MissionDetail's ArtifactCard).
 */
export function buildVerdict(baseline: BuildCheckResult, result: BuildCheckResult): BuildVerdict {
  const timing = `Baseline ${fmt(baseline.durationMs)} (${baseline.passed ? "passed" : "failed"}), result ${fmt(
    result.durationMs
  )} (${result.passed ? "passed" : "failed"}).`;

  if (baseline.passed && result.passed) {
    return { state: "passed", title: "Build check: passed", summary: `Build passed before and after — no build regression. ${timing}` };
  }
  if (!baseline.passed && !result.passed) {
    return {
      state: "already-broken",
      title: "Build check: already failing on base",
      summary: `The build was already failing on the base branch before this Mission — not caused by these changes. ${timing}`,
    };
  }
  if (!baseline.passed && result.passed) {
    return {
      state: "fixed",
      title: "Build check: fixed by this Mission",
      summary: `The build was failing on the base branch and now passes — this Mission fixed it. ${timing}`,
    };
  }
  return {
    state: "regression",
    title: "Build check: possible regression",
    summary: `The build passed before but fails now — likely caused by this Mission's changes. ${timing}`,
  };
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * The full, human-readable record stored in the Artifact's content_ref — both
 * runs' commands and output, so the developer can read exactly what happened
 * without re-running anything (the worktrees are gone by then).
 */
export function buildReportContent(
  command: string[],
  baseline: BuildCheckResult,
  result: BuildCheckResult
): string {
  const cmd = command.join(" ");
  return [
    `Command: ${cmd}`,
    "",
    `=== Baseline (pre-Mission state) — ${baseline.passed ? "PASSED" : "FAILED"} in ${fmt(baseline.durationMs)} ===`,
    baseline.output.trim() || "(no output)",
    "",
    `=== Result (this Mission's changes) — ${result.passed ? "PASSED" : "FAILED"} in ${fmt(result.durationMs)} ===`,
    result.output.trim() || "(no output)",
  ].join("\n");
}
