import type { Evidence } from "../domain/types.js";
import { getProviderAdapter } from "../provider-adapter/index.js";

const MAX_TOOL_RESULT_CHARS = 400;
const MAX_TEXT_CHARS = 500;
const MAX_TOOL_INPUT_CHARS = 200;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function textFromToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/**
 * Reduces a raw stream-json Evidence stream to the handful of lines that
 * actually matter for a Reasoning Summary — assistant text, tool calls (name
 * + a short description of the input), tool results (truncated), and the
 * final outcome line. Deliberately strips system/thinking-token bookkeeping
 * entirely: that's provider telemetry, not something a grounded plain-language
 * account should ever quote (T-003, docs/16-ASSUMPTIONS.md — no raw
 * chain-of-thought reaching the summary, even indirectly as prompt input).
 */
export function condenseEvidenceForSummary(evidence: Evidence[]): string {
  const lines: string[] = [];
  // .claude/plans/completed/14-real-multi-agent-execution.md — a role
  // header whenever the attributed role changes, so a multi-invocation
  // Execution reads as "the Planner did X; the Developer then did Y," not
  // an undifferentiated stream. `undefined` (single flattened invocation,
  // or events with no single owner like rate_limit_event) never gets a
  // header of its own.
  let currentRole: string | undefined | null = null;

  for (const e of evidence) {
    const payload = e.payload as Record<string, unknown> | undefined;
    if (!payload) continue;

    if (e.team_member_role && e.team_member_role !== currentRole) {
      currentRole = e.team_member_role;
      lines.push(`--- ${currentRole} ---`);
    }

    if (e.type === "stream_json_line") {
      const messageType = payload.type;
      const content = (payload.message as { content?: unknown[] } | undefined)?.content;

      if (messageType === "assistant" && Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            lines.push(`Assistant said: ${truncate(block.text.trim(), MAX_TEXT_CHARS)}`);
          } else if (block.type === "tool_use") {
            const inputSummary = truncate(JSON.stringify(block.input ?? {}), MAX_TOOL_INPUT_CHARS);
            lines.push(`Tool call: ${String(block.name)}(${inputSummary})`);
          }
        }
      } else if (messageType === "user" && Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === "tool_result") {
            const text = textFromToolResultContent(block.content);
            if (text) lines.push(`Tool result: ${truncate(text, MAX_TOOL_RESULT_CHARS)}`);
          }
        }
      } else if (typeof payload.stop_reason === "string") {
        lines.push(`Run ended: stop_reason=${payload.stop_reason}${payload.is_error ? ", is_error=true" : ""}`);
      }
    } else if (e.type === "stderr") {
      lines.push(`Provider stderr: ${truncate(String(payload), 300)}`);
    } else if (e.type === "provider_spawn_error") {
      lines.push(`Provider failed to start: ${truncate(JSON.stringify(payload), 300)}`);
    } else if (e.type === "build_check") {
      // .claude/plans/16-build-verification.md — surface the real build verdict
      // so the summary can state it plainly instead of omitting it.
      lines.push(`Build check: ${String(payload.summary ?? "")}`);
    } else if (e.type === "build_check_skipped") {
      lines.push(`Build check skipped: ${String(payload.message ?? "no build command detected")}`);
    } else if (e.type === "mock_run") {
      // provider-adapter/mockAdapter.ts — dev-mode stand-in, never a real
      // provider run. Surfaced plainly rather than silently dropped, so a
      // summary never implies real work happened when it didn't.
      lines.push(`Note: this ran against the mock provider, not a real AI session. ${String(payload.message ?? "")}`);
    }
  }

  return lines.join("\n");
}

function buildSummaryPrompt(brief: string | undefined, transcript: string): string {
  return [
    "You are writing a Reasoning Summary: a short, plain-language account of what an AI coding agent did during one work session, for a human supervisor who did not watch it happen.",
    "",
    "Hard rules:",
    "- Only describe things explicitly shown in the transcript excerpt below. Never speculate or invent anything not evidenced there.",
    "- If no real file changes happened, say so plainly, and explain why if the transcript shows a reason (e.g. a tool being disabled or blocked).",
    "- If the transcript is divided into '--- RoleName ---' sections, that means separate team members worked in sequence — attribute actions to the specific role that did them (e.g. 'the Planner identified X, then the Developer implemented it').",
    "- Write 3-6 plain sentences. No headers, no bullet lists, no code blocks, no raw tool-call syntax or JSON.",
    "",
    brief ? `Mission brief: ${brief}` : "",
    "",
    "Transcript excerpt:",
    transcript,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * docs/07-SCHEMA_API_CONTRACT.md §4/§7.6 — synthesized on read from Evidence,
 * never stored as its own row. Replaces the earlier placeholder that just
 * concatenated Evidence type names.
 */
export async function synthesizeReasoningSummary(evidence: Evidence[], missionBrief: string | undefined): Promise<string> {
  const transcript = condenseEvidenceForSummary(evidence);
  if (!transcript.trim()) {
    return "This Execution produced no meaningful activity to summarize.";
  }

  const prompt = buildSummaryPrompt(missionBrief, transcript);
  try {
    const summary = await getProviderAdapter().synthesize(prompt);
    return summary.trim() || "The provider returned an empty summary.";
  } catch (err) {
    console.error("Failed to synthesize Reasoning Summary:", err);
    return "Couldn't generate a summary right now — see the raw Evidence below for the full record.";
  }
}
