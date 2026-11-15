# AgentSpace

## Product Thesis

**AgentSpace is the system of record for AI-assisted software delivery.**

This is the underlying idea the three differentiators (Trust Ledger, Coordination Plane, Judgment Interface — see `01-PRD.md`) are consequences of, not a marketing line. It passes the five-year test deliberately used throughout this project's decisions: if Claude Code becomes dramatically better, more delivery happens, faster — which means *more* governance and trust infrastructure is needed, not less. The thesis gets stronger as the underlying AI improves, not weaker.

Scoping note: "delivery" here means the path from intent to trusted, approved, merged change — not deployment. AgentSpace may observe what happens downstream, but per "Humans stay in control" below, it never executes or claims ownership of deployment itself.

---

## Vision

AgentSpace is a visual workspace built on top of Claude Code.

Instead of interacting with AI agents through a terminal, developers work inside a modern collaborative workspace where they can observe, understand and coordinate their AI team.

The goal is not to replace Claude Code.

The goal is to make AI software development transparent, understandable and enjoyable.

---

# Mission

Transform AI-assisted software development from a terminal experience into a visual collaborative workspace.

---

# Product Statement

AgentSpace allows developers to understand:

- what every AI team member is doing;
- why each decision was made;
- the current progress of the implementation;
- what artifacts have been produced;
- where human intervention is required.

The user should never feel disconnected from the work happening.

---

# Design Principles

## Claude remains the brain

Claude Code performs the work.

AgentSpace visualizes the work.

---

## Transparency over automation

Every important action performed by an AI should be visible.

The user should always understand:

- What happened.
- Why it happened.
- What comes next.

---

## Humans stay in control

No hidden changes: every change an agent makes is visible and logged, whether or not it required approval.

No automatic merge into protected branches.

No autonomous deployment. A merge approval is not a deployment approval — the two are separate gates, since a merge into a protected branch may itself trigger CI/CD elsewhere.

AgentSpace defers to the repository's own branch protection rules (e.g. `main`, `release/*`) as the boundary of autonomy:

- Agents work freely on unprotected branches and worktrees without waiting on a human.
- Merging into a protected branch always requires explicit human approval.
- If a repository has no branch protection configured at all, AgentSpace treats its default branch (`main`/`master`) as implicitly protected. A repo cannot gain full autonomous-merge access simply by omission.

This reuses a boundary developers already trust and configure themselves, instead of AgentSpace inventing its own risk model for what counts as "safe."

The AI team prepares the work.

The developer approves it.

---

## Autonomous Team

AI team members should operate independently whenever possible.

AgentSpace should avoid interrupting autonomous execution.

Instead, it should visualize progress and expose reasoning summaries.

---

## AI Team, not AI Agents

Throughout the application, AI workers are presented as members of a software team.

Examples:

Planner

Developer

Tester

Reviewer

Architect

Researcher

instead of generic "agents".

---

# Long-Term Vision

AgentSpace should become the operating system for AI software teams.

Claude Code is the first supported execution engine.

Future versions may support additional providers without changing the user experience.