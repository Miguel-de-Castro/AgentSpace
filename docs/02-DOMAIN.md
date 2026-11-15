# Domain Model

> **Note:** this is part of the original product specification, written before implementation. Where it describes approval as *merging*, the shipped behavior is different: approving a Mission rebases its branch onto the base and pushes it to `origin`, and AgentSpace never merges or opens a PR (see the README and `03-ARCHITECTURE.md`).

## Core Work Unit: Naming Decision

The brainstorm left the name for the assignable unit of work open between three candidates. Working through the trade-offs:

| Candidate | Connotation | Risk |
|---|---|---|
| **Mission** | The AI team receives a directive and goes off to accomplish it. Fits "Autonomous Team" and "AI Team, not AI Agents" principles directly — a team goes on a mission, not a "work item." | Can read as gamified/dramatic if UI copy overuses it. |
| Work Item | Neutral, familiar from Jira/Linear. | The vision explicitly rejects "feels like Jira" — this is the vocabulary of the thing we're trying not to feel like. |
| Requirement | Implies a formal spec came first. | Fits PRD-driven flow poorly for a solo dev firing off a quick fix — too waterfall. |

**Decision: `Mission`.** It's the only candidate that actively reinforces the product's own framing (AI Team members, not generic agents) instead of borrowing enterprise issue-tracker vocabulary the vision explicitly wants to avoid. The gamification risk is real but manageable through restrained UI copy (e.g., a mission's detail view is just called "Mission," not "Your Heroic Quest").

**Confirmed.** This is now the canonical term — it propagates into `20-UBIQUITOUS_LANGUAGE.md` and every doc after it.

---

## Entity Model

```
Workspace
  └─ Project (1:many)
       ├─ AI Team Roster (default set of enabled roles for this project)
       └─ Mission (1:many)
            ├─ Assigned Team (subset of roles activated for this Mission)
            ├─ Execution (1:many — a Mission can pause for approval and
            │    resume, or retry after failure; each such attempt is a
            │    distinct Execution, not the same Execution reused)
            │    ├─ Evidence (1:many — an ordered, immutable record of
            │    │    what happened: tool calls, git diffs, transcript
            │    │    excerpts; captured regardless of whether anything
            │    │    downstream ever reads it)
            │    └─ Artifact (1:many — the meaningful output: a file,
            │         a test report, a reviewable diff-as-a-unit;
            │         belongs to the Execution that produced it)
            ├─ Review (0:many — an examination of one or more Artifacts,
            │    possibly spanning more than one of the Mission's
            │    Executions; human- or AI-originated — see "Review,
            │    Finding, Recommendation" below)
            │    ├─ Finding (0:many — a specific, evidence-grounded
            │    │    observation)
            │    └─ Recommendation (exactly one per Review — the
            │         concluding stance: approve | iterate |
            │         reject-suggested)
            └─ Decision (0:many — the human's binding verdict; may be
                 informed by a Review's Recommendation, never required
                 to agree with it — see "Decision" below)
```

Evidence and Artifact are both first-class, and deliberately distinct: **Evidence answers "what happened, how, why"** (process-level, granular); **Artifact answers "what resulted"** (product-level, the thing a human actually reviews). This distinction gives the reasoning-summary grounding constraint (`16-ASSUMPTIONS.md`, T-003 — summaries must be traceable to evidence, never speculative) a literal, checkable home in the domain model instead of just a written rule.

A Mission's relationship to Execution is 1:many, not 1:1 — the same shape as a CI pipeline versus its individual job runs. This is why Mission Engine and Execution Engine are kept as separate architectural layers (see Architecture Discovery notes below): collapsing them would conflate "the enduring unit of work with policy and state" with "one concrete attempt that produced specific diffs."

### Workspace

The collection of all Projects a user manages in AgentSpace. For a solo developer this is largely organizational — a way to group projects — rather than an entity with much identity of its own in v1. Not multi-tenant; one Workspace per local install in v1 (consistent with the "no multi-user accounts" non-goal in `01-PRD.md`).

### Project

Maps 1:1 to a local git repository AgentSpace manages. Owns:

- A default **AI Team Roster** — which roles (Planner, Developer, QA, Reviewer, ...) are available to be activated for this project's Missions.
- The project's branch protection awareness (see `00-VISION.md`).
- All Missions ever run against it.

### Mission

A unit of work assigned to an AI Team within a Project. Has:

- A **brief**: the goal/instruction the Mission was given.
- A **status**: `proposed` → `queued` → `running` → (`awaiting-approval` ↔ `running`) → `completed` | `rejected` | `failed` | `cancelled`. Revised after domain scenario walkthroughs (`17-DOMAIN_SCENARIOS.md`, 2026-07-28):
  - **`proposed`** — added because an AI Team Member's own observation can suggest a follow-up Mission (Scenario 7), and letting that start running unconfirmed would violate "Humans stay in control." A proposed Mission is a draft (brief, suggested Team) awaiting human confirmation before it becomes `queued`.
  - **`rejected`** — added as its own terminal state, distinct from `failed`. A Mission that executed successfully and produced working Artifacts, but whose output a human substantively rejected, is a different and more valuable Trust Ledger signal than a technical execution failure (Scenario 6).
  - **`waiting` (added 2026-09-29, plan 20 Phase 3, decision D1):** `running` → `waiting` → `running`. The Mission stopped for a reason that is not failure, recorded in `waiting_reason`: `usage-limit` (the subscription refused to continue; AgentSpace resumes on its own at `resume_at`, continuing the same provider sessions on the same branch), `needs-input` (the team asked the supervisor a question) or `plan-review` (a plan checkpoint the supervisor approves, revises or discards). Like `awaiting-approval`, no process is held open while waiting: the Execution ends (`interrupted`) and a new one resumes (`resume-after-limit` / `resume-after-input`). A waiting Mission can be cancelled.
  - A Mission can cycle through `awaiting-approval` multiple times before reaching a terminal state. Confirmed (Scenario 4): `awaiting-approval` is a Mission-level state with no live process behind it — the underlying Execution terminates when a merge attempt is blocked, rather than staying suspended indefinitely.
- An **Assigned Team**: which roster roles were actually activated for this Mission — not necessarily the full roster.
- Produced **Artifacts**, via its Executions.
- Its own slice of the **Mission Graph**.

### AI Team / Team Member

A role (Planner, Developer, QA, Reviewer, and future roles like Architect, Researcher, Security, DevOps, Documentation, Product) that participates in a Mission. Presented to the user as a team member; the role and its responsibilities are a Mission Engine concept.

**Important boundary:** a Team Member is not the same thing as a Claude Code "subagent," even though Claude Code happens to have a native subagent concept and that may well be how a Team Member is implemented today. What a Team Member *is* (a role with responsibilities, inputs, and outputs) belongs to the domain; *how* it's actually executed (one Claude Code subagent, multiple sequential CLI invocations, or something else entirely for a future provider) is a Provider Adapter implementation detail. Letting these become synonymous would quietly recouple the domain language to Claude Code.

**Decision: fresh per Mission, no cross-Mission memory in v1.** Each Mission's Assigned Team is composed from scratch; a Team Member has no identity or persisted context beyond that single Mission. Any continuity a user perceives ("the Reviewer knows our conventions") comes from what's actually visible in the codebase and git history, not from persisted agent memory.

This is deliberately the simpler v1 commitment — it avoids building a per-role, per-project memory/context store before the fresh-team model is even validated. Persistent Team Member identity is a plausible v2 idea once we know whether users actually want it, not a day-one architecture requirement.

### Artifact

Anything an Execution produces: a file diff, a new file, a document, a test report. **Artifacts belong to exactly one Execution** (corrected 2026-07-30 — an earlier draft of this section said "belongs to exactly one Mission," which conflicted with `20-UBIQUITOUS_LANGUAGE.md` and doesn't hold once a Mission has several Executions: Scenario 3's original refactor and its follow-up fix are two distinguishable Artifacts from two distinguishable Executions, not one undifferentiated pool owned by the Mission). A Mission's full set of Artifacts is simply the union of its Executions' Artifacts — ownership is direct to Execution, transitive to Mission.

Immutable once assembled: a later fix is a *new* Artifact from a *new* Execution, never an edit to a prior one.

### Review, Finding, Recommendation

*(Added 2026-07-30, resolving a contradiction the domain scenario walkthroughs surfaced — see `17-DOMAIN_SCENARIOS.md` Scenario 3 and the Domain Discovery session it triggered.)*

**Review** is an examination of one or more Artifacts, forming a judgment. It can be produced by a human or by an AI Team Member (e.g., a Reviewer role, as part of Mission execution). A Review is **Mission-scoped, not Execution-scoped** — the Artifacts it examines may span a single Execution or several (a human approving a merge is typically looking at the net accumulated result of every Execution the Mission has had so far, not just the latest one). A Review is immutable once submitted; a changed mind produces a new Review, never an edit to the old one.

A Review contains:

- **Finding(s)** — zero or more specific, evidence-grounded observations (e.g., "a call site was missed" — pointing at a specific Artifact, citing the Evidence that grounds it). A Review can have zero Findings (a clean pass). **Findings carry no independent identity in v1** — each is a structured item in the Review's list (text, locus, severity, Evidence citation), not a separately-referenced object. This is a deliberate, considered simplification: an earlier draft of this model gave Finding its own identity to support per-issue resolution tracking, but no domain scenario actually exercises that, and the Trust Ledger's stated v1 payoff (`01-PRD.md`) is Mission-level pattern surfacing ("3 of the last 4 Missions..."), not Finding-level. Per-Finding identity and resolution tracking is a plausible v2 promotion if that capability is ever actually built — not a v1 requirement, the same deferral shape as "Objective" (see `17-DOMAIN_SCENARIOS.md`, "Concepts Tested and Not Adopted").
- **Recommendation** — exactly one per Review: the concluding stance (`approve | iterate | reject-suggested`), plus a rationale. Recommendation has no identity or lifecycle of its own — it's a structured value belonging to the Review that produced it, kept as a named concept for ubiquitous-language clarity (it maps directly onto how a developer already talks about this — "the AI recommends X" — not because it needs independent existence to function.

**What a Recommendation is not:** authority. A Recommendation never resolves anything by itself.

- If a Recommendation says **iterate**, that is not a human decision point. It's a signal Mission Engine's own policy acts on autonomously — spinning up a new Execution under the same Mission to address what was found — consistent with "Autonomous Team, avoid interrupting execution" (`00-VISION.md`). No Decision is created for this.
- If a Recommendation says **approve** or **reject-suggested**, it becomes input to a human's eventual Decision at the merge gate — informing it, never substituting for it. A human's Decision can agree with or override the Recommendation that preceded it; that divergence, when it happens, is itself worth recording (it's exactly the kind of signal the Trust Ledger exists to surface).

This resolves what was previously an open contradiction: an AI Review was once described as directly "becoming" a Decision (`17-DOMAIN_SCENARIOS.md` Scenario 3, as originally written) — which conflicted with Decision being "always human." Under this model, that's no longer possible even in principle: AI produces Evidence, Artifacts, Reviews, Findings, and Recommendations. Decision is a different kind of thing entirely, and only a human can produce one.

### Mission Graph

*(Supersedes "Execution History" from the earlier draft of this doc — renamed after Architecture Discovery, 2026-07-28.)*

The business need this name serves: a developer should be able to see how everything connects — which Mission led to which other Mission, which Review's Recommendation a Decision agreed or disagreed with, which Decision triggered a follow-up Mission — without that history being scattered or flattened into something linear that can't express it. "Execution Graph" was rejected as a name because it implied scope limited to one Execution's internal events; Mission Graph naturally spans relationships *between* Missions too.

**Naming note (2026-07-30):** "Mission Graph" is retained as established vocabulary, but it should be understood as **descriptive of a connectedness need, not a prescription for how it's stored.** The Domain Freeze Review found this is the one term in the domain vocabulary whose name leans on an implementation metaphor (nodes/edges) rather than pure business language — the underlying need ("everything traceable and connected") is domain-owned regardless of what `03-ARCHITECTURE.md` decides to build it on top of. Mission Graph is not itself an aggregate with its own identity or lifecycle — it names the union of every relationship the other concepts already form.

Node types: Mission, Execution, Evidence, Artifact, Review, Decision. (Finding is reachable through its parent Review, not addressed independently in v1 — see "Review, Finding, Recommendation" above.)
Edge types (non-exhaustive): produced-by, informed-by, resulted-in, triggered-by, superseded-by.

Two things are **projections over the Mission Graph**, not separate data stores and not stages in a pipeline:

- **Timeline** — a chronological projection, at two zoom levels: **Project Timeline** (all Missions' events interleaved — the "what happened while I was away" view) and **Mission Timeline** (filtered to one Mission — the drill-in view).
- **Trust Ledger** — a judgment/pattern projection over Decision nodes specifically, aggregated *across every Mission, every Project, over time*. It is not the last stage a single Mission passes through; its entire value is cross-Mission aggregation, so modeling it as a terminal pipeline step would misrepresent it.

---

## How This Ties Into the Approval Model

A branch-protection merge gate (`00-VISION.md`) is a Decision node in the Mission Graph, of a type requiring human approval, linked to the Review(s)/Artifact(s) that informed it. It appears on both the Mission Timeline (in context) and the Project Timeline (as something needing attention), and becomes part of the Trust Ledger's queryable history once resolved — the concrete implementation of the "what needs me" queue described in `01-PRD.md`'s v1 success criteria.

**Decision has two tiers**, revised after domain scenario walkthroughs (`17-DOMAIN_SCENARIOS.md`, 2026-07-28) surfaced that coupling Decision *only* to the protected-branch gate starves the Trust Ledger — most solo-developer work happens on unprotected feature branches and would otherwise never produce a Decision at all:

- **Binding Decision** — the mandatory gate at a protected-branch merge. Blocks; always human; always recorded. Outcome vocabulary is `approved | rejected` — a binary, **not three-valued**. (Revised 2026-07-30: an earlier version of this model added `request-changes` as a third Decision outcome, looping back into a new Execution under the same Mission. That was the wrong layer — it conflated a human-authorized gate with an AI Team Member's mid-Mission iteration signal, and was the direct cause of the "AI Review becomes a Decision" contradiction found in Scenario 3. `iterate` now lives on **Recommendation**, driving an autonomous Mission Engine policy loop with no Decision involved — see "Review, Finding, Recommendation" above.)
- **Lightweight Decision** — an optional, low-friction acknowledgment a human can leave on any Mission's Artifacts, even on an unprotected branch (e.g., one click: "good" / "not what I wanted"). Non-blocking, not mandatory — its purpose is keeping the Trust Ledger fed during the everyday work that never touches a protected branch.

- **Plan Decision** (added 2026-09-30, plan 20 Phase 3.3) — the supervisor's call on a plan checkpoint, before anything is built: `plan-approved | plan-revised | plan-discarded`. Always human, recorded in the Mission Graph, never counted in the Trust Ledger (which aggregates Binding Decisions only). An approved plan is kept on the Mission and every later role builds from it.
- **Acceptance criteria** (added 2026-09-30, plan 20 Phase 4, decision D4) — what "done" means for a Mission: written by the developer in New Mission, completed by the Planner where missing (marked as the Planner's), judged criterion by criterion by the AI reviewers (`met | not-met | unclear`). Advice only: they never block the Binding Decision.

This split is flagged, not fully resolved — it's the clearest open product/UX question carried into `03-ARCHITECTURE.md`: what does a one-click lightweight Decision actually look like, and how do we avoid it becoming friction the developer routes around.

**A known weak point, carried forward rather than solved here:** nothing in this domain model can structurally distinguish a human who genuinely deliberated before a Decision from a human who scripted an unattended auto-click against the same API. "Decision is always human" is enforced by whatever the approval surface chooses to expose, not by anything intrinsic to the Decision concept itself — this is a technical/security enforcement question for `03-ARCHITECTURE.md`, not a domain modeling gap.

---

## Architecture Discovery Findings (2026-07-28)

Two decisions fell out of a capability-first analysis (full reasoning in conversation history; landing here as the durable record):

- **Worktree ownership belongs to the Execution Engine, via plain git — not Claude Code's native `--worktree` flag.** Claude Code's own worktree support is real and confirms concurrent Missions are safe, but building on Claude's specific flag would recouple a fundamentally provider-agnostic git operation to one provider's implementation of it.
- **Claude Code's own session transcript is not a valid system-of-truth dependency.** Its JSONL format is explicitly documented as internal and versioned, not a stable contract. The Execution Engine must normalize and persist its own record the moment events arrive; Claude Code's transcript is raw material, never the durable store.
- **The Provider Adapter must integrate via direct CLI subprocess invocation (`claude -p --output-format stream-json`), never via the Claude Agent SDK.** Resolved via T-004 (`16-ASSUMPTIONS.md`): the Agent SDK requires `ANTHROPIC_API_KEY` and makes direct API calls, bypassing subscription auth entirely, despite bundling the same binary — the obvious-seeming official path is the wrong one for the "no paid API" constraint. `--bare` mode must also be avoided for the same reason. This is the resolution to what was called "the architectural pivot" of the whole product.

## Open Questions Carried Into Architecture

Inherited from `01-PRD.md`: headless Claude Code control fidelity, and the source of reasoning summaries — both affect whether Mission Graph nodes are captured directly or synthesized after the fact.
