import { useEffect, useState } from "react";
import { getUsageStatus } from "@/lib/api";
import type { RateLimitState } from "@/lib/types";

/**
 * .claude/plans/04-usage-rate-limit.md — a calm, read-once status pill, never
 * a live gauge or percentage (docs/06-DESIGN_GUARDRAILS.md #2). Fetched once
 * on mount; the caller is free to re-mount it (e.g. on navigation) to refresh,
 * but this component itself never polls.
 */
export function UsageIndicator() {
  const [state, setState] = useState<RateLimitState | null | undefined>(undefined);

  useEffect(() => {
    getUsageStatus()
      .then(setState)
      .catch(() => setState(null));
  }, []);

  if (!state) return null;

  const reachedLimit = state.status !== "allowed";
  const resetsAt = state.resets_at ? new Date(state.resets_at * 1000) : null;

  const label = reachedLimit
    ? `Usage limit reached${resetsAt ? ` · resets ${resetsAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`
    : "Usage normal";

  return (
    <span
      className={`text-xs px-2.5 py-1 rounded-full border ${
        reachedLimit ? "border-destructive/40 text-destructive" : "border-outline text-muted-foreground"
      }`}
    >
      {label}
    </span>
  );
}
