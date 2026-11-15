# Architecture

Written against the frozen domain model (`02-DOMAIN.md`, `20-UBIQUITOUS_LANGUAGE.md`, `17-DOMAIN_SCENARIOS.md`). Every decision here is checked against `19-ARCHITECTURAL_TESTS.md`; where a decision doesn't cleanly pass a test, that's stated explicitly rather than glossed over.

This document answers *how* the frozen concepts are realized — layers, bounded contexts, persistence shape, policy ownership, and the interfaces between them. It does not reopen any naming or boundary question `17-DOMAIN_SCENARIOS.md` already closed; where an open item from that document lands here, it's resolved below, not re-litigated.

---

## 1. Layers

Three layers, matching the separation `02-DOMAIN.md` already implied and `19-ARCHITECTURAL_TESTS.md` exists to protect:

```
┌─────────────────────────────────────────────────────────┐
│ Mission Engine                                           │
│  owns: Mission state & policy, Team Roster/assignment,   │
│  approval-gate policy, iterate-cycle bounding,           │
│  Mission Graph (the connected record), Trust Ledger      │
├─────────────────────────────────────────────────────────┤
│ Execution Engine                                         │
│  owns: git snapshot before/after, diff computation,      │
│  worktree lifecycle, Evidence/Artifact assembly           │
├─────────────────────────────────────────────────────────┤
│ Provider Adapter                                          │
│  owns: starting/observing/cancelling/resuming ONE         │
│  provider's execution (Claude Code today); translates     │
│  Mission Engine policy into provider-specific mechanism   │
└─────────────────────────────────────────────────────────┘
```

**Test applied (AT #1, #8):** every responsibility above must be explainable without naming Claude Code, except inside Provider Adapter. Reading the table: Mission Engine and Execution Engine pass cleanly — nothing in either box requires knowing which AI tool is running. Provider Adapter is deliberately the only layer allowed to say "Claude Code," "hooks," or "`stream-json`."

**Test applied (AT #7):** Mission Engine decides *what* is allowed (which branches are protected, how many autonomous iterations a Recommendation can trigger before forcing a human check-in). Provider Adapter only *enforces* — it translates a Mission Engine policy decision into a blocking hook response. Provider Adapter never independently judges risk.

---

## 2. Bounded contexts and consistency boundaries

Per the Domain Consolidation and Freeze Review, these are the write-side consistency boundaries — the things that can change independently of each other:

- **Mission** — its own boundary: status, brief, Assigned Team. References its Executions, Reviews, and Decisions by identifier, never by embedding them.
- **Execution** — its own boundary, referenced by Mission by identifier. Owns its Evidence stream and Artifacts within its own boundary. Kept separate from Mission specifically so that touching Mission status (e.g., flipping to `awaiting-approval`) never requires loading a large Evidence stream — a directly-costed decision, not a "just in case" one (AT #5).
- **Review** — its own boundary, referenced by Mission by identifier, referencing whichever Artifact(s) it examined (possibly spanning more than one Execution) by identifier. Owns its Findings and its single Recommendation within its own boundary.
- **Decision** — modeled as an **immutable record of something that happened**, not a stateful object. It has an identifier (so it can be referenced later — e.g., "the fix addressed the concern from Decision X"), but no lifecycle: nothing about a Decision is ever updated after it's written. Referenced by Mission; references the Review(s)/Artifact(s) that informed it.

**Why Execution and Review are each their own boundary and not nested inside Mission:** both can accumulate meaningfully-sized child data (Evidence entries, Findings) independently of Mission's own fields, and both can be authored asynchronously relative to whatever else is happening on the Mission (a human reviewing days later; an Execution running in the background). Nesting them would force every Mission-level operation to transact against data it doesn't need.

**Open item, explicitly not resolved here:** whether Review's boundary genuinely needs the same isolation Execution's does is a closer call — Findings are comparatively few and small per Review, unlike Evidence per Execution. Default to the same pattern (own boundary, referenced by identifier) for consistency; revisit only if a concrete performance or concurrency problem shows up in practice, not speculatively.

---

## 3. Persistence shape — resolving the "Mission Graph" question

`02-DOMAIN.md`'s naming note on Mission Graph flagged that "Graph" describes a business need (everything traceable and connected), not a storage mandate. This is where that gets resolved.

**Decision: a relational store (SQLite — single-file, zero-ops, matches the desktop-first, single-local-user shape of `01-PRD.md`'s non-goals), not a graph database.**

Reasoning against AT #5 and AT #10 together: AT #10 warns against flattening a real graph into something linear "for convenience" — but it does not mandate a literal graph-shaped storage engine. A relational schema with explicit foreign keys for in-aggregate relationships (Execution → Mission, Artifact → Execution, Finding/Recommendation → Review) and a small number of explicit edge tables for the genuinely cross-aggregate relationships (`triggered-by` between two Missions, `informed-by` between a Decision and the Review(s) that fed it, `superseded-by` between Reviews) expresses every relationship `17-DOMAIN_SCENARIOS.md` actually needed, without taking on a graph database as a dependency nobody has validated a need for (AT #5 — "just in case" abstractions are a cost with no offsetting benefit). A graph database earns its cost only if traversal queries (multi-hop pattern mining across the whole Mission Graph) turn out to be a real, frequent access pattern — which nothing in the frozen domain currently requires; Trust Ledger's stated v1 payoff is Mission-level pattern surfacing over Decision records, a query a relational store answers directly.

**What this buys:** Timeline (a chronological read: order by timestamp across Mission/Execution/Review/Decision rows scoped to a Project or a Mission) and Trust Ledger (an aggregate read: group Decision rows by outcome, filtered by path/author/time window) are both straightforward relational queries — consistent with `02-DOMAIN.md`'s requirement that both stay projections, never separate stores, never separately written to.

**What this doesn't do:** it doesn't preclude moving to a graph-shaped store later if traversal patterns actually demand it (P-003/Coordination Plane growth, multi-hop Trust Ledger queries). The relational schema's edge tables are the seam where that migration would happen — deliberately, not speculatively built in now.

---

## 4. Execution Engine mechanics

- **Worktree ownership: plain `git worktree`, never Claude Code's native `--worktree` flag** (T-005, confirmed architecturally necessary in `02-DOMAIN.md`'s Architecture Discovery Findings). Execution Engine creates the worktree, points the Provider Adapter's subprocess at it, and tears it down independently of provider lifecycle.
- **Diffing: git-computed before/after snapshots, never a provider's own checkpoint mechanism** (AT #4, T-002 — Claude Code's own checkpointing is explicitly documented as not tracking Bash-driven or subagent edits, making it unsuitable as a source of truth).
- **Evidence assembly:** the Provider Adapter emits raw, provider-shaped events (`stream-json` lines, hook payloads); Execution Engine normalizes them into the domain's Evidence record shape (an ordered, immutable, individually-citable stream) the moment they arrive — never persisting the provider's raw transcript as the system of record (per `02-DOMAIN.md`'s Architecture Discovery Findings: "Claude Code's own session transcript is not a valid system-of-truth dependency").
- **Schema defense (T-006, AT #9):** hook payload and `stream-json` event shapes are validated defensively on ingestion. An unrecognized or malformed event is logged as a normalization gap and surfaced, not silently dropped or guessed at — a durability claim (system of record) must not depend on an unversioned upstream format continuing to look the way it looks today.
- **Artifact assembly:** once an Execution ends, Execution Engine computes the final diff/output set and assembles Artifacts (one Execution can produce several — Scenario 1's four distinct reviewable units from one Execution is the concrete case this must support).

---

## 5. Mission Engine mechanics

### 5.1 Approval-gate policy (Binding Decision)

- Mission Engine determines, from the Project's branch-protection configuration (or the implicit-protection fallback when none is configured — `00-VISION.md`), whether a given merge target requires a Binding Decision.
- This determination is handed to the Provider Adapter as a policy instruction *before* the Execution runs — the Provider Adapter's hook enforcement is purely mechanical: it blocks a merge tool call because Mission Engine told it to, never because it independently judged risk (AT #7).
- A blocked merge attempt **terminates the Execution** (Scenario 4's confirmed finding) and flips `Mission.status` to `awaiting-approval`. No process, subprocess, or session is held open — this satisfies T-004/T-007's quota constraint by construction, not by discipline.
- **Waiting and resuming (plan 20 Phase 3, ADR-005, 2026-09-29).** The same "no process held open" rule applies to a Mission that pauses. The Provider Adapter contract returns, per run, the provider `sessions` each role ran in (persisted in `execution_role_sessions`) and a `paused` signal (today only `usage-limit`, from a `rate_limit_event` with status `rejected`); it accepts a `resume` input (sessions + the role to continue + an instruction). The Claude adapter maps it to `--resume <id> --fork-session`, which works from a new worktree path even after the old one is gone. On a usage-limit pause the partial work is committed on the branch, the Mission becomes `waiting/usage-limit` with `resume_at` (provider reset time, else exponential backoff), queued Missions are held while the limit is in force, and a sweeper (every minute and at boot) resumes due Missions in a new Execution with trigger `resume-after-limit`.
- Resuming after approval starts a **new** Execution (never a mutation of the terminated one), optionally using the provider's own session-resume mechanism for context continuity — a Provider Adapter implementation detail the domain layer above it never depends on (Scenario 5).

### 5.2 Recommendation-driven autonomous iteration (`iterate`)

- When a Review concludes with an `iterate` Recommendation, Mission Engine — not a human, not the Provider Adapter — decides whether to start a new Execution under the same Mission to act on it.
- **Iteration bounding (resolves the open question carried from `17-DOMAIN_SCENARIOS.md` Scenario 3):** Mission Engine enforces a configurable cap on consecutive `iterate`-triggered Executions per Mission (a simple counter, not a risk-scoring model — this is a loop-safety bound, not the kind of per-path/per-change-type risk classification `01-PRD.md`'s non-goals explicitly rule out). When the cap is reached, Mission Engine forces `Mission.status → awaiting-approval` regardless of branch protection, surfacing it in the "what needs me" queue with the accumulated Review history attached, so a human breaks the loop rather than it running unbounded. This mirrors the same "Humans stay in control" logic that already justifies capping AI-originated Mission proposals (Scenario 7) — unbounded autonomous chains are the risk shape the domain has consistently guarded against, and this is the one place that guard hadn't been made concrete yet.
- This cap is a Mission Engine policy value, not a new domain concept — it doesn't change `02-DOMAIN.md` or the Ubiquitous Language, it's an operational parameter Mission Engine owns per its already-stated responsibility ("owns Mission state and policy — approval rules").

### 5.3 Mission proposal confirmation

- An AI Team Member's observation (e.g., a Review's Finding pointing outside the current Mission's scope) produces a **draft** — brief plus suggested Team — with `Mission.status = proposed`. Mission Engine never transitions a proposal to `queued` on its own; only an explicit human confirmation does, recorded as the edge (`triggered-by`) linking the new Mission back to the one that proposed it.

### 5.4 Lightweight Decision

- Available on any Mission's Artifacts at any time, protected branch or not. Non-blocking — recording one never changes `Mission.status` and never gates anything. Its sole purpose is keeping Trust Ledger fed on the everyday, unprotected-branch work that never reaches a Binding Decision (`17-DOMAIN_SCENARIOS.md`, Cross-Cutting Finding #1). Implementation-wise this is the lowest-friction write path in the whole system — a single outcome value plus a timestamp, no required rationale field, since the entire point is that it must not become friction the developer routes around.

### 5.5 A known, unclosed gap: enforcing "Decision is always human"

`02-DOMAIN.md` and `20-UBIQUITOUS_LANGUAGE.md` both flag that nothing in the domain model can structurally distinguish a genuinely deliberated human approval from a scripted, unattended one hitting the same interface. Architecturally, this is mitigated, not solved:

- The only write path capable of producing a Binding Decision is the interactive approval flow inside AgentSpace itself — there is no separate "record a Decision" API exposed for automation to call.
- This raises the bar (an attacker or an over-eager script would have to drive the actual UI, not just call an endpoint) but does not cryptographically prove human presence, and this document does not claim it does. If stronger guarantees are ever required (e.g., re-authentication at the moment of approval), that's a future, explicit hardening decision — not something silently assumed to already be true.

### 5.6 Out-of-band bypass detection (T-008, AT #9)

- Mission Engine's "system of record" claim is honest only if it can detect changes that happened outside any AgentSpace-initiated Execution — e.g., a human running `git merge` into a protected branch directly from a terminal.
- Resolved architecturally: AgentSpace installs its **own** git-level hooks (`pre-receive`/`post-merge`, or an equivalent local mechanism) on Projects it manages, independent of and in addition to Claude Code's own hooks (which only ever see Claude-Code-initiated activity and are structurally blind to anything else). When an out-of-band change is detected, Mission Engine records it as an explicit Mission Graph fact ("an external change occurred outside the tracked flow, reasoning unknown") rather than leaving a silent gap — this is the concrete implementation of AT #9's durability requirement, and closes the one open question `17-DOMAIN_SCENARIOS.md` carried unresolved into this document.

---

## 6. Provider Adapter

- **Integration mechanism (T-001, T-004 — validated):** direct subprocess invocation of the `claude` CLI binary in headless mode (`claude -p --output-format stream-json`), authenticated via the user's existing subscription login. **Never the Agent SDK, never `--bare` mode** — both silently require API-key billing and would violate the "no paid API required" constraint this product is built on.
- **Responsibilities:** start, observe, cancel, and resume one provider's execution; translate a Mission Engine policy decision (e.g., "this merge target is protected") into the provider's enforcement mechanism (a blocking hook response); emit raw provider events upward for Execution Engine to normalize.
- **Explicit non-responsibilities (AT #1, #8):** no git operations, no diffing, no Mission Graph logic, no policy judgment. A second provider, if one is ever added, should be addable by writing a new Provider Adapter implementation alone — if adding one ever requires touching Mission Engine or Execution Engine, that's a signal a capability was miscategorized (AT #8), not that the new provider is unusually different.
- **Team Member execution:** a Team Member's *role* (Planner, Developer, QA, Reviewer) is a Mission Engine concept; *how* that role is actually executed is entirely inside this layer, per `02-DOMAIN.md`'s explicit Team-Member/subagent boundary. As of `.claude/plans/completed/14-real-multi-agent-execution.md` (2026-08-12), that mechanism is a sequence of separate `claude -p` invocations, one per assigned role, in a fixed canonical order, sharing one worktree — not a Claude Code native subagent (an earlier version of this line claimed that was already true; it wasn't, and the correction is the reason this note exists).
- **Resolved (implementation reference):** a working sibling project of the author's (a private repo; its `claude-code/runner.ts` service) already spawns the `claude` CLI headlessly from Node and confirms the mechanics fit this layer's constraints: `child_process.spawn` with `shell: true` (required on Windows for PATHEXT resolution), prompt delivered via **stdin** rather than argv (avoids OS argument-length limits and shell-escaping issues with large/multi-line prompts), `cwd` set to the Project's worktree, a timeout that `SIGTERM`s the child and distinguishes spawn-error / non-zero-exit / timeout as separate failure modes, and `--allowedTools` as the live mechanism for scoping what a given invocation may touch (mapping to a Mission Engine policy decision, per this section's Responsibilities). One difference to carry over deliberately, not copy verbatim: that reference implementation buffers with `--output-format json` and resolves once on `close`, since its use case (a read-only advisor) has no need for incremental events; this layer's Provider Adapter must use `--output-format stream-json` per T-001/T-004 above and parse newline-delimited JSON off `child.stdout` as it arrives, since Execution Engine's Evidence assembly (§4) depends on normalizing events incrementally, not from one blob after process exit.

---

## 7. Notification model (UI-facing, not a domain concept)

The UI needs to know when something changed without polling. This is purely a technical delivery mechanism — not a new item in `02-DOMAIN.md`, and not to be confused with Evidence (which is a domain event, immutable and system-of-record). A small, fixed set of **notification signals** — Mission status changed, Execution started/ended, Review submitted, Decision recorded — are emitted by Mission Engine/Execution Engine as they happen, and consumed by whatever UI layer is listening (local desktop app in v1, per `01-PRD.md`'s non-goals ruling out mobile/paging infrastructure). These signals carry only an identifier and a type; the UI re-reads the actual record from the relational store rather than trusting the notification payload as a cache — keeping the store the single source of truth.

---

## 8. Concurrency (T-007)

Multiple Missions may run concurrently, each in its own git worktree (mechanically safe, per T-001/T-005). All concurrent Executions share one subscription's rate-limit window — Mission Engine does not attempt to guarantee fairness or priority between simultaneously-`awaiting-approval` Missions beyond listing them in the "what needs me" queue in the order they arrived; anything more sophisticated (prioritization, scheduling) is explicitly deferred, consistent with P-003 being unresolved and v1 UI investment intentionally not betting heavily on multi-Mission dashboards yet.

---

## 9. Non-goals for this architecture

Mirroring `01-PRD.md`'s non-goals so scope decisions have something to point at inside this document too:

- No abstraction for a second AI provider beyond the Provider Adapter boundary already described — no speculative plugin system.
- No custom risk-scoring model anywhere in Mission Engine — branch protection is the sole autonomy boundary; the `iterate`-cycle cap (§5.2) is a loop-safety bound, not a risk classifier, and must not grow into one.
- No graph database, no event-sourcing framework, no CQRS infrastructure adopted speculatively — the relational schema in §3 is deliberately boring until a concrete, observed access pattern justifies more.
- No multi-user/team accounts, no server-hosted deployment — single local user, desktop-first, matching `01-PRD.md`.

---

## 10. What this document deliberately leaves open

Two things, both flagged rather than resolved, both appropriate to leave for implementation rather than architecture:

- The exact iteration-cap default value (§5.2) — a tunable, not an architectural commitment.
- Whether Review's consistency boundary (§2) genuinely needs full isolation from Mission in practice, or whether that turns out to be over-cautious — revisit only against real evidence.

Everything else in the frozen domain model now has an architectural home.
