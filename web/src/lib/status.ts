import type { MissionStatus } from "./types";

// docs/06-DESIGN_GUARDRAILS.md #2, #4: no percentages/progress bars, and
// completed/rejected/failed must be distinguishable by color alone. Everything
// still "in motion" (queued/running/awaiting-approval) reads as calm/neutral —
// never anxious — per guardrail #2's "never a percentage inviting a
// refresh-and-watch habit."
export const STATUS_BADGE_CLASS: Record<MissionStatus, string> = {
  proposed: "bg-secondary text-secondary-foreground",
  queued: "bg-secondary text-secondary-foreground",
  running: "bg-primary-container text-on-primary-container",
  "awaiting-approval": "bg-primary-container text-on-primary-container",
  // Calm, not alarming: a paused Mission resumes on its own (usage limit) or
  // waits for an answer; never styled like a failure.
  waiting: "bg-secondary text-secondary-foreground",
  completed: "bg-success text-success-foreground",
  rejected: "bg-rejected text-rejected-foreground",
  failed: "bg-destructive text-destructive-foreground",
  cancelled: "bg-secondary text-secondary-foreground",
};
