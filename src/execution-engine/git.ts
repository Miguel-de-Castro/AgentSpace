import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getDataDir } from "../db/client.js";
import { newId } from "../util/id.js";
import { slugify } from "../util/slug.js";
import type { PushResult } from "../domain/types.js";

/**
 * Worktree ownership belongs here, via plain `git worktree` — never Claude
 * Code's native `--worktree` flag (docs/02-DOMAIN.md Architecture Discovery
 * Findings; docs/03-ARCHITECTURE.md §4). Execution Engine creates and tears
 * down worktrees independently of whatever Provider Adapter is running
 * inside them.
 */

const WORKTREE_ROOT = process.env.AGENTSPACE_WORKTREE_DIR ?? join(process.cwd(), "worktrees");

// .claude/plans/19-clone-git-repository.md — where AgentSpace-managed clones
// live: alongside the DB (honoring AGENTSPACE_DATA_DIR), never under
// WORKTREE_ROOT (which is ephemeral and reconciled away at boot). A cloned
// Project's repo_path always sits under here, which removeClonedRepo relies on
// as a hard guard against ever deleting a directory outside it.
function reposRoot(): string {
  return process.env.AGENTSPACE_REPOS_DIR ?? join(getDataDir(), "repos");
}

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf-8" }).trim();
}

/**
 * .claude/plans/19-clone-git-repository.md P0 — clone a remote repo into a
 * managed directory under reposRoot(), which then becomes the Project's
 * repo_path. Uses whatever git credentials are already on the machine (same
 * posture as the push in plan 13 — AgentSpace manages none itself), so a public
 * URL just works and a private one relies on the user's credential helper.
 * Network + write git, so it lives here in Execution Engine (AT #7), never in
 * Mission Engine; the onboarding route orchestrates clone-then-onboard.
 */
/** A URL starting with "-" would be parsed by git as an option (e.g. --upload-pack=...). */
function assertCloneUrl(url: string): void {
  if (url.startsWith("-")) throw new Error("Invalid repository URL.");
}

export function cloneRepository(url: string, name?: string): string {
  const root = reposRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const slug = slugify(name?.trim() || url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() || "repo");
  const dest = join(root, `${slug}-${newId().slice(-6).toLowerCase()}`);
  // Let a clone failure (bad URL, auth, network) propagate — the route turns it
  // into a clear error and no Project row is created.
  assertCloneUrl(url);
  execFileSync("git", ["clone", "--", url, dest], { encoding: "utf-8" });
  return dest;
}

/**
 * .claude/plans/20-plano-consolidado.md Phase 7.9 — a URL-only Project keeps no
 * working copy: one bare clone (objects + refs, no checked-out files) under
 * reposRoot(), and every Mission gets its own worktree from it. Same credential
 * posture as cloneRepository. The folder name ends in `.git`, the convention for
 * bare repos.
 */
export function cloneBareRepository(url: string, name?: string): string {
  const root = reposRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const slug = slugify(name?.trim() || url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() || "repo");
  const dest = join(root, `${slug}-${newId().slice(-6).toLowerCase()}.git`);
  assertCloneUrl(url);
  execFileSync("git", ["clone", "--bare", "--", url, dest], { encoding: "utf-8" });
  // A bare clone maps origin's branches straight onto refs/heads and has no
  // remote-tracking refs, so a plain `git fetch` would never move anything.
  // Track them explicitly; refreshBareCache then advances the base by hand
  // and never touches the agentspace/* branches.
  git(dest, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  git(dest, ["fetch", "origin"]);
  return dest;
}

/**
 * Brings a bare cache's `baseBranch` up to origin's tip and removes the local
 * agentspace/* branches whose work has already landed in it. Safe by
 * construction: `git branch -d` refuses an unmerged branch or one checked out in
 * a live worktree, so a Mission still in review is never touched. Best-effort
 * on the network: an offline fetch keeps the last known base instead of
 * blocking the Mission.
 */
export function refreshBareCache(repoPath: string, baseBranch: string): { fetched: boolean; pruned: string[] } {
  let fetched = true;
  try {
    git(repoPath, ["fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
    git(repoPath, ["update-ref", `refs/heads/${baseBranch}`, `refs/remotes/origin/${baseBranch}`]);
  } catch {
    fetched = false;
  }
  const pruned: string[] = [];
  try {
    const merged = git(repoPath, ["for-each-ref", "--merged", `refs/heads/${baseBranch}`, "--format=%(refname:short)", "refs/heads/agentspace/"])
      .split("\n")
      .filter(Boolean);
    for (const branch of merged) {
      try {
        git(repoPath, ["branch", "-d", branch]);
        pruned.push(branch);
      } catch {
        // checked out in a live worktree: leave it
      }
    }
    // .claude/plans/24-ideias-para-analisar.md item 4 — a squash/rebase merge
    // leaves no ancestor link, so --merged misses it. `git cherry` compares by
    // patch-id: when every commit on the branch is already in the base (all
    // lines start with `-`), the work has landed. Needs `-D` because `-d` only
    // understands ancestry. Safe by construction: only agentspace/* branches in
    // this disposable cache, never one checked out in a live worktree (git
    // refuses), and a squash that mixed in other changes changes the patch-id
    // and simply doesn't match, so the branch stays.
    const remaining = git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads/agentspace/"])
      .split("\n")
      .filter(Boolean);
    for (const branch of remaining) {
      if (!branchPatchesAllInBase(repoPath, baseBranch, branch)) continue;
      try {
        git(repoPath, ["branch", "-D", branch]);
        pruned.push(branch);
      } catch {
        // checked out in a live worktree: leave it
      }
    }
  } catch {
    // no base ref yet: nothing to prune
  }
  return { fetched, pruned };
}

/**
 * True when everything `branch` adds is already in `baseBranch`. Two checks:
 * `git cherry` (per-commit patch-id: rebase/cherry-pick merges) and a trial
 * `git merge-tree --write-tree` (a squash of several commits has a patch-id no
 * single commit matches, but merging the branch into the base then yields the
 * base's own tree, i.e. a no-op). A conflict or any error means "not landed".
 */
export function branchPatchesAllInBase(repoPath: string, baseBranch: string, branch: string): boolean {
  try {
    const lines = git(repoPath, ["cherry", baseBranch, branch]).split("\n").filter(Boolean);
    if (lines.length > 0 && lines.every((l) => l.startsWith("-"))) return true;
  } catch {
    // fall through to the tree check
  }
  try {
    const mergedTree = git(repoPath, ["merge-tree", "--write-tree", baseBranch, branch]).split("\n")[0];
    return mergedTree === git(repoPath, ["rev-parse", `${baseBranch}^{tree}`]);
  } catch {
    return false;
  }
}

/**
 * .claude/plans/19-clone-git-repository.md P0 — delete a cloned repo's directory
 * when its Project is removed. Hard-guarded: refuses to delete anything that
 * isn't inside reposRoot(), so a mis-set repo_path can never turn this into
 * "rm -rf an arbitrary path." Best-effort on Windows, where git's read-only
 * pack files can make removal flaky (retries handle the transient case).
 */
export function removeClonedRepo(repoPath: string): boolean {
  const root = resolve(reposRoot());
  const target = resolve(repoPath);
  // Never the managed root itself, only a folder inside it.
  if (target === root || !target.startsWith(root + sep)) {
    console.warn(`Refusing to delete '${target}': not inside the managed repos directory '${root}'.`);
    return false;
  }
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  } catch (err) {
    console.error(`Failed to remove cloned repo at ${target}:`, err);
    return false;
  }
}

/** Whether `ref` resolves to a commit in this repo (a pruned/merged branch doesn't). */
export function refExists(repoPath: string, ref: string): boolean {
  try {
    git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function currentHeadSha(repoPath: string, ref = "HEAD"): string {
  return git(repoPath, ["rev-parse", ref]);
}

/** .claude/plans/05-checks-approval-gate.md — used to resolve owner/repo for the GitHub API. */
export function getRemoteUrl(repoPath: string, remote = "origin"): string | undefined {
  try {
    return git(repoPath, ["remote", "get-url", remote]);
  } catch {
    return undefined;
  }
}

/**
 * .claude/plans/completed/13-real-merge-on-approval.md — readable branch
 * name (what the Mission was about), not just the Execution's raw ID. The
 * suffix (last 6 chars of the Execution's ULID) keeps retries/iterates of
 * the same Mission from colliding on an identical slug.
 *
 * `slug` is already computed by the caller (plan 20 item 1.7: a synthesized
 * imperative name, falling back to slugify(brief) — see branchName.ts).
 */
export function buildExecutionBranchName(slug: string, executionId: string): string {
  const suffix = executionId.slice(-6).toLowerCase();
  return `agentspace/${slug}-${suffix}`;
}

export function createWorktree(repoPath: string, executionId: string, branchName: string, baseSha: string): string {
  if (!existsSync(WORKTREE_ROOT)) mkdirSync(WORKTREE_ROOT, { recursive: true });
  const worktreePath = join(WORKTREE_ROOT, executionId);
  git(repoPath, ["worktree", "add", "-b", branchName, worktreePath, baseSha]);
  writePlaywrightMcpConfig(worktreePath);
  return worktreePath;
}

/**
 * .claude/plans/18-mock-provider-safety-and-prod-start.md P1 (rejection flow) —
 * an "adjustment" (iterate) Execution continues the SAME branch the earlier
 * Execution built, rather than branching fresh off the Project's base. This
 * checks out that existing branch (at its current tip) into a new worktree, so
 * the follow-up run starts from the prior work instead of from scratch — the
 * difference between "I rejected and it died" and "I rejected with direction."
 * No `-b`: the branch already exists.
 */
export function createWorktreeFromBranch(repoPath: string, executionId: string, branchName: string): string {
  if (!existsSync(WORKTREE_ROOT)) mkdirSync(WORKTREE_ROOT, { recursive: true });
  const worktreePath = join(WORKTREE_ROOT, executionId);
  git(repoPath, ["worktree", "add", worktreePath, branchName]);
  writePlaywrightMcpConfig(worktreePath);
  return worktreePath;
}

/**
 * .claude/plans/20-plano-consolidado.md Phase 7.4 (21-H) — when Allow found the
 * branch no longer rebases onto the base, the fix Execution first moves the
 * branch onto the current base itself. A merge wouldn't do: Allow rebases, and
 * a plain rebase drops merge commits, so the resolution would be lost. Instead
 * the Mission's commits are squashed into one (the branch is AgentSpace's own;
 * the push is --force-with-lease anyway) and that single commit is rebased
 * onto the base: a clean rebase just finishes, a conflicted one stops with the
 * standard conflict markers in the files. The Developer then only EDITS files
 * (no git commands, which a can-edit Project can't run); finalizeExecution
 * stages the result and runs `rebase --continue`. Returns the conflicted paths
 * and the base tip the branch now sits on.
 */
export function squashAndRebaseOntoBase(
  worktreePath: string,
  baseBranch: string,
  message: string
): { conflicts: string[]; baseSha: string } {
  const baseSha = git(worktreePath, ["rev-parse", baseBranch]);
  const forkPoint = git(worktreePath, ["merge-base", "HEAD", baseBranch]);
  if (git(worktreePath, ["rev-parse", "HEAD"]) !== forkPoint) {
    git(worktreePath, ["reset", "--soft", forkPoint]);
    git(worktreePath, ["commit", "--no-verify", "-m", message]);
  }
  try {
    git(worktreePath, ["rebase", baseBranch]);
    return { conflicts: [], baseSha };
  } catch {
    const out = git(worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
    return { conflicts: out ? out.split("\n").filter(Boolean) : [], baseSha };
  }
}

/** Whether a rebase stopped in this worktree is waiting to be continued. */
export function isRebaseInProgress(worktreePath: string): boolean {
  return ["rebase-merge", "rebase-apply"].some((p) => existsSync(resolve(worktreePath, git(worktreePath, ["rev-parse", "--git-path", p]))));
}

/** The commit a branch forked from `base` (for diffs that ignore base's own later changes). */
export function mergeBaseSha(repoPath: string, base: string, tip: string): string | undefined {
  try {
    return git(repoPath, ["merge-base", base, tip]);
  } catch {
    return undefined;
  }
}

/**
 * .claude/plans/18-mock-provider-safety-and-prod-start.md P1 item 11 — delete a
 * Mission's local branch when the user rejects its result and asks to discard
 * it, so a rejected attempt doesn't leave an orphan branch behind (this exact
 * accumulation is what the plan's originating incident produced). Scope is
 * deliberately narrow: the local branch only — never `origin`, never the base
 * branch. Returns false (without throwing) if the branch is already gone.
 */
export function deleteLocalBranch(repoPath: string, branchName: string): boolean {
  try {
    git(repoPath, ["branch", "-D", branchName]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every Execution's worktree gets the Playwright MCP server wired up,
 * unconditionally (.claude/plans/completed/01-playwright-mcp.md) — this is how
 * AgentSpace answers the "embedded browser / Design Mode" need (Orca) without
 * building a browser into the app itself: Claude Code gets the ability to
 * run the app, navigate, and screenshot what it built, via the MCP server
 * that already exists and is maintained upstream.
 *
 * Written per-worktree, not into the Project's own repo, deliberately — an
 * Execution's `.mcp.json` never becomes part of the user's commit history
 * without their consent, and each Execution stays self-contained. Claude
 * Code auto-detects `.mcp.json` in its cwd (claudeCodeAdapter.ts sets
 * `cwd: worktreePath`), so no extra CLI flag is needed at invocation time.
 */
function writePlaywrightMcpConfig(worktreePath: string): void {
  const config = {
    mcpServers: {
      playwright: {
        command: "npx",
        // Pinned: an unpinned @latest would run whatever was last published, in every worktree.
        args: ["-y", "@playwright/mcp@0.0.85"],
      },
    },
  };
  writeFileSync(join(worktreePath, ".mcp.json"), JSON.stringify(config, null, 2) + "\n");
}

/**
 * Lists AgentSpace-managed worktree paths for a repo — i.e. everything
 * `git worktree list` reports except the repo's own primary working
 * directory (always the first entry). Used by
 * execution-engine/index.ts's reconcileOrphanedWorktrees() at boot to find
 * worktrees left behind by a process that died mid-Execution.
 */
export function listWorktrees(repoPath: string): string[] {
  const output = git(repoPath, ["worktree", "list", "--porcelain"]);
  const paths = output
    .split("\n\n")
    .map((block) => block.match(/^worktree (.+)$/m)?.[1])
    .filter((p): p is string => Boolean(p));
  // Drop the primary worktree (the Project's own repoPath) — only the ones
  // AgentSpace created under WORKTREE_ROOT are candidates for reconciliation.
  return paths.filter((p) => p !== repoPath && join(p, "") !== join(repoPath, ""));
}

/**
 * .claude/plans/16-build-verification.md — a short-lived detached worktree at
 * an arbitrary SHA, used to run the build check against the pre-Mission
 * baseline (git_before_sha) without disturbing the user's actual working
 * directory. Same temp-worktree pattern as rebaseAndPushExecutionBranch;
 * `--detach` avoids creating a throwaway branch. Caller must removeWorktree it.
 */
export function createTempWorktreeAtSha(repoPath: string, sha: string): string {
  if (!existsSync(WORKTREE_ROOT)) mkdirSync(WORKTREE_ROOT, { recursive: true });
  const tempPath = join(WORKTREE_ROOT, `buildbase-${newId()}`);
  git(repoPath, ["worktree", "add", "--detach", tempPath, sha]);
  return tempPath;
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
  try {
    git(repoPath, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    // Best-effort: if the worktree was already removed or the path is gone,
    // there's nothing left to clean up. Not re-thrown — teardown must never
    // block an Execution from being recorded as ended.
  }
}

/**
 * Diffing is always git-computed before/after snapshots (AT #4, T-002) —
 * never a provider's own checkpoint mechanism. Returns per-file diff
 * summaries, which Execution Engine turns into Artifacts.
 */
export function diffSummary(worktreePath: string, beforeSha: string, afterSha: string): { path: string; status: string }[] {
  const output = git(worktreePath, ["diff", "--name-status", beforeSha, afterSha]);
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...pathParts] = line.split("\t");
      return { path: pathParts.join("\t"), status };
    });
}

/**
 * .claude/plans/20-plano-consolidado.md item 1.5 — per-file line counts for the
 * Approval Gate's "N files · +X −Y" rollup. `--no-renames` so every entry is a
 * plain path (a rename shows as one deletion + one addition). Binary files
 * report `-` for both counts; they're kept, with null counts.
 */
export function diffNumstat(
  repoPath: string,
  beforeSha: string,
  afterSha: string
): { path: string; added: number | null; removed: number | null }[] {
  const output = git(repoPath, ["diff", "--numstat", "--no-renames", beforeSha, afterSha]);
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...pathParts] = line.split("\t");
      return {
        path: pathParts.join("\t"),
        added: added === "-" ? null : Number(added),
        removed: removed === "-" ? null : Number(removed),
      };
    });
}

export function diffContent(worktreePath: string, beforeSha: string, afterSha: string, path: string): string {
  return git(worktreePath, ["diff", beforeSha, afterSha, "--", path]);
}

/**
 * .claude/plans/completed/13-real-merge-on-approval.md — what a Binding
 * Decision's `approved` outcome actually does mechanically: rebase the
 * Execution's branch onto the current tip of the protected/base branch
 * (catches up with anything that landed since the Execution started),
 * detect conflict, and push the result to `origin` using whatever git
 * credentials are already configured on this machine — AgentSpace never
 * stores or manages a credential for this itself, unlike the GitHub PAT
 * used for Checks (a separate, read-only REST API concern).
 *
 * Deliberately never merges into the base branch and never opens a PR —
 * the user does that manually afterward (scope decided with the user
 * 2026-08-12, replacing an earlier draft of this plan that assumed a real
 * merge).
 *
 * Operates via a short-lived temporary worktree (the Execution's own
 * worktree is already torn down by the time a Decision is recorded) so a
 * failed rebase never touches the user's actual working directory.
 */
export function rebaseAndPushExecutionBranch(repoPath: string, branchName: string, baseBranch: string): PushResult {
  if (!getRemoteUrl(repoPath)) {
    return { pushed: false, reason: "no-remote", branch_name: branchName };
  }

  if (!existsSync(WORKTREE_ROOT)) mkdirSync(WORKTREE_ROOT, { recursive: true });
  const tempPath = join(WORKTREE_ROOT, `rebase-${newId()}`);
  git(repoPath, ["worktree", "add", tempPath, branchName]);

  try {
    try {
      execFileSync("git", ["rebase", baseBranch], { cwd: tempPath, encoding: "utf-8" });
    } catch (err) {
      try {
        execFileSync("git", ["rebase", "--abort"], { cwd: tempPath });
      } catch {
        // best-effort — if abort itself fails there's nothing more to do
        // here; the worktree removal below still cleans up the checkout.
      }
      return {
        pushed: false,
        reason: "conflict",
        branch_name: branchName,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    try {
      // --force-with-lease, not a plain push: the rebase above rewrites
      // this branch's commits, and this is a branch AgentSpace alone owns.
      execFileSync("git", ["push", "--force-with-lease", "origin", `HEAD:${branchName}`], {
        cwd: tempPath,
        encoding: "utf-8",
      });
    } catch (err) {
      return {
        pushed: false,
        reason: "push-failed",
        branch_name: branchName,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    return { pushed: true, branch_name: branchName };
  } finally {
    removeWorktree(repoPath, tempPath);
  }
}
