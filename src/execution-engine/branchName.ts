import { getActiveProviderName, getProviderAdapter } from "../provider-adapter/index.js";
import { slugify } from "../util/slug.js";

/**
 * .claude/plans/20-plano-consolidado.md item 1.7 — a readable branch slug that
 * says what the Mission DOES (`change-secondary-color-to-green`), instead of
 * the first 40 characters of the brief's sentence
 * (`this-app-has-his-second-color-mainly-blu`). One short `synthesize()` call
 * (no tools, like the Reasoning Summary); the old `slugify(brief)` stays as the
 * fallback whenever the call fails, is slow, or returns something unusable —
 * branch naming must never block or break a Mission starting.
 */
const NAME_TIMEOUT_MS = Number(process.env.AGENTSPACE_BRANCH_NAME_TIMEOUT_MS ?? 20000);
const MIN_WORDS = 2;
const MAX_WORDS = 6;
const MAX_SLUG_LEN = 50;

function buildNamePrompt(brief: string): string {
  return [
    "Name a git branch for the software change described below.",
    `Reply with ONLY an imperative phrase of 3 to 6 lowercase English words separated by hyphens, e.g. change-secondary-color-to-green or extract-money-formatter-helper.`,
    "No prefix, no quotes, no punctuation, no explanation — just the phrase on one line.",
    "",
    `Change: ${brief}`,
  ].join("\n");
}

/**
 * Turns the model's reply into a slug, or undefined when it doesn't look like
 * the requested phrase (so the caller falls back rather than using a sentence
 * of chatter as a branch name). Exported for direct testing.
 */
export function parseBranchNameReply(reply: string): string | undefined {
  const line = reply
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  const slug = slugify(line.replace(/^[`'"]+|[`'"]+$/g, ""), MAX_SLUG_LEN);
  const words = slug.split("-").filter(Boolean);
  if (slug === "mission" || words.length < MIN_WORDS || words.length > MAX_WORDS) return undefined;
  return slug;
}

export async function synthesizeBranchSlug(brief: string): Promise<string> {
  const fallback = slugify(brief);
  // The mock's synthesize() echoes a canned "Mock summary…" line — never a name.
  if (getActiveProviderName() === "mock") return fallback;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAME_TIMEOUT_MS);
  try {
    const reply = await getProviderAdapter().synthesize(buildNamePrompt(brief), { signal: controller.signal });
    return parseBranchNameReply(reply) ?? fallback;
  } catch (err) {
    console.warn(`Branch name synthesis failed, using the brief's slug instead: ${err instanceof Error ? err.message : err}`);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
