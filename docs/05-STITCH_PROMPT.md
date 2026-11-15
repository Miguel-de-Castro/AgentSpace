# Google Stitch Prompt Package

Generated from the frozen domain model (`02-DOMAIN.md`) and `04-USER_JOURNEYS.md`. This is the action point in the pipeline that needs a human: paste the prompt below into Stitch in one pass to get every screen designed in detail up front. Validate the full set together, iterate on wording here if a screen misses the mark, and re-run — once the first full pass is good enough to build from, further refinement happens directly in code rather than through more Stitch prompts.

---

## Full Prompt (paste as one)

```
Design a desktop-first web application called AgentSpace. It is a visual
workspace for supervising an AI software engineering team that works
autonomously inside a local git repository. The user is a solo developer.

PRODUCT IDENTITY
AgentSpace is not a chat interface and not an issue tracker. Never design
a central chat/prompt box as the primary interaction surface, and never
adopt Jira/Linear-style ticket-board visual language (no kanban swimlanes,
no ticket IDs like "AGENT-123"). Think instead: a calm mission-control
workspace where a human supervises a small team that mostly works without
being watched.

CORE METAPHOR
Work is organized as "Missions" — a goal handed to an AI team, which the
team pursues over one or more work sessions ("Executions") until it
reaches an outcome. The AI team is presented as named roles (Planner,
Developer, QA, Reviewer), never as generic "agents" or bots. Never use
the words "task," "ticket," or "agent" in visible UI copy — use "Mission"
and "Team Member."

THE THREE QUESTIONS EVERY SCREEN SHOULD SERVE
A returning developer must be able to answer, at a glance, in under a
minute:
1. What did the AI team actually do while I was away?
2. Why did it make the choices it made?
3. What, if anything, needs my decision right now?
Every screen should visibly serve at least one of these. If a screen
doesn't, it's decoration, not function.

TONE AND VISUAL DIRECTION
Calm, precise, quietly confident — like a well-run engineering team's
status board, not a hype-driven AI product. Avoid: gamification, glowing
"AI magic" visual effects, chat bubbles, avatars with personality, loud
gradients, excessive motion. Favor: clear typographic hierarchy, generous
whitespace, a restrained color palette where color is used functionally
(status, urgency) rather than decoratively, monospace accents for
code/diffs, a dark-mode-first aesthetic appropriate for a developer tool
used for long focused sessions, but must also support a clean light mode.

INFORMATION HIERARCHY (present in most screens)
- Mission status must always be scannable at a glance: running
  unattended, waiting on the developer, or finished (and if finished,
  whether it completed, was rejected, or failed — these three must be
  visually distinct from each other, not variations of the same color).
- A clear, persistent sense of "what needs me right now" that surfaces
  above everything else when something does.
- A separation between "what happened" (process — tool calls, steps
  taken) and "what resulted" (outcome — the actual diff/files/report a
  human reviews) — these should never be shown as one undifferentiated
  feed. Process detail should be available but not forced into view.
- Never state or imply an AI made a binding decision. Anywhere the AI's
  judgment appears (a reviewer's findings and recommendation), it must
  read visually as advice awaiting a human response — not as something
  already resolved. The moment a human actually decides something
  (approve/reject a merge) must look and feel distinctly more weighty
  than everyday status browsing.

SCREENS TO GENERATE — design ALL of the following now, in full detail,
in this same pass. This is a first complete draft meant to be reviewed
as a whole set, not a sample to be followed up on piecemeal.

1. PROJECT DASHBOARD
   Every Mission in the current Project, distinguishable by status at a
   glance, with anything needing the developer visually promoted above
   the rest. Must handle a realistic volume (8-15 Missions) without
   becoming overwhelming. The number of Missions needing attention right
   now should be one of the most prominent things on the screen. No
   live-updating counters or progress bars that invite anxious watching —
   running Missions should read as calmly "in good hands."

2. MISSION DETAIL VIEW
   A single Mission's full story: current status, what happened
   (collapsible process detail, not forced into view), what resulted
   (the reviewable output, shown separately and more prominently than
   the process), and any Reviews/Recommendations attached to it,
   clearly marked as advice, not resolved fact.

3. RETURNING AFTER TIME AWAY (digest view)
   What the developer sees on open after being gone a while, across
   multiple Missions. Reads like a digest, not a raw feed — grouped by
   urgency (needs-you first, then recently finished, then quietly
   running), each with a short plain-language account of what happened.
   Visually distinguish a Mission where an autonomous fix-up cycle
   already resolved itself from a Mission actually waiting on the
   developer — these must never look the same at a glance.

4. APPROVAL GATE (binding decision)
   The moment a Mission's change is about to merge into a protected
   branch and needs the developer's binding decision. Must feel
   distinctly more weighty than ordinary browsing — not a
   confirm/cancel modal dismissible by clicking outside it. Show the
   real diff (not a paraphrase), any Reviewer findings/recommendation
   as advice the developer can agree or disagree with, and two equally
   weighted actions (allow / don't) with neither reading as the
   obvious default. Include a lightweight, optional way to leave a
   reason when declining.

5. PROPOSED MISSION (awaiting confirmation)
   How a follow-up Mission the AI team suggests — but hasn't started —
   appears. Must be unmistakably NOT yet running, closer to a draft
   suggestion card than a queued task. Shows why it's being suggested
   and links back to the originating Mission/Review. Two equally easy,
   frictionless actions: confirm into a real Mission, or dismiss.

6. TRACK RECORD / TRUST LEDGER
   Two variants: (a) an inline, contextual note at the moment of an
   approval decision surfacing a relevant pattern from past decisions
   (e.g., "similar changes in this area needed changes 3 of the last 4
   times") — must read as helpful context, never as an automated
   judgment or warning; (b) a standalone view where the developer
   browses their own accumulated track record (approved / rejected /
   needed-changes, by area of the codebase, over time) — framed as a
   personal record they're consulting, not a compliance dashboard.

7. STARTING A MISSION
   The flow for handing the AI team a new goal. Only mandatory input is
   the brief. Shows the proposed Team (editable, not fixed) and an
   optional, visually distinct place to attach reference material
   (e.g. a pasted stack trace) that is context, not Mission output.
   Should feel like a quick, confident handoff — no multi-step wizard,
   no progress bar. Ends by showing the Mission already running, making
   clear the developer is free to leave immediately.

8. LIGHTWEIGHT ACKNOWLEDGMENT
   The quick, non-blocking reaction a developer can leave on any
   Mission's output on an everyday, unprotected branch — visually and
   tonally as far as possible from the approval-gate screen's gravity.
   Trivially low-effort (e.g. "good" / "not what I wanted" / "worth a
   second look later"), never a required field. Leaving no reaction
   must look like a completely normal, undecorated state — no nagging
   pending indicator. Show where this reaction lives once left (a
   small, quiet marker on the Mission).

9. MISSION REJECTED (outcome state)
   How a Mission reads once its output was substantively rejected —
   technically sound, but not what the developer wanted. Visually and
   permanently distinct from both "completed" and "failed" — three
   different identities, not shades of one "not completed" state,
   distinguishable without reading text. No apologetic or alarming
   iconography — rejection is a normal, expected outcome, not an
   incident. Subtly point toward starting fresh without pressuring an
   immediate retry.

10. NEW PROJECT ONBOARDING
    Connecting a new local git repository for the first time.
    AgentSpace reads back the repository's existing branch protection
    and reflects it as "here's what we found, based on rules you
    already set" — never a new risk model to learn. If no protection is
    configured, clearly show the default branch is treated as protected
    anyway, with a one-sentence explanation why. Lets the developer
    confirm/adjust the default AI Team roster for this Project. Short
    and confident, not a multi-page wizard — ends by handing off
    directly into Starting a Mission (screen 7).

11. MULTIPLE MISSIONS AT ONCE (parallel supervision)
    An extension of the Project Dashboard (screen 1) specifically
    showing the experience of several Missions active simultaneously —
    some running unattended, some waiting on the developer, some just
    finished — and moving between them without losing context or place.

Design all eleven screens now, in full visual detail, as one coherent
set sharing the same design system, ready to be reviewed together as a
first complete draft.
```

---

## Notes for whoever runs this in Stitch

- Paste the whole thing as a single prompt. Review all eleven screens together against `04-USER_JOURNEYS.md` before deciding the first pass is good enough — check especially that screens 3, 4, 8, and 9 (digest, approval, lightweight ack, rejection) read as visually distinct from each other, since that's where this design most easily collapses into "everything looks like everything."
- If a screen misses the mark, it's usually faster to tighten that screen's paragraph above and re-run the whole prompt than to patch a single screen in isolation — keeps the design system consistent across the set.
- Once this first draft is validated, treat further iteration as a code-level concern (component work, real interaction states, responsive behavior) rather than more Stitch prompting — this file's job ends once the draft is good enough to build from.
