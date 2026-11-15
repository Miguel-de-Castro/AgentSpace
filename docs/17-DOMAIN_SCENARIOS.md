# Domain Scenarios — Domain Validation Suite

> **Note:** this is part of the original product specification, written before implementation. Where it describes approval as *merging*, the shipped behavior is different: approving a Mission rebases its branch onto the base and pushes it to `origin`, and AgentSpace never merges or opens a PR (see the README and `03-ARCHITECTURE.md`).

Concrete walkthroughs of the domain model against real situations. This document was originally a discovery tool, walked through *before* `03-ARCHITECTURE.md` to find out which concepts survive contact with a real scenario. That discovery phase produced real architectural decisions — the Mission→Execution 1:N shape, the `rejected` terminal status, the `proposed` status, the `triggered-by` Mission Graph edge, and the pause/resume semantics all trace back to a specific scenario below.

**As of 2026-07-30, the document's purpose has changed.** It is no longer a menu of examples — it is a **regression suite for the domain model**. Each scenario now carries three additional sections beyond its original Setup/Walkthrough/Concepts/Findings:

- **Architectural Invariants** — domain truths that must remain true regardless of implementation. Not code, not today's stack. If a future proposal violates one of these, that is an intentional domain change to be made explicitly, not an implementation detail to be shrugged through.
- **Failure Modes** — the specific, named ways a future implementation could accidentally violate this scenario while believing it's just an implementation choice. These are architectural regressions, not bugs.
- **Open Questions** — what this scenario deliberately does *not* answer. Absence of an answer is information; it separates validated knowledge from unknown knowledge and should not be silently assumed away.

See `02-DOMAIN.md` for concept definitions and `20-UBIQUITOUS_LANGUAGE.md` for canonical terms. See `19-ARCHITECTURAL_TESTS.md` for the architectural test numbers (AT #1–#10) referenced below.

**How to use this document going forward:** if a future architectural proposal would break an Architectural Invariant below, or reintroduce a named Failure Mode, that is not an implementation detail — it is a proposed domain change, and should be discussed and recorded as one (updating this document deliberately), not merged silently.

---

## Scenario 1: Create a feature

**Setup:** Solo developer creates a Mission — "Add CSV export to the reports page" — on an unprotected feature branch.

**Walkthrough:**
1. Mission created, brief = the goal statement. Mission Engine assigns a Team: Planner, Developer, QA (a subset of the Project's Team Roster).
2. Execution Engine creates a git worktree, snapshots the working tree ("before").
3. Execution #1 starts. Within this single continuous run: Planner breaks the goal into steps, Developer writes the export code, QA writes and runs tests. Every tool call (Read, Edit, Bash test run) is captured as Evidence.
4. Execution #1 completes without hitting any approval gate (unprotected branch).
5. Artifacts are assembled: the modified/new source files, the new test file, a reviewable diff bundle, a test report.
6. The developer glances at the diff. No formal Review record is created — they just look and move on.
7. Mission status → `completed`.

**Concepts exercised:** Mission, Execution, Evidence, Artifact, Timeline. Team/Team Member.

**Finding — a real gap, not a confirmation:** **Decision never appears in this scenario.** Because the branch is unprotected, nothing forces an approval gate, and the developer's "glance" produces no domain record at all. If Decision only ever gets created at a protected-branch merge gate, then most of a solo developer's actual day-to-day work — which happens on feature branches, merged rarely — **never produces a Decision**, and the Trust Ledger (P-004, the entire foundation of differentiator #1) stays sparse. This is the most important finding across all seven scenarios. See "Cross-Cutting Findings" below.

### Architectural Invariants

- A Mission's terminal status is derived from the aggregate outcome of its Executions — it is never a field independently set by convenience.
- Evidence is captured for every tool call during an Execution regardless of whether a Decision is ever produced downstream. Evidence capture is not conditional on an approval gate existing.
- Artifact assembly is an Execution Engine responsibility, never a Provider Adapter one (AT #1, #8) — the diff bundle is git-computed, not provider-reported (AT #4).
- The absence of a Binding Decision does not mean the absence of Mission history. Evidence and Artifacts exist independently of whether any Decision was ever recorded.

### Failure Modes

- Treating "no approval gate hit" as "nothing worth recording" — silently skipping Evidence or Artifact capture on unprotected branches because "nobody's going to look at it anyway."
- Provider Adapter deciding Team composition instead of receiving it as a Mission Engine policy decision (AT #7).
- A future Lightweight Decision implementation becoming mandatory-feeling in the UI — recreating exactly the friction/gate this scenario shows must not exist on unprotected branches.

### Open Questions

- What does a one-click Lightweight Decision actually look like for this exact flow — is it a passive prompt after every Execution, or does the developer have to seek it out? (Still open — Cross-Cutting Finding #1.)
- Does a solo developer on an unprotected branch ever need a full Review (not just a Decision) without a protected-branch merge in sight?

**Validates:** AT #1 (no Claude Code-specific language required to describe this flow), AT #4 (diff bundle implied git-computed).

---

## Scenario 2: Fix a bug

**Setup:** A null-pointer exception in the checkout flow, fixed directly against a protected branch (hotfix).

**Walkthrough:**
1. Mission created — brief includes a reference (a pasted stack trace / error log). Team: Developer, QA.
2. Execution #1: Developer locates and patches the bug, QA adds a regression test. Evidence captured throughout.
3. Execution attempts to merge into the protected branch → the Provider Adapter's hook enforcement blocks the merge tool call. Execution #1 ends; Mission status → `awaiting-approval`.
4. Developer reviews the diff via AgentSpace, approves. Decision (type: Approval) created, linked to Execution #1's Artifacts.
5. Execution #2 starts (a resume, not a fresh Mission), now permitted to merge, completes. Mission status → `completed`.

**Concepts exercised:** Mission, Execution (1:many — two Executions for one Mission), Evidence, Artifact, Decision (Approval), Timeline.

**Finding:** The stack trace/error log fed into the brief is external reference material, not something *this* Mission produced — it doesn't fit "Artifact" (an output) or "Evidence" (a process record of what the Mission did). For now this is just an attachment on the brief, not a new domain concept — but flagging it, since a pattern of Missions needing rich external input material could eventually justify one (see "Concepts Tested and Not Adopted" for the parallel case of Deliverable).

### Architectural Invariants

- Every Execution belongs to exactly one Mission; a Mission accumulates Executions without losing continuity of its own identity (a Mission never changes identity when resumed).
- A blocked merge attempt terminates the Execution cleanly — it never corrupts or discards the Evidence/Artifacts that Execution already produced.
- A Binding Decision is always linked to specific Artifacts from a specific Execution; it never exists unattached.
- Mission Engine decides *that* the branch is protected and merging requires approval; Provider Adapter only *enforces* that decision via the hook response (AT #7).

### Failure Modes

- Modeling "resume" as reusing Execution #1's record and appending to it, instead of creating a genuinely new Execution — this fabricates history and violates the immutability of a completed Execution.
- Storing the pasted stack trace as an Artifact because it's convenient to attach it to the same list — misclassifies external reference material as Mission output.
- Provider Adapter independently deciding the merge is risky (instead of just enforcing a policy handed to it by Mission Engine) — a mechanism-leaking-into-policy violation (AT #7).

### Open Questions

- Does rich external reference material (stack traces, tickets, design docs) ever need to become a first-class domain concept, or does it stay an attachment to the brief indefinitely?
- What happens if Execution #2 — the resume — itself hits a second, different block? Does the Mission accumulate a third Execution, or is there a retry ceiling?

**Validates:** AT #7 (policy/mechanism boundary at the hook-enforced merge block), AT #4 (approval is over a git-computed diff, not a provider checkpoint).

---

## Scenario 3: Refactor a module

**Setup:** A larger, higher-risk change — extracting a shared service out of two callers — targeting a protected branch. Team: Developer, Reviewer.

**Walkthrough (revised 2026-07-30 — see "Revision note" below for what changed and why):**
1. Mission created. Execution #1: Developer performs the refactor across several files.
2. Reviewer Team Member examines the Artifacts *within the same Execution*, produces a Review — flags a Finding (a call site was missed) and concludes with a Recommendation: `iterate`.
3. Mission Engine's own policy acts on the `iterate` Recommendation autonomously — no human is involved at this point. A new Execution (#2) starts under the *same* Mission — Developer fixes the missed call site.
4. Reviewer reviews again — this time examining the Mission's accumulated result across both Executions — and this pass is clean (zero Findings). Recommendation: `approve`.
5. Execution #3 attempts the merge into the protected branch. The Provider Adapter's hook enforcement blocks it at the gate. The human reviews the diff (informed by the Reviewer's `approve` Recommendation, but not bound by it) and issues a Decision: `approved`. Execution #3 resumes and completes the merge. Mission → `completed`.

**Concepts exercised:** Mission, Execution (three, under one Mission), Evidence, Artifact, Review (AI-originated, Mission-scoped — spans Executions #1 and #2 by the final pass), Finding, Recommendation, Decision, Timeline.

**Finding — a real gap (original, 2026-07-28):** the Mission/Decision model as written only distinguished approve vs. reject. This scenario needed a third outcome that loops back into a new Execution under the same Mission rather than ending it. The 1:many Mission→Execution relationship already modeled this correctly in shape — but something in the outcome vocabulary was incomplete.

**Revision note (2026-07-30):** the original resolution to the above (a third Decision outcome, `request-changes`) was itself found to be wrong during later domain discovery — it let an AI Review "become" a Decision, directly contradicting Decision's "always human" invariant (`20-UBIQUITOUS_LANGUAGE.md`). The corrected resolution, reflected in the walkthrough above: the missing signal was never a Decision outcome at all. It's a **Recommendation** outcome (`iterate`), and it drives an autonomous Mission Engine policy loop — consistent with "Autonomous Team, avoid interrupting execution" (`00-VISION.md`) — with no human touchpoint until the actual merge attempt. Decision's outcome vocabulary reverts to a strict binary (`approved | rejected`). Full reasoning in `02-DOMAIN.md`, "Review, Finding, Recommendation."

### Architectural Invariants

- Decision outcomes are a closed, two-valued set (`approved | rejected`) at the Binding tier — no ad hoc outcome values are ever introduced outside this vocabulary, and no Decision outcome ever represents a mid-Mission, non-merge-gate signal.
- `iterate` (a Recommendation outcome) always produces a new Execution under the *same* Mission via Mission Engine's own policy, never a human action; it never terminates the Mission and never spawns a separate Mission.
- A Review can originate from an AI Team Member and can never, under any circumstance, become or produce a Decision — only a human produces a Decision.
- A Review is Mission-scoped: it may examine Artifacts accumulated across more than one Execution, not only the most recent one.

### Failure Modes

- **An AI Review or Recommendation auto-resolving into a Binding Decision without an intervening human action.** This is not a hypothetical — it's exactly what the original (2026-07-28) version of this scenario implied, and exactly what motivated the revision above. If an implementation ever lets `iterate` or `approve` (Recommendation values) directly write a Decision record, that is a direct violation of "Humans stay in control" (`00-VISION.md`).
- Modeling `iterate` as a Mission-ending state that a *new* Mission then resumes from — this would silently change the 1:many Mission→Execution shape into a 1:1 Mission→Mission chain, contradicting the very relationship this scenario exists to validate.
- Treating the Reviewer's Review as equivalent in weight to the human's eventual approval — collapsing "assessment/advice" and "resolving verdict" back into one concept, which `20-UBIQUITOUS_LANGUAGE.md` explicitly keeps distinct (Review/Recommendation vs. Decision).
- Scoping a Review to a single Execution by default — would make it impossible to represent the final, accumulated-result review this scenario's step 4 depends on.

### Open Questions

- Is there a limit to how many `iterate` cycles a Mission can accumulate before some other resolution (escalation, forced human check-in, rejection) kicks in? **Not resolved by this document** — flagged during the Domain Discovery stress test as a real, un-bounded-autonomy risk symmetric to Scenario 7's Mission-spawning risk, and explicitly left for `03-ARCHITECTURE.md` to answer as a Mission Engine policy parameter, not a new domain concept.
- Should a high-severity Finding (e.g., a security concern) ever force a human touchpoint mid-Mission, ahead of the merge gate, regardless of branch protection? **Resolved, not open:** no — `01-PRD.md`'s non-goals explicitly rule out any custom risk-scoring model beyond branch protection ("Hard lines, not settings"). Severity-driven escalation was considered during discovery and rejected as out of v1 scope on those grounds.
- Can a human override a Reviewer's `iterate` Recommendation and approve the Mission's current state anyway, skipping the autonomous fix cycle? Not exercised here.

**Validates:** AT #10 (three Executions under one Mission — a real 1:many relationship, not flattened into a linear pipeline), AT #7 (the policy/mechanism boundary now holds cleanly: Mission Engine's own policy handles `iterate` entirely, Provider Adapter only enforces the merge-gate hook at the human-facing Binding Decision).

---

## Scenario 4: Mission paused for approval

**Setup:** Isolating the approval-gate mechanism itself, independent of any specific feature work.

**Walkthrough:**
1. Execution reaches a merge attempt into a protected branch mid-run.
2. The Provider Adapter's hook enforcement synchronously denies the tool call (hooks can't hold a process open indefinitely waiting on arbitrary human deliberation time). The Execution ends as a result — it does not sit blocked mid-process.
3. Mission status → `awaiting-approval`. This becomes the concrete "what needs me" queue entry from `01-PRD.md`.
4. The Mission sits in this state indefinitely — hours, days — with no running process consuming resources or quota.

**Concepts exercised:** Mission, Execution, Decision (pending).

**Finding:** confirms an important technical/domain point that wasn't explicit before: **a pause-for-approval is not a suspended process, it's a terminated Execution plus a Mission-level state.** This matters for T-004/T-007 (`16-ASSUMPTIONS.md`) — an awaiting-approval Mission consumes zero subscription quota while it waits, however long that is.

### Architectural Invariants

- `awaiting-approval` is a Mission-level status. It is never encoded as a property of an Execution, because the Execution that hit the gate has already ended.
- No process remains alive while a Mission is `awaiting-approval` — zero subscription quota is consumed regardless of how long the wait is (T-004, T-007).
- Provider Adapter enforcement of a merge-gate policy is synchronous and terminates the Execution; it never blocks a tool call open waiting on human deliberation time.

### Failure Modes

- **Implementing pause as a suspended/sleeping process** (e.g., holding a subprocess or session open, polling for approval) instead of a terminated Execution plus Mission state — this directly contradicts the finding this scenario exists to record, and reintroduces a quota-consumption problem T-004/T-007 were validated against.
- Storing `awaiting-approval` as an Execution field — breaks the shape Scenario 5 depends on (resume = new Execution, not resurrecting the old one).
- Provider Adapter deciding *whether* the branch is protected, instead of only enforcing a policy decision hand ed to it by Mission Engine (AT #7).

### Open Questions

- How long can a Mission realistically sit `awaiting-approval` before the underlying diff goes stale (upstream changes, merge conflicts)? Staleness detection is not modeled here.
- With multiple concurrent Missions (P-003), is there any queuing or prioritization concept for simultaneous approval gates, or does each just sit independently in the "what needs me" queue?

**Validates:** AT #7 (policy decided by Mission Engine, enforced by Provider Adapter), and indirectly AT #6 (a Mission sitting idle with zero resource cost is a durability/trust property, not just a UI state).

---

## Scenario 5: Mission resumed

**Setup:** Continuation of Scenario 4, plus a second, distinct trigger — a developer manually pausing a long-running Mission overnight (not an approval gate at all) and resuming it the next morning.

**Walkthrough:**
1. Approval-triggered resume: human approves → Execution N+1 starts via a provider-level session resume, continuing with the prior context, now permitted to proceed.
2. Human-initiated pause/resume: developer explicitly stops a Mission mid-work for their own reasons, resumes it later. Same shape — a new Execution, same Mission.

**Concepts exercised:** Mission, Execution.

**Finding:** confirms that **Execution doesn't need to know or encode *why* the prior Execution ended** — that reason lives in the Mission's state/Decision history, not in the Execution entity itself. Good sign the model is well-factored here; no gap found.

**Relationship to Scenario 4:** this scenario is deliberately kept as its own numbered entry, since `02-DOMAIN.md` cross-references it by number and other documents may too — renumbering to merge them would break traceability for a documentation-hygiene gain that isn't worth the cost. But conceptually, Scenarios 4 and 5 validate **one mechanism** (the pause/resume cycle), not two independent ones: 4 proves the "pause" half terminates cleanly with no live process; 5 proves the "resume" half starts a genuinely new Execution regardless of *why* the pause happened. Read them as a pair.

### Architectural Invariants

- Execution never encodes *why* the previous Execution ended — that fact lives exclusively in the Mission's state/Decision history.
- Resuming a Mission always creates a new Execution row; it is never a mutation or reactivation of a terminated one.
- Provider-level session resume (continuing prior context) is a Provider Adapter mechanism detail — the domain model only sees "a new Execution started under this Mission," regardless of how much prior context the provider preserves underneath.

### Failure Modes

- Encoding a pause-reason field on the Execution entity — directly contradicts this scenario's own finding and recouples Execution to a concept (why did the prior attempt stop) that belongs to Mission/Decision history.
- Treating approval-triggered resume and human-initiated pause/resume as needing separate domain models "because they're triggered differently" — the finding explicitly says they share one shape; building two code paths for this would fragment the model without a domain reason (AT #3).
- Assuming provider-level context continuity (session resume) is a domain guarantee — if a future provider can't resume context the way Claude Code can, the domain model must not break, because Execution never promised context continuity as a domain-level fact.

### Open Questions

- Does a human-initiated pause need its own lightweight record — "why did this sit idle for 6 hours" — or is silence about human-initiated pause reasons acceptable? Not answered by this scenario.
- If a provider *cannot* resume prior context (a future, less-capable provider), does the new Execution start genuinely fresh, and does the domain model need to represent "resumed with degraded continuity" at all?

**Validates:** AT #8 (provider-level session resume is explicitly kept out of Mission/Execution Engine, confined to Provider Adapter — this is the scenario's central point).

---

## Scenario 6: Mission rejected

**Setup:** The refactor from Scenario 3, but the human disagrees with the whole approach after seeing the diff, not just wanting a tweak.

**Walkthrough:**
1. Execution completes, Artifacts assembled, Review (if any) attached.
2. Human Decision: **reject** — not "needs changes," a substantive "no, don't merge this at all."
3. What happens to the Mission's terminal status?

**Concepts exercised:** Mission, Decision.

**Finding — a real gap:** the Mission state model (`02-DOMAIN.md`) only has `completed | failed | cancelled` as terminal states. **None of these correctly describe "the AI executed successfully and produced working Artifacts, but a human substantively rejected the output."** That's not a technical failure (`failed`), not an abandoned run (`cancelled`), and calling it `completed` erases the fact that it was rejected. This distinction matters more than it might look — it's precisely the signal the Trust Ledger (P-004) needs to differentiate "the AI failed to execute" from "the AI executed fine but the output wasn't wanted," which are very different patterns to learn from. **`rejected` needs to be its own terminal Mission status.**

### Architectural Invariants

- The Mission terminal-status vocabulary must distinguish "AI succeeded, human declined the output" (`rejected`) from technical failure (`failed`) and from abandonment (`cancelled`). These three are never conflated for storage or reporting convenience.
- A `rejected` Mission retains its Artifacts and Evidence in full — rejection is a Trust Ledger signal, not a deletion or rollback event.
- Rejection is itself a permanent, immutable fact in the Mission Graph — it is never later mutated or "undone" by a subsequent action; a changed mind produces a new Mission, not an edit to the old Decision.

### Failure Modes

- Collapsing `rejected` into `failed` anywhere downstream (reporting, Trust Ledger queries, dashboards) "because they're both terminal-and-not-completed" — this silently destroys exactly the signal P-004 depends on.
- Deleting or discarding a rejected Mission's Artifacts from storage to save space — the Trust Ledger's value depends on the rejected work still being inspectable later, not just the fact that a rejection happened.
- Treating a human's rejection as something that can be "reopened" by editing the original Decision, instead of the human starting a genuinely new Mission if they change their mind.

### Open Questions

- Can a `rejected` Mission ever spawn a follow-up Execution the way `request-changes` does, or is `rejected` always fully terminal with no path back under the same Mission? The current model implies fully terminal, but this scenario doesn't test that boundary explicitly.
- What is the working-tree/git consequence of rejection — is the worktree discarded, the branch deleted, or does the rejected diff remain reachable in git history independent of the Mission Graph record?

**Validates:** AT #10 (rejection as a distinct outcome preserves a real signal rather than flattening two different failure shapes into one linear "not completed" bucket).

---

## Scenario 7: Mission that triggers another Mission

**Setup:** During Review of the refactor Mission (Scenario 3), the Reviewer notices the extraction reveals an unrelated latent bug in a different module.

**Walkthrough:**
1. Reviewer's Review contains an observation pointing outside the current Mission's scope.
2. Should a new Mission for the latent bug start automatically? Following "Autonomous Team, avoid interrupting execution" naively would say yes — but this conflicts hard with "Humans stay in control": an AI autonomously spawning new Missions from its own observations, unbounded, is exactly the kind of runaway chain that principle exists to prevent.
3. Instead: the observation becomes a **proposed** Mission — drafted (brief, suggested Team) but not started, sitting for human confirmation.
4. Human confirms it → the proposal becomes a real, `queued` Mission, linked to the original via a `triggered-by` edge in the Mission Graph.

**Concepts exercised:** Mission, Review, Decision, Mission Graph (the inter-Mission edge this scenario needed is exactly why "Mission Graph" replaced "Execution Graph" — this relationship spans two Missions, not one Mission's internal structure).

**Finding — a real gap:** the Mission state model has no state before `queued`. A Mission proposed by an AI Team Member's own observation needs to exist somewhere before a human has authorized it to run. This is a genuinely new concept: **Mission Proposal** (or a `proposed` status preceding `queued`) — not a full new entity necessarily, but a state the current model doesn't have room for.

### Architectural Invariants

- No AI Team Member action can create a `running` or `queued` Mission without an intervening human confirmation step. Autonomy stops at *proposing*, never at *starting*.
- `proposed` is a distinct Mission state with no Executions of its own — a proposal is a draft (brief + suggested Team), not a Mission that has begun any work.
- `triggered-by` is a Mission Graph edge connecting two distinct Missions; it is never modeled as an internal relationship within a single Mission's Executions.

### Failure Modes

- An AI observation directly enqueuing a new Mission without a human confirming it first — the exact runaway-chain risk this scenario exists to prevent, and a direct violation of "Humans stay in control."
- Modeling a Mission proposal as a special kind of Execution or Artifact (e.g., "a suggestion artifact") instead of a Mission-level state — this blurs Mission's own lifecycle and makes `proposed → queued` harder to reason about as a state transition.
- Treating `triggered-by` as equivalent to `request-changes`'s new-Execution-under-same-Mission loop (Scenario 3) — they are structurally different: one stays inside a Mission, the other spans two Missions via a graph edge. Conflating them would collapse Mission Graph back toward "Execution Graph," which was explicitly rejected.

### Open Questions

- Can a `proposed` Mission expire or be silently dropped, or does it persist indefinitely until a human explicitly confirms or dismisses it?
- Is there any depth or rate limit on triggered Missions — can a triggered Mission's own Review propose yet another Mission, and if so, unbounded? "Humans stay in control" argues for a limit, but none is defined here.
- Who owns the suggested Team on a proposal — is it binding once confirmed, or can the human edit the Team before the proposal becomes `queued`?

**Validates:** AT #10 (Mission Graph as a real graph, not a linear execution history — this scenario is the reason the concept was renamed from "Execution Graph").

---

## Bonus Scenario 8: Trust Ledger changes a real decision

**Setup:** Stress-testing whether Trust Ledger does real work, not just decorative logging — none of the first seven scenarios exercise it as an active participant, only as a passive recipient of Decisions.

**Walkthrough:**
1. A new Mission touches billing code.
2. Trust Ledger surfaces a pattern to the human before they decide: "3 of the last 4 Missions touching billing code were rejected or needed changes."
3. This measurably changes the human's behavior — they look more closely than they otherwise would have, or reject faster with more confidence.

**Concepts exercised:** Trust Ledger, Decision, Mission Graph.

**Finding:** this scenario only works at all if Decision records exist broadly enough to have accumulated a pattern — which loops directly back to the Scenario 1 finding. If Decisions are only generated at protected-branch gates, this pattern would take far longer to accumulate (or never accumulate for solo devs who rarely merge to protected branches directly), materially weakening P-004's payoff.

### Architectural Invariants

- Trust Ledger holds no independent state of its own — it is strictly a query/projection over existing Decision nodes and their linked Evidence/Artifacts in the Mission Graph (`02-DOMAIN.md`: "Timeline and Trust Ledger are projections over the Mission Graph, not separate data stores").
- Trust Ledger surfacing a pattern never itself creates, blocks, or resolves a Decision — it informs a human's judgment; it does not substitute for it.

### Failure Modes

- **Trust Ledger caching or duplicating Decision data into its own store** "for query performance" — the moment Trust Ledger has state that can drift from the Mission Graph, it stops being a projection and becomes a second, potentially inconsistent source of truth (AT #10's warning about pipeline-izing an aggregation applies directly here).
- Trust Ledger's pattern-surfacing silently auto-applying a consequence (e.g., auto-flagging or auto-rejecting billing-code changes because of history) instead of just informing the human who still decides — this would violate "Humans stay in control" the same way an unbounded auto-triggered Mission would (Scenario 7).
- Treating Trust Ledger as a terminal pipeline stage a single Mission "arrives at," instead of a cross-Mission, cross-Project aggregation with no single-Mission endpoint (explicitly the point `02-DOMAIN.md` makes about why "Execution Graph" was rejected as a name).

### Open Questions

- What is the actual pattern-detection threshold/algorithm behind "3 of the last 4"? Not specified anywhere — currently illustrative, not a designed mechanism.
- `20-UBIQUITOUS_LANGUAGE.md` defines Trust Ledger as aggregating "across every Mission, every Project" — but `02-DOMAIN.md` describes Workspace (the container above Project) as "largely organizational... not an entity with much identity of its own in v1." Is cross-Project Trust Ledger aggregation actually in v1 scope, or does this scenario implicitly assume more than the PRD's non-goals allow? Not resolved here.

**Validates:** AT #10 (Trust Ledger as aggregation, never flattened to a pipeline step) directly; AT #6 (does surfacing more information increase trust or just increase on-screen detail — this scenario is the closest thing to a real test of AT #6 in the suite, though it's asserted, not proven).

---

## Cross-Cutting Findings

### 1. Decision must not be coupled solely to the protected-branch gate

This is the single most important finding, surfaced independently by Scenarios 1 and 8. If "Decision" only exists as the mandatory approval gate, the Trust Ledger — the foundation of differentiator #1 — starves on exactly the workflow (solo dev, feature branches, infrequent protected merges) that v1 is built for. **Proposed resolution, for `02-DOMAIN.md` to formalize:** Decision needs two tiers —

- **Binding Decision** — the mandatory Approval/Rejection gate at a protected-branch merge. Blocks; always human; always recorded.
- **Lightweight Decision** — an optional, low-friction acknowledgment a human can leave on any Mission's Artifacts, even on unprotected branches (e.g., a single click: "good," "not what I wanted," "needs a look later"). Non-blocking, not mandatory, but the thing that keeps the Trust Ledger fed during the everyday work that never touches a protected branch.

This isn't decided yet — it's flagged as the clearest concrete question to resolve before `03-ARCHITECTURE.md`, since it changes what the UI has to make trivially easy (a one-click lightweight Decision) versus what it can afford to make more deliberate (a binding Approval).

### 2. Mission state model needs two additions

- **`rejected`** as a distinct terminal status, alongside `completed | failed | cancelled` (Scenario 6).
- **`proposed`**, a state before `queued`, for AI-originated Mission suggestions awaiting human confirmation (Scenario 7).

### 3. Decision outcome vocabulary needs a third value — **SUPERSEDED, 2026-07-30**

Original claim: not just approve/reject — `request-changes`, looping into a new Execution under the same Mission rather than ending it (Scenario 3, as originally written). **This was resolved to the wrong concept.** A full Domain Discovery pass (triggered by Finding #5 below) found that `request-changes` was never a Decision-shaped thing — it's a **Recommendation** outcome (`iterate`) that drives an autonomous Mission Engine policy loop, with no Decision or human involved. Decision's outcome vocabulary is a binary (`approved | rejected`) at the Binding tier, full stop. See `02-DOMAIN.md`, "Review, Finding, Recommendation," and the revised Scenario 3 above. Left here, struck through in spirit rather than deleted, so the discovery trail — including the wrong turn — stays visible.

### 4. A pause-for-approval is a terminated Execution, not a suspended process

Worth stating explicitly for `03-ARCHITECTURE.md`: no process sits alive consuming quota while `awaiting-approval` (Scenario 4) — confirmed compatible with T-004/T-007.

### 5. Unresolved: who is allowed to turn an AI Review into a request-changes Decision — **RESOLVED, 2026-07-30**

Original tension: `20-UBIQUITOUS_LANGUAGE.md` says Binding Decision is "always human," but Scenario 3's walkthrough (as originally written) let an AI Reviewer's Review "become" a `request-changes` Decision without an explicit human step. **Resolved via a dedicated Domain Discovery session, then a Consolidation pass, then a Domain Freeze Review** (2026-07-30): the answer is neither of the two options this finding originally posed. No human ratification step was elided, and no third Decision type was needed. The Review/Decision boundary itself was the thing to fix: AI produces Evidence, Artifacts, Reviews, Findings, and Recommendations — never a Decision, under any framing. What looked like an AI-originated "blocking mid-Mission Decision" is fully and cleanly represented by a Recommendation (`iterate`) triggering autonomous Mission Engine policy, with the first and only Decision appearing at the actual merge-gate attempt. See `02-DOMAIN.md` for the full resolution and Scenario 3 above for the corrected walkthrough. **The domain has since been declared frozen** — this item is closed, not carried forward.

---

## Domain Coverage Matrix

Not documentation — a diagnostic. Read it for concepts that are never exercised, underrepresented, or appearing in so many places the concept may be overloaded (see "Hidden Concepts" below).

| Concept | Scenarios | Coverage |
|---|---|---|
| Mission | 1, 2, 3, 4, 5, 6, 7, 8 | Strong — every scenario touches Mission, as expected of the root concept. |
| Execution | 1, 2, 3, 4, 5 | Strong through Scenario 5; absent from 6, 7, 8 because those scenarios operate at the Decision/Mission-Graph level, which is consistent with Execution's scope. |
| Evidence | 1, 2, 3 | **Weak.** Named explicitly only in the first three scenarios, never again — no scenario tests Evidence's role in grounding a Reasoning Summary, its stated primary responsibility. |
| Artifact | 1, 2, 3, 6, 7 (via Review), 8 (via Decision link) | Adequate, but always as a passive object being reviewed — no scenario tests what happens when an Artifact itself is disputed or found wrong after approval. |
| Review | 3, 6 (implied), 7 | **Weak and inconsistent.** Only Scenario 3 gives Review real narrative weight; Scenario 6 only implies one exists ("if any"). |
| Finding | 3 | **Added 2026-07-30, single-scenario coverage.** Only Scenario 3 exercises it, and only in the "clean pass has zero Findings" and "one Finding triggers iteration" shapes — never in the multi-Finding or multi-reviewer case. Consistent with its v1 status as a Value Object, not a gap that blocks the freeze, but worth a future scenario if Finding is ever promoted to first-class identity. |
| Recommendation | 3 | **Added 2026-07-30, single-scenario coverage.** Same caveat as Finding — only `iterate` and `approve` are exercised; `reject-suggested` has zero scenario coverage anywhere in this suite. |
| Decision | 2, 3, 6, 7, 8 | Strong, but concentrated on Binding Decision — Lightweight Decision (the resolution proposed in Cross-Cutting Finding #1) has **zero** scenario coverage of its own shape, only of the gap it's meant to fill. Outcome vocabulary corrected 2026-07-30 to a strict binary (see Cross-Cutting Finding #3). |
| Timeline | 1 (named), otherwise implicit at best | **Very weak.** Listed as an exercised concept only once, despite being one of two named projections over the Mission Graph. |
| Mission Graph | 7, 8 (explicit), implicit substrate elsewhere | Adequate for the inter-Mission edge case it was designed for (Scenario 7); the intra-Mission structure is never explicitly walked as a graph query. |
| Trust Ledger | 8 only | Expected — Trust Ledger is explicitly cross-Mission, so a single bonus scenario is proportionate, but it means Trust Ledger has exactly one scenario standing between it and being untested. |
| Team / Team Member | 1, 3; implied but unlisted in 2 | Inconsistently tracked in "Concepts exercised" — a documentation hygiene issue this matrix now corrects, not a domain gap. |
| Reasoning Summary | **none** | **Zero coverage.** A core AgentSpace-owned capability (T-003, Medium risk) with no scenario exercising its grounding-in-Evidence requirement at all. |
| Approval | 2, 3 (as a Decision subtype) | Never tested as distinct from Decision — always folded into "Decision (Approval)," consistent with its definition but never independently exercised. |

**Reading the matrix:** the two starkest gaps are **Reasoning Summary** (never touched) and **Timeline** (touched once, nominally). Both are worth a dedicated scenario before `03-ARCHITECTURE.md` treats their data shape as settled — per the instruction that produced this suite, that's noted here as a finding, not fixed by inventing a ninth scenario for completeness' sake.

---

## Architectural Tests Cross-Check

Cross-referencing each scenario against `19-ARCHITECTURAL_TESTS.md`. A test with no scenario next to it is a real gap: nothing in this suite would currently catch a violation of it.

| AT # | Test | Validated by |
|---|---|---|
| 1 | Explainable without naming Claude Code | All scenarios (written in provider-neutral language throughout — Provider Adapter is named, Claude Code is not, except in Findings discussing implementation). |
| 2 | Five-year test (more/less valuable as Claude Code improves) | **Not scenario-testable** — this is a standing design question, not a runtime behavior a walkthrough can exercise. No gap; different kind of test. |
| 3 | Domain-justified abstraction, not implementation-justified | Scenario 5 (Failure Modes: rejecting a two-code-path split between approval-resume and human-resume for lack of domain justification). |
| 4 | Git remains single source of truth for diffs | Scenario 1, Scenario 2 (implicit — diff bundle and Approval are both over a git-computed diff, never a provider checkpoint). |
| 5 | Abstraction earning its cost today, not "just in case" | **No scenario directly validates this** — a real gap. Worth a scenario stress-testing a proposed-but-unused seam (e.g., is Lightweight Decision's design earning its cost yet, or speculative until Cross-Cutting Finding #1 is resolved?). |
| 6 | Increases trust, not just on-screen information | Scenario 8 (closest fit — asserted, not proven; see its Open Questions). |
| 7 | Policy (Mission Engine) vs. mechanism (Provider Adapter) boundary | Scenario 2, Scenario 3 (partially — see the unresolved Review-to-Decision question), Scenario 4. |
| 8 | Second-provider-tomorrow test | Scenario 5 (provider-level session resume confined to Provider Adapter). |
| 9 | Durability claims not dependent on something we don't control | **Not exercised by any scenario.** This is the same gap the "Open Question Carried Into Architecture" (below) already names — an external bypass of the tracked flow (manual `git merge`) is exactly an AT #9 failure, but no scenario in this suite walks through it. Worth a Scenario 9 someday, but per this exercise's own instruction, not manufactured here just for completeness. |
| 10 | Real graph/1:many not flattened for convenience | Scenario 3 (three Executions, one Mission), Scenario 6 (rejected as a distinct outcome, not flattened into failed), Scenario 7 (Mission Graph as the reason for the Execution Graph → Mission Graph rename), Scenario 8 (Trust Ledger as aggregation, not pipeline stage). |

**Reading the table:** AT #5 and AT #9 have no scenario coverage at all. AT #9 in particular is not a hypothetical gap — it's the same unresolved bypass question already flagged at the bottom of this document, now explicitly connected to the architectural test it corresponds to.

---

## Ubiquitous Language Cross-Check

Every term used across the eight scenarios and their new sections was checked against `20-UBIQUITOUS_LANGUAGE.md`.

- **No unofficial vocabulary found** in the original scenario text — Setup/Walkthrough/Concepts/Findings consistently use canonical terms (Mission, Execution, Evidence, Artifact, Review, Decision, Mission Graph, Timeline, Trust Ledger) and correctly avoid forbidden synonyms (no "Task," "Agent," "Subagent," "Deliverable," etc.). Finding and Recommendation, added 2026-07-30, are used in Scenario 3 exactly as defined in `02-DOMAIN.md`/`20-UBIQUITOUS_LANGUAGE.md` — no drift on introduction.
- **Real inconsistency found — RESOLVED, 2026-07-30, see Cross-Cutting Finding #5 above.** Scenario 3 originally let an AI Review "become" a Decision without an explicit human action, conflicting with Binding Decision's "always human" definition. Resolved via a dedicated Domain Discovery → Consolidation → Freeze Review sequence; Scenario 3's walkthrough has been corrected accordingly.
- **One cross-document inconsistency found, outside this file's own scope but worth recording here since this is where it surfaced:** `00-VISION.md`'s example Team roles list "Tester," while `02-DOMAIN.md`, `20-UBIQUITOUS_LANGUAGE.md`, and every scenario in this document use "QA." Neither document lists the other as a forbidden synonym. This is a Vision/Domain divergence, not a scenario error — recorded here, resolution belongs in `20-UBIQUITOUS_LANGUAGE.md`.
- **One stale term found in `02-DOMAIN.md` itself, also outside this file's scope:** the Artifact definition still says artifacts are "referenced from Execution History events" — but "Execution History" was explicitly superseded by "Mission Graph" earlier in the same document. Flagged for `02-DOMAIN.md` cleanup, not corrected here.
- No concept in this document has overlapping names, and no scenario introduces a term that isn't already defined.

---

## Hidden Concepts / Overload Check

Actively probing whether the current model has quietly overloaded a concept, per the instruction behind this revision. Two real candidates surfaced; both are recorded as open tension, not resolved by inventing a new concept — per this exercise's own rule, a new concept is only proposed if multiple scenarios independently point to it, and neither of these clears that bar yet.

- **Is Decision overloaded across "gate mechanism" and "resolving verdict"? — RESOLVED, 2026-07-30.** This was the live question when this section was first written (Cross-Cutting Finding #5). The resolution: Decision was never overloaded — the mid-Mission "this needs another pass" signal that looked like it belonged to Decision was always a **Recommendation**, not a Decision at all. No third Decision shape exists. See `02-DOMAIN.md`, "Review, Finding, Recommendation."
- **Is Mission Graph doing double duty as both "the durable data structure" and "the thing scenarios reach for whenever no other concept fits" (e.g., Scenario 7's `triggered-by` edge, Scenario 8's cross-Mission aggregation substrate)?** Reviewed against all eight scenarios: no, this one holds up. Every use of Mission Graph in this suite is consistent with its single definition (the persistent structure, never a separate store) — Timeline and Trust Ledger both correctly stay projections *over* it rather than becoming their own graphs. No overload found here.
- **Artifact was checked for the "intermediate vs. final output" overload risk** (the same shape as the already-rejected "Deliverable" concept) — no scenario in this suite exercises a case where an intermediate Artifact needs different treatment from a final, reviewable one. Consistent with the original rejection of Deliverable; no new evidence for it surfaced by this pass.
- **No missing aggregate/bounded context emerged** from this pass beyond the already-deferred "Objective" concept (grouping related Missions) — nothing in the new Invariants/Failure Modes/Open Questions sections independently points toward a concept "Objective" wouldn't already cover, so it stays deferred to v2 as originally decided.

---

## Concepts Tested and Not Adopted

The exercise specifically tried to surface new concepts (per the instruction that prompted this doc) — two candidates came up and were deliberately rejected rather than silently ignored:

- **"Deliverable"** — hypothesized as distinct from Artifact (a more "final/packaged" output versus an intermediate one). Tested against all seven scenarios: every case where a "deliverable" would apply is already served by Artifact (a diff-as-a-reviewable-unit already functions as the thing a human consumes as the point of the Mission). **Rejected as redundant.** Re-checked during the 2026-07-30 validation pass (see "Hidden Concepts" above) — still holds.
- **"Objective"** — a concept grouping several related Missions toward one larger goal (e.g., "ship CSV export" spanning a feature Mission, a bugfix Mission, and a docs Mission). This is a *real* concept the domain plausibly needs — but not in v1. It's an organizational/reporting concept that matches the scope explicitly excluded by the solo-developer, single-Mission-focus MVP (`01-PRD.md` non-goals). **Deferred to v2, not adopted now** — worth revisiting once multiple related Missions in practice make the lack of grouping actually felt, not before.
- **"Finding" as a first-class, independently-identified entity** — added 2026-07-30. During the Review/Finding/Recommendation discovery, Finding was initially promoted to its own identity (to support tracking "this specific issue was fixed" via a graph edge). Re-examined during the Domain Consolidation pass: no scenario in this document actually exercises that capability, and the Trust Ledger's stated v1 payoff (`01-PRD.md`) operates at Mission-level granularity, not per-Finding. **Demoted to a Value Object for v1** — a structured item inside a Review's list, no independent identity. Promotion to a first-class entity is a plausible v2 move if per-issue resolution tracking is ever actually built, the same deferral shape as "Objective" above.

## Open Question Carried Into Architecture

**How does AgentSpace record a Decision if a human bypasses it entirely** — e.g., manually running `git merge` into a protected branch from a terminal, outside any AgentSpace-initiated Execution? If the "system of record" thesis is honest, a gap here is a real gap, not an edge case to wave away: the record needs to at least detect and log "an external change occurred outside the tracked flow," even if it can't capture the reasoning behind it. This likely means AgentSpace needs its own git-level hooks (distinct from Claude Code's hooks) watching the repository directly, not just Claude Code's execution. Recorded as a new technical assumption below rather than assumed away.

This is now formally connected to **AT #9** (durability claims must not depend on something we don't control) via the Architectural Tests Cross-Check above — it is the one concrete example in this entire suite of an architectural test with no scenario currently validating it, and the clearest candidate for a future Scenario 9 when this suite is revisited rather than treated as permanently closed.

---

## Domain Status: Frozen (2026-07-30)

This document, `02-DOMAIN.md`, and `20-UBIQUITOUS_LANGUAGE.md` were taken through a full Domain Discovery → Consolidation → Freeze Review sequence culminating 2026-07-30. Every concept in the model — Mission, Execution, Evidence, Artifact, Review, Finding, Recommendation, Decision, Timeline, Trust Ledger, Team/Team Member — was pressure-tested for removal, merger, and splitting, checked for circular dependencies, and verified to be describable in pure business language with no dependency on any particular technology or architectural pattern. One naming exception was found and recorded (Mission Graph's name leans on an implementation metaphor; the underlying business need does not) — flagged, not blocking.

**Remaining open items are architecture-layer decisions, not domain gaps:** Review's aggregate boundary, the `iterate`-cycle bounding policy, and the technical enforcement of "Decision is always human" all belong to `03-ARCHITECTURE.md`. Further domain discovery is not expected to be needed before that document is written.
