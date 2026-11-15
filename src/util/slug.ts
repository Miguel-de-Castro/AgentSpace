/**
 * .claude/plans/completed/13-real-merge-on-approval.md — turns a Mission
 * brief into a short, readable slug for branch names (`agentspace/<slug>-<suffix>`,
 * built in execution-engine/git.ts). Never empty: falls back to "mission" so a
 * pathological brief (all punctuation, empty string) still produces a valid
 * git branch name.
 */
export function slugify(text: string, maxLen = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return slug || "mission";
}
