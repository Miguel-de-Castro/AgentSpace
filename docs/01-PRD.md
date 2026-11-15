# Product Requirements Document

> **Note:** this is part of the original product specification, written before implementation. Where it describes approval as *merging*, the shipped behavior is different: approving a Mission rebases its branch onto the base and pushes it to `origin`, and AgentSpace never merges or opens a PR (see the README and `03-ARCHITECTURE.md`).

## Elevator Pitch

Imagine GitHub Copilot, Cursor and Linear merged into a single workspace focused on AI teams instead of human teams.

AgentSpace is that workspace.

---

## Primary User

Solo developers.

Freelancers.

Startups.

Small engineering teams.

---

## Core Problem

Claude Code provides exceptional software engineering capabilities but operates primarily through a terminal interface.

Developers lack visibility into:

- current execution
- agent reasoning
- progress
- task ownership
- execution history

This creates uncertainty and reduces trust.

---

## Product Goals

Increase trust.

Increase visibility.

Reduce uncertainty.

Provide project organization.

Improve collaboration between humans and AI.

Never replace Claude Code.

Only augment it.

---

## v1 Beachhead User

Of the four target segments above, **v1 optimizes for the solo developer only.**

Freelancers, startups, and small teams are the deliberate expansion path (see Long-Term Vision in `00-VISION.md`), not requirements the v1 architecture must satisfy today. Designing for multi-user accounts, roles, or shared visibility before a single solo user's workflow is validated would trade v1 focus for speculative future needs.

Every v1 decision should be judged against one question: **does this help one developer trust and understand what their AI team did, right now, on their own machine?**

Restated for v1, the core problem becomes three questions a returning developer must be able to answer at a glance:

1. What did it actually do while I was away?
2. Why did it make the choices it made?
3. What, if anything, needs my decision right now?

---

## Non-Goals (v1)

Explicit exclusions, so scope decisions have something to point at:

- **No multi-user / team accounts.** No invites, no roles, no shared workspaces. Single local user only.
- **No support for AI engines other than Claude Code.** The "operating system for AI teams" future is a bet we're deferring, not building toward yet — see the Architecture Philosophy in the GPT brainstorm and its eventual home in `03-ARCHITECTURE.md`.
- **No autonomous merging into protected branches, and no autonomous deployment, ever**, regardless of how "confident" an agent is. Hard lines, not settings.
- **No custom risk-scoring model for agent actions.** AgentSpace defers entirely to git's own branch protection rules rather than inventing an AgentSpace-specific notion of "risky."
- **No mobile app, no notifications/paging infrastructure.** Desktop-first, session-based usage.
- **No billing, workspace analytics, or usage dashboards for teams.** There is no team yet to analyze.
- **No in-app chat/prompting UI competing with Claude Code's own interface.** AgentSpace visualizes and approves; it does not replace how the user talks to Claude Code.

---

## Success Criteria for v1

v1 is validated if a solo developer can:

1. Walk away from a running Claude Code session and, on return, understand what happened in under a minute without reading raw terminal scrollback.
2. Trust the approval queue enough to *not* feel the need to double-check `git log`/diff manually before approving a merge.
3. Say, unprompted, that they'd be uncomfortable going back to a terminal-only workflow.

If none of these three are true after real dogfooding, v1 has not earned the right to expand toward freelancers/teams.

---

## Open Dependencies Carried Into Architecture

Tracked in full detail in `16-ASSUMPTIONS.md`, which distinguishes Technical (`T-###`) assumptions — does the platform allow this — from Product (`P-###`) assumptions — is this worth building. Status as of the 2026-07-28 Claude Code research pass:

- **Headless/programmatic control of Claude Code (T-001, T-002) — Validated.** Confirmed via headless/print mode, the hook lifecycle, stream-json structured events, and native session objects. The "launcher" flow is architecturally sound. One caveat: diff access is not a stable Claude Code API — AgentSpace must compute diffs itself via git, not rely on Claude Code's own (partial, Bash-blind) checkpointing.
- **Source of reasoning summaries (T-003) — Unknown, decision made regardless.** No native reasoning-summary feature exists in Claude Code. AgentSpace owns this as its own architectural capability, built from transcript/tool-call evidence, with a hard constraint: summaries must be traceable to evidence, never speculative.
- **Subscription-only, no paid API required (T-004) — still Unknown, now the top remaining technical gap.** Whether headless control is achieved via the Agent SDK (likely API-metered) or direct CLI headless invocation under subscription auth is unresolved, and materially affects the business model. Must be resolved before `03-ARCHITECTURE.md` commits to an integration approach.
- **Product-level risk, not just technical:** the register now also tracks whether developers actually want the things this PRD assumes they want — concurrent Mission supervision (P-003), a persistent decision history they'd act on (P-004), a visual/observability-first workflow over chat (P-005), and whether more visibility genuinely produces more trust rather than more anxiety (P-006). These are arguably higher-risk than any technical unknown, since they question the product's core shape rather than a feature within it.