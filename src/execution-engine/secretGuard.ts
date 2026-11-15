import { execFileSync } from "node:child_process";
import { posix } from "node:path";

/**
 * .claude/plans/20-plano-consolidado.md item 1.1 (F1) — finalizeExecution used
 * to `git add -A` everything the Team left in the worktree (only .mcp.json was
 * excluded), so a `.env` or private key a Team Member created or edited would
 * be committed onto the Mission's branch — and pushed to origin on Allow.
 * Files matching these patterns are now kept out of the commit, recorded as
 * `secret_guard` Evidence, and flagged in red at the Approval Gate.
 *
 * Matched on the file's basename, at any depth. `.env.example`-style
 * templates are deliberately NOT treated as secrets: they're meant to be
 * committed, and blocking them would make an ordinary "document the new env
 * var" Mission look alarming.
 */
const SECRET_BASENAME_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production …
  /^\.envrc$/i,
  /\.key$/i,
  /\.pem$/i,
  /^id_rsa/i,
  /^secrets\.json$/i,
  /\.p12$/i,
];

const ENV_TEMPLATE_PATTERN = /^\.env\.(example|sample|template|dist|defaults)$/i;

export function isSecretPath(path: string): boolean {
  const base = posix.basename(path.replace(/\\/g, "/"));
  if (ENV_TEMPLATE_PATTERN.test(base)) return false;
  return SECRET_BASENAME_PATTERNS.some((p) => p.test(base));
}

function nulSeparated(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/**
 * Every path the Execution touched that `git add -A` would stage: modified or
 * deleted tracked files, plus untracked files not covered by .gitignore
 * (anything gitignored was never going to be committed anyway).
 */
function changedPaths(worktreePath: string): string[] {
  const opts = { cwd: worktreePath, encoding: "utf-8" as const };
  const tracked = nulSeparated(execFileSync("git", ["diff", "--name-only", "-z", "HEAD"], opts));
  const untracked = nulSeparated(execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], opts));
  return [...new Set([...tracked, ...untracked])];
}

/** Secret-looking paths among this worktree's pending changes. */
export function findSecretPaths(worktreePath: string): string[] {
  return changedPaths(worktreePath).filter(isSecretPath).sort();
}

/** `git add` pathspecs that exclude each given path exactly (no glob surprises). */
export function excludePathspecs(paths: string[]): string[] {
  return paths.map((p) => `:(exclude,literal)${p}`);
}
