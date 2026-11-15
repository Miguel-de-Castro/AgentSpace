# Design Guardrails

Written after reviewing the Google Stitch output (an early AI-generated mockup set, since removed from the repo as obsolete) against `05-STITCH_PROMPT.md` and `04-USER_JOURNEYS.md`. The full 11-screen draft came back as a generic "AI fleet control / ops-monitoring" template — the opposite tone of the calm mission-control workspace specified. Re-running the Stitch prompt (even reworded) hasn't reliably fixed this in past attempts, so the findings below were carried forward as binding constraints on the real frontend (`web/`), which was built directly against them instead of from the mockups.

---

## What went wrong, concretely

- **Banned vocabulary leaked back in everywhere:** "Agent," "Fleet," "Deploy Agent/Fleet," "Commander," "tasks." The spec (`05-STITCH_PROMPT.md`) requires "Mission" / "Team Member" only, and forbids "task," "ticket," "agent" in visible copy.
- **Anxious live-monitoring UI:** throughput bars, CPU/memory gauges, "Ops/sec," "REQ/SEC," a live world-map "network monitor." The spec explicitly forbids "live-updating counters or progress bars that invite anxious watching" — running Missions should read as calmly "in good hands."
- **Gamified/hype tone:** "Welcome back, Commander," "Deploy Fleet ⚡," "Initialize Version 2.0 🚀," "VISUAL DISRUPTION DETECTED." The spec calls for "calm, precise, quietly confident," explicitly avoiding gamification and "AI magic" effects.
- **Outcome states blurred:** Mission Rejected read as a dramatic incident rather than a normal, expected, non-alarming outcome distinct from failure — the spec requires completed / rejected / failed to be three separate identities, not shades of one, and rejection specifically must carry no apologetic or alarming iconography.
- **Process not separated from outcome:** the screen meant to be the Lightweight Acknowledgment (everyday, zero-friction reaction) instead rendered as a raw, undifferentiated activity log with a live-stats sidebar — exactly the pattern the spec prohibits ("process detail should be available but not forced into view").
- **A central search/prompt box sat in the header on every screen** — the spec is explicit that AgentSpace is not a chat interface and must never present a prompt box as the primary interaction surface.
- **Trust Ledger read as a compliance/surveillance dashboard** ("Human Oversight: Low," "Global Agent Governance Layer") rather than the personal record the spec calls for.

What *did* land correctly and is worth preserving: Approval Gate's two equally-weighted actions (Allow / Don't Allow) with an optional decline-reason field, and Proposed Mission's confirm/dismiss pair with visible provenance back to the originating Mission.

---

## Binding guardrails for MVP implementation

These are hard constraints on the real frontend, independent of the mockups:

1. **No word "Agent," "Fleet," "task," "ticket," "Commander" in any user-visible copy.** Use "Mission," "Team," "Team Member," "Project," "developer."
2. **No live-updating numeric telemetry** (throughput %, ops/sec, CPU/memory gauges, animated progress bars) on any screen. A running Mission's state is binary-ish for display purposes: running, waiting on you, or finished — never a percentage inviting a refresh-and-watch habit.
3. **No central chat/prompt input as a primary surface.** Search is fine as a secondary, clearly-labeled utility; it must never visually anchor the top of every screen the way a chat box would.
4. **Completed / Rejected / Failed must be three distinct visual identities**, checked by covering the text and confirming they're still distinguishable by color/iconography alone.
5. **Rejection copy must read as neutral/expected, never alarming or apologetic.** No incident-style language ("disruption detected," "critical," siren iconography) attached to a rejected outcome.
6. **Process (tool calls, steps) and outcome (diff/report) are always visually separated**, with process collapsed by default. No screen should present a raw chronological log as its main content when the user's actual question is "what resulted."
7. **Trust Ledger / track record frames the data as the developer's own history to consult, not a compliance score being reported on them.** Avoid "oversight level," "compliance score," "governance layer" framing.
8. **Any AI-originated judgment (Reviewer findings, recommendations) must read visually as advice, never as a resolved decision** — no styling that makes a Recommendation look identical to a human Decision.

## Process note

Given Stitch reruns haven't reliably held these constraints, treat future Stitch output as a rough layout/component starting point only — plan to hand-audit and patch copy/tone/live-metrics on every screen it produces, and budget for it as a normal step rather than a one-off fix.
