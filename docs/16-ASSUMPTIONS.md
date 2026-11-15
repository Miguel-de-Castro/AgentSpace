# Assumptions Register

> **Note:** this is part of the original product specification, written before implementation. Where it describes approval as *merging*, the shipped behavior is different: approving a Mission rebases its branch onto the base and pushes it to `origin`, and AgentSpace never merges or opens a PR (see the README and `03-ARCHITECTURE.md`).

Every major hypothesis the company is betting on, tracked explicitly so decisions are honest about what's proven versus presumed.

Two kinds of assumption, and both matter equally:

- **Technical (`T-###`)** — does the platform allow us to build this?
- **Product (`P-###`)** — is this worth building at all?

A register that only tracks technical risk quietly assumes the product itself is a given. It isn't.

Status values: `Unknown` / `Validated` / `Invalidated`.
Risk levels: `Low` / `Medium` / `High` / `Critical`.

---

## Technical Assumptions

### T-001

**Description:** Claude Code can be launched and controlled programmatically with enough fidelity to reconstruct execution inside AgentSpace (the "launcher" flow — terminal becomes an implementation detail).

**Why it matters:** This is the foundation of the Provider Adapter layer. If it doesn't hold, the whole execution layer needs to be redesigned around whatever control surface actually exists.

**Status:** Validated

**Risk:** Critical

**Validation strategy:** Build a minimal launcher prototype (start a session, observe its lifecycle, capture output) before implementing the Execution Engine.

**Notes:** Confirmed via Claude Code CLI research (2026-07-28): headless/print mode (`-p`), full hook lifecycle (17 event types, can block/modify/observe tool calls), `stream-json` structured output, native session objects (IDs, resume, persistence), and native git worktree support for concurrent isolated sessions. Source: code.claude.com/docs — headless.md, hooks.md, sessions.md, worktrees.md. Remaining open item: whether this is exercised via the CLI directly or the Agent SDK, and what that implies for T-004.

**Last updated:** 2026-07-28

---

### T-002

**Description:** Claude Code exposes enough execution information (tool calls, session events) to build a meaningful, accurate Execution Graph.

**Why it matters:** Without this, Execution History (`02-DOMAIN.md`) has no real data source and becomes guesswork dressed up as a UI.

**Status:** Validated

**Risk:** High

**Validation strategy:** Confirmed/verified during the Claude Code technical research pass, alongside T-001.

**Notes:** Confirmed (2026-07-28): `stream-json` output, hooks (tool name/input/output visibility), and JSONL transcripts all provide real, accessible execution data. One important caveat surfaced: **diff access is not a stable Claude Code API.** Claude Code only offers checkpoint snapshots and a `/rewind` UI; Bash-driven file changes and subagent edits are explicitly NOT tracked by its own checkpointing. This is why diffing is now a git-first responsibility owned by the Execution Engine, not something requested from the Provider Adapter — see the architecture discussion on 2026-07-28.

**Last updated:** 2026-07-28

---

### T-003

**Description:** Reasoning summaries ("why" a decision was made) can be generated without exposing raw chain-of-thought, and without fabricating reasoning that wasn't actually present in the transcript.

**Why it matters:** This is an AgentSpace-owned architectural responsibility, not something Claude Code hands us directly. A summarizer that invents plausible-sounding but ungrounded explanations would silently damage the exact trust the product is built to establish.

**Status:** Unknown

**Risk:** Medium

**Validation strategy:** Evaluate whether summaries can be grounded in extractable, quote-able evidence from the transcript/tool calls. Reject any approach that can't cite its source.

**Notes:** Research (2026-07-28) confirmed there is no native "reasoning summary" feature in Claude Code — this responsibility is entirely AgentSpace's to build, using tool-call inputs/outputs and text deltas from the transcript/stream as raw material. Still unresolved: whether grounded, evidence-cited summaries are achievable at acceptable quality/cost — that's a build-and-evaluate question. Adjacent to P-005 (confidence over chat) — if users don't value reasoning summaries at all, this technical question becomes moot.

**Last updated:** 2026-07-28

---

### T-004

**Description:** v1 can be built entirely on a Claude Code subscription — no paid API key required — including whatever headless/programmatic control T-001 depends on.

**Why it matters:** This is an explicit constraint from the original product brief. If programmatic control is only available through API billing (not subscription-authenticated CLI usage), the "no paid API required" constraint and the launcher flow are in direct conflict, and one of them has to give.

**Status:** Validated

**Risk:** Critical

**Validation strategy:** Confirm whether hooks/headless invocation work under subscription auth, or require separate API billing. Narrow, targeted follow-up (pricing/auth docs), not a capability question.

**Notes:** Resolved (2026-07-28), with one important trap found. Confirmed via official docs: `claude -p` (headless mode), authenticated via a normal subscription `/login`, draws from the subscription's own rolling usage windows — no API key, no restriction found in pricing/ToS/feature-availability docs (sources: code.claude.com/docs — headless.md, authentication.md, costs.md, errors.md).

**The trap:** the **Agent SDK** (the obvious-seeming official integration path) explicitly requires `ANTHROPIC_API_KEY` and makes direct API calls — it does NOT inherit CLI subscription auth, despite bundling the same binary. Anthropic's "Managed Agents" product is confirmed separate and API-billed only, as suspected. **Decision:** the Provider Adapter must integrate by spawning the `claude` CLI binary directly as a subprocess (`-p --output-format stream-json`), never via the Agent SDK, and must avoid `--bare` mode (which also drops subscription auth). This is now a concrete architectural constraint, not just a resolved assumption — recorded in `02-DOMAIN.md`'s Architecture Discovery Findings.

**Unverified claim, flagged not trusted:** secondary-source reporting (a Substack aggregator, not an Anthropic page) claims Anthropic proposed moving programmatic usage to API-only billing in May 2026 and cancelled it before taking effect. Not corroborated by an official source — treat as "watch Anthropic's own changelog," not as a validated fact this assumption's status should hinge on.

**Last updated:** 2026-07-28

---

### T-005

**Description:** AgentSpace can manage git worktree lifecycle itself (via plain `git worktree` commands) and simply point Claude Code at a working directory, without relying on or conflicting with Claude Code's own native `--worktree` flag/session-worktree assumptions.

**Why it matters:** Falls out of the Architecture Discovery capability analysis (2026-07-28) — using Claude Code's own worktree feature would recouple a fundamentally provider-agnostic git operation to one provider's implementation of it. But this is a deliberate deviation from the CLI's own preferred path, and needs to be confirmed as safe, not just architecturally desirable.

**Status:** Unknown

**Risk:** Medium

**Validation strategy:** Prototype: run Claude Code headless in a directory created and managed by AgentSpace's own `git worktree add`, without ever passing `--worktree`, and confirm nothing about session lifecycle, hooks, or cleanup assumes Claude Code created the worktree itself.

**Notes:** —

**Last updated:** 2026-07-28

---

### T-006

**Description:** The integration surfaces AgentSpace actually depends on (hook payload shapes, `stream-json` event types) are stable/versioned contracts, even though the underlying session transcript format is explicitly not.

**Why it matters:** Claude Code is a fast-moving product. If hook payloads or stream-json event schemas change between releases without warning, AgentSpace's Execution Engine breaks silently — which is a direct threat to the "system of record" thesis if not defended against architecturally (schema validation, version pinning, graceful degradation).

**Status:** Unknown

**Risk:** Medium

**Validation strategy:** Check whether hooks.md / headless.md document any versioning or stability guarantee for these payload shapes; if not, treat as an operational risk to defend against (validate schemas defensively) rather than assume away.

**Notes:** —

**Last updated:** 2026-07-28

---

### T-007

**Description:** A single Claude Code subscription account can actually run multiple `claude -p` sessions concurrently in practice (not just "the mechanism supports it"), without hitting rate limits or concurrency caps that make the Coordination Plane differentiator impractical.

**Why it matters:** T-001/T-002 confirmed concurrent sessions are mechanically safe (worktree isolation), but mechanism-safe isn't the same as rate-limit-permitted. If a subscription's usage windows throttle real concurrency, the Coordination Plane's core promise (supervise many Missions at once) is constrained by the same billing question as T-004.

**Status:** Likely

**Risk:** High

**Validation strategy:** Resolve alongside T-004's billing/auth research; specifically check for documented concurrency limits per subscription tier.

**Notes:** Partially resolved (2026-07-28). Confirmed: tool-use concurrency is capped at 10 per session by default (configurable via `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`), and rate limiting draws from the same shared subscription rolling-usage window across all concurrent sessions — meaning multiple concurrent Missions share one quota rather than each getting its own. No documented hard cap on the *number* of simultaneous `claude -p` processes was found, so this stays "Likely" rather than fully "Validated" — the mechanism works, but real-world throughput under heavy concurrency is still an open practical question, not just a policy one.

**Last updated:** 2026-07-28

---

### T-008

**Description:** AgentSpace can detect and log when a human bypasses its tracked flow entirely — e.g., manually running `git merge` into a protected branch from a terminal, outside any AgentSpace-initiated Execution — rather than silently having a gap in the record.

**Why it matters:** Surfaced by domain scenario walkthroughs (`17-DOMAIN_SCENARIOS.md`, 2026-07-28), not by technical research. If the "system of record" thesis (`00-VISION.md`) only captures what happens through AgentSpace's own approval flow, any out-of-band action creates a silent hole in the record — undermining the thesis exactly where it matters most (protected-branch changes). Likely requires AgentSpace to own its own git-level hooks watching the repository directly, distinct from and in addition to Claude Code's own hooks (which only see Claude Code-initiated activity).

**Status:** Unknown

**Risk:** Medium

**Validation strategy:** Confirm git's own hook mechanisms (e.g., `pre-receive`/`post-merge` or a filesystem watcher) can be installed and observed by AgentSpace independent of Claude Code, and that this doesn't require elevated permissions or fragile polling.

**Notes:** —

**Last updated:** 2026-07-28

---

## Product Assumptions

### P-001

**Description:** AgentSpace's differentiators (Trust Ledger, Coordination Plane, Judgment Interface) remain durable even as Claude Code's own native capabilities improve — i.e., Anthropic does not ship equivalent multi-project coordination or longitudinal trust/judgment tracking natively into Claude Code itself.

**Why it matters:** This is the core business-viability assumption. If wrong, AgentSpace degrades from "product with a moat" to "UI wrapper with a shrinking reason to exist."

**Status:** Unknown

**Risk:** High

**Validation strategy:** Not a build-and-test validation — an ongoing strategic one. Watch Claude Code's own roadmap; keep differentiation investment on data/coordination surfaces Anthropic has less structural incentive to build into a single-session CLI tool, not on single-session UX polish.

**Notes:** Strengthened (2026-07-28) by the decision to build git-first, provider-agnostic diffing and an Execution Graph — both survive a provider swap entirely, which is direct architectural evidence in favor of this assumption rather than just a hope.

**Last updated:** 2026-07-28

---

### P-002

**Description:** Composing each Mission's AI Team fresh, with no cross-Mission memory in v1 (`02-DOMAIN.md`), is sufficient for a solo developer to trust and find the product useful.

**Why it matters:** This is a deliberate v1 simplification. If it turns out users need perceived team continuity to trust the output, this becomes a v1 gap, not a v2 nice-to-have.

**Status:** Unknown

**Risk:** Medium

**Validation strategy:** Test against the v1 success criteria in `01-PRD.md` during dogfooding — specifically whether the lack of continuity undermines trust in the approval queue.

**Notes:** —

**Last updated:** 2026-07-28

---

### P-003

**Description:** Developers actually want to supervise multiple concurrent AI Missions, rather than running one at a time and giving it full attention.

**Why it matters:** The Coordination Plane differentiator, and the multi-worktree/concurrent-session architecture it depends on, only matters if this is true. If solo developers actually prefer running one Mission at a time and watching it closely, the Coordination Plane is solving a problem nobody has yet at the v1 stage.

**Status:** Unknown

**Risk:** High

**Validation strategy:** Dogfood with genuinely concurrent Missions during v1 usage; watch whether the user actually lets multiple run unattended or keeps reverting to one-at-a-time supervision.

**Notes:** Even if concurrency isn't heavily used by solo developers in v1, the architecture cost of supporting it is low (git worktrees are native to Claude Code — see T-001), so this can stay unresolved without blocking v1 build. It should, however, gate how much v1 UI investment goes into multi-Mission dashboards versus a single-Mission focused view.

**Last updated:** 2026-07-28

---

### P-004

**Description:** A persistent, cross-Mission decision history (the Trust Ledger) creates long-term value a developer actually perceives and acts on — not just a technically interesting log nobody revisits.

**Why it matters:** This is the foundation of differentiator #1. A ledger nobody looks back on is a database table, not a product feature.

**Status:** Unknown

**Risk:** High

**Validation strategy:** After enough Missions accumulate during dogfooding, test directly: does surfacing a pattern ("you've rejected 3 of the last 4 changes touching billing code") change a real approval decision, or does the user ignore it?

**Notes:** This assumption is downstream of P-002 — if Team Members have no continuity, the Trust Ledger is where continuity has to live instead. Its success is not optional; it's the backstop for P-002.

**Last updated:** 2026-07-28

---

### P-005

**Description:** Developers prefer confidence and observability (glanceable state, structured review) over continuous chat interaction as the primary way to work with AI on code.

**Why it matters:** This is the foundational UX bet — "this is not a chat application" (per the original brainstorm). If developers actually want to keep talking to the AI conversationally and treat visualization as a secondary nice-to-have, the entire "workspace over chat" product shape is wrong, not just a detail.

**Status:** Unknown

**Risk:** Critical

**Validation strategy:** Dogfood and watch actual behavior, not stated preference: does the user default to the visual workspace, or find themselves dropping back into a terminal/chat interface to get things done?

**Notes:** This is arguably the single riskiest product assumption in the register — more foundational than any technical one, since it questions the core interaction paradigm rather than a feature within it.

**Last updated:** 2026-07-28

---

### P-006 — Transparency-Trust Model

**Description:** Increased visibility into autonomous AI execution increases developer trust, rather than increasing anxiety, micromanagement, or analysis paralysis. This assumption has two distinct sub-claims that must both hold:

- **(a) Single-instance visibility is net-positive.** Watching one Mission's detail increases comfort rather than anxiety.
- **(b) Transparency alone is sufficient for trust**, as opposed to trust actually requiring transparency *combined with* a demonstrated track record over time (i.e., the Trust Ledger, P-004).

**Why it matters:** This is the load-bearing premise behind "Transparency over automation" in `00-VISION.md`. It is not obviously true — showing someone more detail about a process they don't fully understand can just as easily produce more worry as it can confidence. Sub-claim (b) matters separately: if trust actually requires track record, not just visibility, then a Mission's transparency alone (with no accumulated history yet) may not earn trust on day one, and the product's honest pitch is "trust builds over time via the Trust Ledger," not "transparency alone creates trust immediately."

**Status:** Unknown

**Risk:** High

**Validation strategy:** Watch for the specific failure signature during dogfooding: does the user report feeling *more* uneasy after watching a Mission's detailed timeline than with a terminal they weren't parsing closely? Separately, test whether trust changes measurably *before* versus *after* enough Mission history accumulates for the Trust Ledger to show patterns — that isolates sub-claim (b).

**Notes:** Originally proposed as two assumptions — P-006 (visibility → trust) and a user-proposed P-007 ("developers are willing to trust autonomous execution provided enough transparency exists"). Merged here (2026-07-28) because they are the same underlying bet viewed from two angles, not independent risks — treating them separately risked resolving one and quietly assuming the other. Retiring the standalone P-007 label in favor of this merged, two-part version.

**Last updated:** 2026-07-28

---

### P-008

**Description:** Branch protection is a sufficient proxy for "risk" as the sole boundary of AI autonomy — developers won't want finer-grained control (e.g. "always ask before touching billing code," even on an unprotected branch).

**Why it matters:** This is the core mechanism behind "Humans stay in control" in `00-VISION.md`. It was chosen specifically to avoid inventing an AgentSpace-specific risk model — but that simplicity is only correct if developers actually find branch protection granular enough. If they want per-path or per-change-type control, the current mechanism under-serves real risk perception even though it's architecturally clean.

**Status:** Unknown

**Risk:** Medium

**Validation strategy:** Dogfood and watch for the failure signature: does the user wish they could flag specific paths/patterns as always-ask, independent of branch? That's the signal this assumption is wrong.

**Notes:** Surfaced during the capability-first Architecture Discovery pass (2026-07-28) — approval workflow was mapped to Mission Engine policy enforced via Claude Code hooks; this assumption questions whether that policy's current shape (branch-based only) is the right one long-term.

**Last updated:** 2026-07-28
