# Ubiquitous Language

Canonical definitions for every term used to describe AgentSpace's domain and architecture. If a term isn't defined here, it isn't part of the product's vocabulary yet — propose it here before using it in another doc, code, or the UI.

---

## Domain Terms

### Workspace

**Definition:** The collection of all Projects a user manages in AgentSpace.

**Responsibilities:** Organizational grouping only. Not multi-tenant.

**Relationships:** Workspace 1:many Project.

**What it is NOT:** Not a team or organization construct in v1 — there is one Workspace per local install, one user.

**Forbidden synonyms:** Organization, Account, Tenant.

---

### Project

**Definition:** Maps 1:1 to a local git repository AgentSpace manages.

**Responsibilities:** Owns an AI Team Roster (default enabled roles) and its branch protection awareness. Owns every Mission ever run against it.

**Relationships:** Project 1:many Mission. Project belongs to one Workspace.

**What it is NOT:** Not a "board" or "space" in the project-management-tool sense — it is always a specific repository, never an abstract container.

**Forbidden synonyms:** Repo (as a user-facing term — "Project" is the product word even though it maps to a repository), Board, Space.

---

### Mission

**Definition:** A unit of work assigned to an AI Team within a Project — a goal/brief, plus everything that happens in pursuit of it.

**Responsibilities:** Owns a brief, a status (`proposed → queued → running → (awaiting-approval ↔ running) → completed | rejected | failed | cancelled`, plus `waiting ↔ running` since 2026-09-29: paused for a usage limit, a question for the supervisor, or a plan to review; the reason is part of the state, and "paused" is the user-facing word), an Assigned Team, and is the root of a subtree of the Mission Graph (its Executions, Evidence, Artifacts, Reviews, Decisions). `proposed` covers an AI-suggested follow-up Mission awaiting human confirmation; `rejected` is distinct from `failed` — successful execution whose output a human substantively didn't want, a different and important Trust Ledger signal.

**Relationships:** Mission 1:many Execution. Mission belongs to one Project. A Mission's Decision can trigger another Mission.

**What it is NOT:** Not a single execution attempt — a Mission can span multiple Executions (pause-and-resume, retry-after-failure). Not an issue-tracker ticket; it's the thing the AI Team actually works on, not a request queued for a human.

**Forbidden synonyms:** Task, Job, Activity, Request, Ticket, Work Item, Requirement. (See `02-DOMAIN.md` for why these alternatives were rejected.)

---

### AI Team / Team Member

**Definition:** Team is the roster of roles (Planner, Developer, QA, Reviewer, and future roles) available to a Project. A Team Member is one such role, activated for a specific Mission.

**Responsibilities:** A role defined by responsibilities, inputs, and outputs — a Mission Engine concept.

**Relationships:** Project has a Team Roster; a Mission has an Assigned Team (a subset of the roster). Fresh per Mission — no cross-Mission memory or identity in v1 (see P-002, `16-ASSUMPTIONS.md`).

**What it is NOT:** **Not the same thing as a Claude Code "subagent."** Claude Code has its own native subagent concept, and a Team Member may well be implemented as one today — but what a Team Member *is* (role + responsibility) is domain-level; how it's executed is a Provider Adapter implementation detail. Conflating the two recouples the domain language to Claude Code.

**Forbidden synonyms:** Agent (generic — always say "Team Member" in product-facing contexts, per the original brainstorm's "AI Team, not AI Agents" principle), Subagent (reserve this word for Claude Code's own concept when discussing implementation, never for the domain concept), Worker, Bot.

**Known inconsistency (flagged 2026-07-30, not yet resolved):** `00-VISION.md`'s example role list uses "Tester"; this document, `02-DOMAIN.md`, and every domain scenario use "**QA**." Neither document names the other as a forbidden synonym. QA is treated as canonical here since it's the term actually used everywhere except the one Vision example — `00-VISION.md` should be reconciled to match, not the other way around, but that edit is out of scope for this pass.

---

### Execution

**Definition:** One concrete attempt at a Mission — a single run, bounded by a start and an end (success, failure, or interruption).

**Responsibilities:** Produces Evidence and Artifacts. Owns its own git before/after snapshot.

**Relationships:** Execution belongs to one Mission (1:many — a Mission can have several Executions over its life). Execution produces Evidence and Artifacts.

**What it is NOT:** Not the same as a Mission — a Mission is the enduring unit of work with policy and state; an Execution is one concrete attempt within it. Not a Claude Code session, though it may correspond to one — the mapping is a Provider Adapter concern, not a domain identity.

**Forbidden synonyms:** Run (acceptable informally, but "Execution" is canonical in docs/code), Session (reserve for Claude Code's own concept), Attempt.

---

### Evidence

**Definition:** The granular, process-level record of what happened during an Execution — tool calls, git diffs, transcript excerpts. Answers "what happened, how, why."

**Responsibilities:** The grounding source for Reasoning Summaries — a summary that can't cite Evidence should not exist (see T-003, `16-ASSUMPTIONS.md`).

**Relationships:** Evidence belongs to an Execution. Evidence informs Artifacts, Reviews, and Reasoning Summaries.

**What it is NOT:** Not the same as an Artifact — Evidence is the audit trail (process), Artifact is the deliverable (output). Not user-facing by default; it's what a Reasoning Summary or Review is built from, not something a user browses raw in the common case.

**Forbidden synonyms:** Log (too generic — Evidence is structured and typed, not raw text), Trace.

---

### Artifact

**Definition:** A meaningful output an Execution produced — a file, a test report, a document, a reviewable diff-as-a-unit. Answers "what resulted."

**Responsibilities:** The thing a human actually reviews and approves or rejects.

**Relationships:** Artifact belongs to exactly one Execution (corrected 2026-07-30 — `02-DOMAIN.md` previously said "belongs to exactly one Mission," which this document already contradicted; Execution is correct, since a Mission's Executions can each produce distinguishable Artifacts). Artifact is reviewed by a Review, which informs a Decision.

**What it is NOT:** Not Evidence (see above). Not necessarily a file — a test report or a summary document is also an Artifact if it's a reviewable output. Not mutable — a later fix is a new Artifact from a new Execution, never an edit to a prior one.

**Forbidden synonyms:** Output (acceptable informally, not canonical), Deliverable, Result.

---

### Review

**Definition:** An examination of one or more Artifacts, forming a judgment. Can originate from an AI Team Member (e.g., a Reviewer role producing a Review as part of Mission execution) or from a human. **Mission-scoped, not Execution-scoped** (clarified 2026-07-30) — a Review may examine Artifacts from a single Execution or from several (a final review before a merge typically looks at the Mission's accumulated net result, not just the latest Execution's incremental diff).

**Responsibilities:** Produces zero or more Findings and exactly one Recommendation. Bridges Artifact/Evidence to Decision — without ever being a Decision itself.

**Relationships:** Review examines Artifacts (and, via Findings, cites Evidence). Review's Recommendation may inform a Decision, but a Review can exist, stand complete, and inform nothing but an autonomous next Execution — it never requires a Decision to exist or to be meaningful (see Scenario 1 and Scenario 3 in `17-DOMAIN_SCENARIOS.md`).

**What it is NOT:** Not always a human action — an AI Reviewer role can produce a Review mid-Mission. **Not the same as a Decision, and can never become one** — a Review is an assessment; only a human produces the resolving verdict. Not scoped to one Execution.

**Forbidden synonyms:** Assessment, Evaluation, Check.

---

### Finding

**Definition:** *(Added 2026-07-30.)* A specific, evidence-grounded observation inside a Review — e.g., "a call site was missed," pointing at a specific Artifact and citing the Evidence that grounds it.

**Responsibilities:** The atomic unit a Review is built from. Enforces T-003's grounding requirement (`16-ASSUMPTIONS.md`) at the level of a single observation, not just the whole Review.

**Relationships:** Finding belongs to the Review that produced it. Cites Evidence. Points at a specific Artifact.

**What it is NOT:** Not independently identified or addressable outside its parent Review in v1 — no per-Finding resolution status is tracked (a later clean Review is the only signal that prior concerns were addressed). Not a Decision, not a Recommendation, not authority — purely descriptive. Considered for independent identity during discovery and deliberately not adopted for v1 — see `17-DOMAIN_SCENARIOS.md`.

**Forbidden synonyms:** Issue, Comment, Note (avoid generic terms — "Finding" specifically implies it's grounded in cited Evidence, which a bare "comment" doesn't guarantee).

---

### Recommendation

**Definition:** *(Added 2026-07-30.)* The single concluding stance of a Review: `approve | iterate | reject-suggested`, plus a rationale.

**Responsibilities:** The advisory signal a human (or Mission Engine's own policy, for `iterate`) acts on. Never binding by itself.

**Relationships:** Exactly one per Review, belonging to it — no independent identity or lifecycle. `iterate` drives an autonomous Mission Engine policy loop (a new Execution under the same Mission, no human involved). `approve`/`reject-suggested` may inform a later human Decision, which can agree with or diverge from it.

**What it is NOT:** Not a Decision — it carries no authority to change what's permitted next. Not independently referenceable outside its Review; kept as a named concept for how developers already talk about this ("the AI recommends X"), not because it needs identity to function.

**Forbidden synonyms:** Verdict, Suggestion (acceptable informally, not canonical), Directive (never — a Recommendation cannot direct anything on its own).

---

### Decision

**Definition:** The resolving verdict on a Mission's work — **always a human action**, no exception. Two tiers (added after domain scenario walkthroughs, `17-DOMAIN_SCENARIOS.md`): **Binding Decision** — the mandatory gate at a protected-branch merge, outcome `approved | rejected` (revised 2026-07-30 — see below), always human, always recorded, blocks the Mission. **Lightweight Decision** — an optional, low-friction acknowledgment on any Mission's Artifacts even without a protected-branch merge, non-blocking, whose purpose is keeping the Trust Ledger fed during everyday unprotected-branch work.

**Revision, 2026-07-30:** an earlier version of this definition gave Decision a third outcome, `request-changes`, looping the Mission back into a new Execution. That outcome has been removed from Decision's vocabulary — it was the direct cause of a contradiction found in `17-DOMAIN_SCENARIOS.md` Scenario 3, where a Review appeared to "become" a Decision without a human involved. That signal now belongs to **Recommendation** (`iterate`), which drives an autonomous Mission Engine policy loop, never a Decision. Decision's outcome vocabulary is a strict binary at the Binding tier.

**Outcome vocabulary (promoted here 2026-08-12, `.claude/plans/completed/07-remaining-web-screens.md` — previously only lived in `src/domain/types.ts`):**
- **Binding:** `approved | rejected`. Strict binary, per the revision above.
- **Plan** (2026-09-30, plan 20 Phase 3.3): `plan-approved | plan-revised | plan-discarded`, recorded when the developer reviews a plan checkpoint. Not part of the Trust Ledger.
- **Lightweight** (Journey 4, "leaving a lightweight acknowledgment"): `acknowledged-good | acknowledged-not-wanted | flag-for-later`. Never blocks the Mission, never changes its status — purely a personal reaction recorded for the Trust Ledger's benefit (though the Trust Ledger itself, as implemented, aggregates Binding Decisions only — see Trust Ledger below). A Mission may accumulate several Lightweight Decisions over time (the developer glances at it more than once); the UI treats the most recent as "current" for display, but none supersedes or invalidates an earlier one — no correction concept exists at this tier, matching its zero-friction, no-justification-required nature.

**Responsibilities:** The unit the Trust Ledger aggregates over. The only concept in the domain that actually changes what's permitted to happen next.

**Relationships:** Decision may be informed by a Review's Recommendation — never required to, and never required to agree with it. Decision can trigger a new Mission (via a human confirming a `proposed` Mission). Decisions across the whole Mission Graph are what the Trust Ledger is a projection over.

**What it is NOT:** Not the approval-gate mechanism itself (that's a hook-enforced Provider Adapter detail) — Decision is the domain record of what was resolved, independent of how it was technically enforced. Not producible by an AI under any circumstance — AI produces Evidence, Artifacts, Reviews, Findings, and Recommendations; Decision is a categorically different kind of thing.

**Known weak point:** "always human" is not something this domain model can structurally verify — it depends on the approval surface never exposing an unattended auto-approve path, which is an enforcement question for `03-ARCHITECTURE.md`, not something the Decision concept itself guarantees.

**Forbidden synonyms:** Verdict, Resolution, Outcome (as a standalone noun for this concept), Recommendation (these are never interchangeable — see above).

---

### Mission Graph

**Definition:** The connected, traceable record of how every Mission, Execution, Evidence, Artifact, Review, Finding, Recommendation, and Decision relate to each other across a Project (and, in principle, the Workspace) — not a flat log, because the domain has real relationships (an Artifact was reviewed, that Review's Recommendation informed a Decision, that Decision triggered a follow-up Mission) a linear record can't express.

**Naming note (2026-07-30):** the Domain Freeze Review flagged this as the one term whose name leans on an implementation metaphor (graph as a data structure) rather than pure business language. The underlying need — everything traceable and connected — is domain-owned and provider/storage-agnostic; the word "Graph" itself is retained as established, already-adopted vocabulary, not because the business need requires that specific framing. Treat "Mission Graph" as description, not prescription, when `03-ARCHITECTURE.md` decides how this is actually built.

**Responsibilities:** Names the connectedness that Timeline and Trust Ledger are both projections of. Has no identity or lifecycle of its own — it isn't created, isn't an aggregate, and isn't a peer concept to Mission/Execution/Review/Decision; it's the sum of the relationships those concepts already form.

**Relationships:** Contains all domain entities above as typed nodes, connected by typed edges (produced-by, informed-by, resulted-in, triggered, approved-by, superseded-by).

**What it is NOT:** Not the same as Timeline (a chronological projection of it) or Trust Ledger (a judgment-pattern projection of it) — the graph is the data; those are two of possibly several views over it. Not scoped to a single Execution's internal events (that was "Execution Graph," rejected — see `02-DOMAIN.md`).

**Forbidden synonyms:** Execution Graph (explicitly retired), Event Log, Audit Log (too flat — implies linear, not relational).

---

### Timeline

**Definition:** A chronological projection over the Mission Graph, at two zoom levels: Project Timeline (all Missions interleaved) and Mission Timeline (filtered to one Mission).

**Responsibilities:** The "what happened while I was away" view.

**Relationships:** A view/query over the Mission Graph. Not a separate data store.

**What it is NOT:** Not the source of truth — the Mission Graph is. Not the only projection — see Trust Ledger.

**Forbidden synonyms:** Feed, Activity Log.

---

### Trust Ledger

**Definition:** A judgment/pattern projection over Decision nodes in the Mission Graph, aggregated across every Mission and every Project over time.

**Responsibilities:** The foundation of the differentiator by the same name — surfacing patterns ("you've rejected 3 of the last 4 changes touching billing code") to speed up and sharpen future Decisions.

**Relationships:** A view/query over Decision nodes and their linked Evidence/Artifacts across the whole Mission Graph.

**What it is NOT:** Not a terminal pipeline stage a single Mission passes through — its entire value is cross-Mission aggregation. Not the same as Timeline (different projection, different purpose — judgment patterns vs. chronology).

**Forbidden synonyms:** History, Audit Trail (too generic — Trust Ledger is specifically about Decisions and the patterns across them, not everything that happened).

---

### Reasoning Summary

**Definition:** A concise, evidence-grounded explanation of "why" a significant action was taken — never raw chain-of-thought, never speculative narrative not traceable to Evidence.

**Responsibilities:** Must cite/derive from Evidence. A summary that cannot be grounded should not be generated (see T-003, `16-ASSUMPTIONS.md`).

**Relationships:** Built from Evidence. Attached to Executions/Artifacts/Decisions as needed.

**What it is NOT:** Not chain-of-thought. Not a feature Claude Code provides natively — entirely an AgentSpace-owned capability.

**Forbidden synonyms:** Explanation (acceptable informally), Rationale, Chain of Thought (never — this is explicitly what Reasoning Summary is not).

---

### Approval

**Definition:** The human action that resolves a Decision requiring sign-off for changes headed to a protected branch (see "Humans stay in control," `00-VISION.md`). In the shipped product, approving rebases the Mission's branch onto the base and pushes it to `origin`; AgentSpace never merges and never opens a PR — the human does that.

**Responsibilities:** The hard stop in the autonomy model.

**Relationships:** An Approval is a specific kind of Decision.

**What it is NOT:** Not the same as a Review (Review is an assessment; Approval is the human's resolving action on a Decision that required one).

**Forbidden synonyms:** Sign-off (acceptable informally), Merge Confirmation.

---

## Architecture Terms

### Provider

**Definition:** An AI execution engine AgentSpace can drive — Claude Code in v1, potentially others in the future.

**Forbidden synonyms:** Engine (reserve "Engine" for Mission Engine / Execution Engine, AgentSpace's own components — never for a Provider, to avoid confusing "our layer" with "the AI vendor's tool").

---

### Provider Adapter

**Definition:** The narrow layer responsible only for starting, observing, cancelling, and resuming one Provider's execution. Translates Mission Engine policy into provider-specific mechanism (e.g., a policy decision into a blocking hook response).

**What it is NOT:** Not where git, diffing, or Mission Graph logic lives — those belong to Execution Engine and Mission Engine respectively, specifically so a provider swap never touches them (see Architectural Test 8, `19-ARCHITECTURAL_TESTS.md`).

---

### Execution Engine

**Definition:** Owns the mechanics of one Execution — git snapshot before/after, diff computation, Evidence and Artifact assembly, worktree lifecycle (via plain git, not a Provider's native worktree feature).

**What it is NOT:** Not aware of Mission-level policy (approval rules, Team composition) — that's Mission Engine. Not aware of which Provider is running — that's abstracted behind Provider Adapter.

---

### Mission Engine

**Definition:** Owns Mission state and policy — approval rules, Team Roster/assignment, the Mission Graph, and the Trust Ledger.

**What it is NOT:** Not where any Provider-specific or git-specific mechanics live.
