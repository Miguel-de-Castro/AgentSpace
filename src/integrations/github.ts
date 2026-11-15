// .claude/plans/completed/05-checks-approval-gate.md — read-only external context for
// the Approval Gate. Deliberately NOT a domain concept
// (docs/02-DOMAIN.md/docs/19-ARCHITECTURAL_TESTS.md already closed the
// model): nothing here is persisted as Evidence, Artifact, Review, or
// Decision. Called on demand when a human opens the Approval Gate for a
// Mission whose branch has an associated PR — never polled
// (docs/06-DESIGN_GUARDRAILS.md #2).

const GITHUB_API = "https://api.github.com";

export interface ChecksResult {
  branch: {
    name: string;
    base: string;
    ahead_by: number;
    behind_by: number;
  } | null;
  pull_request: {
    number: number;
    state: "open" | "closed";
    draft: boolean;
    html_url: string;
  } | null;
  ci: {
    state: "success" | "failure" | "pending" | "none";
    total: number;
    passed: number;
  } | null;
  /**
   * Best-effort, not exact: the REST API has no direct "unresolved review
   * thread" count (that's GraphQL-only). Approximated here as the number of
   * reviewers whose most recent review is CHANGES_REQUESTED — close enough
   * to answer "is there something outstanding," not a precise thread count.
   * Documented rather than silently presented as exact
   * (.claude/plans/completed/05-checks-approval-gate.md).
   */
  reviewers_requesting_changes: number | null;
  /** Set when a GitHub call itself failed (bad/missing token, rate limit, network) — surfaced, never silently swallowed into a misleadingly-clean result. */
  error?: string;
}

/** Parses `owner/repo` out of a GitHub remote URL, SSH or HTTPS form. */
export function parseGithubRemote(remoteUrl: string): { owner: string; repo: string } | undefined {
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+?)(\.git)?$/);
  if (!match) return undefined;
  return { owner: match[1], repo: match[2] };
}

async function githubFetch(token: string, path: string): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const json = await res.json().catch(() => undefined);
  return { ok: res.ok, status: res.status, json };
}

export async function fetchChecks(token: string, owner: string, repo: string, base: string, branch: string): Promise<ChecksResult> {
  const empty: ChecksResult = { branch: null, pull_request: null, ci: null, reviewers_requesting_changes: null };

  const compare = await githubFetch(token, `/repos/${owner}/${repo}/compare/${base}...${branch}`);
  if (!compare.ok) {
    return { ...empty, error: `GitHub compare failed (${compare.status})` };
  }
  const compareJson = compare.json as { ahead_by: number; behind_by: number };
  const result: ChecksResult = {
    ...empty,
    branch: { name: branch, base, ahead_by: compareJson.ahead_by, behind_by: compareJson.behind_by },
  };

  const prs = await githubFetch(token, `/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=all&per_page=1`);
  if (!prs.ok || !Array.isArray(prs.json) || prs.json.length === 0) {
    return result; // no PR yet — branch state is still meaningful on its own
  }
  const pr = prs.json[0] as { number: number; state: "open" | "closed"; draft: boolean; html_url: string; head: { sha: string } };
  result.pull_request = { number: pr.number, state: pr.state, draft: pr.draft, html_url: pr.html_url };

  const checkRuns = await githubFetch(token, `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`);
  if (checkRuns.ok) {
    const runs = (checkRuns.json as { check_runs: { status: string; conclusion: string | null }[] }).check_runs;
    if (runs.length === 0) {
      result.ci = { state: "none", total: 0, passed: 0 };
    } else {
      const passed = runs.filter((r) => r.conclusion === "success").length;
      const anyFailed = runs.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out");
      const anyPending = runs.some((r) => r.status !== "completed");
      result.ci = {
        state: anyFailed ? "failure" : anyPending ? "pending" : "success",
        total: runs.length,
        passed,
      };
    }
  }

  const reviews = await githubFetch(token, `/repos/${owner}/${repo}/pulls/${pr.number}/reviews?per_page=100`);
  if (reviews.ok && Array.isArray(reviews.json)) {
    const latestByReviewer = new Map<string, string>();
    for (const review of reviews.json as { user: { login: string }; state: string; submitted_at: string }[]) {
      const existing = latestByReviewer.get(review.user.login);
      if (!existing || review.submitted_at > existing) latestByReviewer.set(review.user.login, review.state);
    }
    result.reviewers_requesting_changes = [...latestByReviewer.values()].filter((s) => s === "CHANGES_REQUESTED").length;
  }

  return result;
}
