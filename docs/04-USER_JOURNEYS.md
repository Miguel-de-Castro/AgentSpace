# User Journeys

Flows, not screens. Each journey describes what the developer is trying to do, what they need to know or feel at each step, and what "done" means — deliberately without naming a single UI element, so these can drive mockup generation (Google Stitch) without presupposing a layout. Written against the frozen domain model (`02-DOMAIN.md`) and the v1 success criteria (`01-PRD.md`): a returning developer must be able to answer, in under a minute, "what did it do," "why," and "what needs me."

Primary user throughout: the solo developer (`01-PRD.md`'s v1 beachhead).

---

## Journey 1 — Starting a Mission

**Trigger:** the developer has a goal (a feature, a bug, a refactor) and wants the AI team to take it on.

**Flow:**
1. The developer states the goal in their own words — the brief. Optionally, they attach reference material (a stack trace, a ticket description) that isn't itself part of the Mission's output, just context for it.
2. AgentSpace proposes a Team (a subset of the Project's roster — Planner, Developer, QA, Reviewer, etc.) appropriate to the kind of work; the developer can adjust who's involved before committing.
3. The developer commits, and the Mission begins. From this moment, the developer is free to walk away — nothing about starting a Mission requires them to watch it.
4. In the background: a worktree is created, the AI team begins working, and the developer's attention is free for something else entirely — another Mission, or away from the computer.

**What the developer needs to feel:** that starting a Mission is *low-ceremony* — closer to handing off a task to a trusted colleague than filling out a ticket. The brief is the only mandatory input.

**Done when:** the Mission is running, and the developer has no reason to keep watching unless they want to.

---

## Journey 2 — Returning after time away (the core loop)

**Trigger:** the developer comes back — minutes or days later — to one or more Missions that have been working without them.

**Flow:**
1. The developer sees, at a glance, every Mission's current status: still running, waiting for something from them, or finished (successfully, rejected, or failed).
2. For any Mission that finished or is mid-flight, the developer can understand **what happened** without reading raw logs — a plain-language account of what was done, grounded in what actually occurred (never a speculative or invented narrative).
3. For any Mission that finished, the developer can see **what resulted** — the concrete, reviewable outputs — separately from the blow-by-blow of how they got there. They should never have to dig through process detail just to see the outcome.
4. If a Reviewer (human or AI) already looked at the work, the developer sees what was found and what was recommended, clearly distinguished from anything that already happened autonomously as a result of it (an autonomous fix-up cycle should read as "the team caught this and handled it," not as something the developer needed to approve).
5. The developer decides, per Mission, whether they're done looking (nothing further needed) or whether something needs their input.

**What the developer needs to feel:** in control of their own time — this journey should take under a minute per PRD's own success criterion, regardless of how much happened while they were away. Depth should be available on demand, never forced.

**Done when:** the developer can, for every Mission, say either "I understand what happened and I'm satisfied" or "I know exactly what this one needs from me."

---

## Journey 3 — Responding to an approval gate (Binding Decision)

**Trigger:** a Mission's work is about to affect the protected, shared version of the codebase, and it's waiting on the developer.

**Flow:**
1. The developer sees this Mission distinctly flagged as needing them — not buried among Missions that don't.
2. They review the actual, concrete change being proposed — grounded in the real diff, not a paraphrase of it — along with whatever a Reviewer (human or AI) already concluded about it, presented as *input*, not as something already decided on their behalf.
3. The developer reaches their own judgment. They can agree with what a Reviewer recommended, or go the other way entirely — the flow must not make disagreeing with an AI's recommendation feel like fighting the system.
4. They record their decision: allow the change to proceed, or don't.
5. If allowed: the change proceeds, and the developer can trust it actually happened — no separate manual check should feel necessary (PRD success criterion #2, explicitly).
6. If declined: the developer isn't forced to explain why in detail to move on, but a quick reason is easy to leave, since it's what makes this moment valuable to look back on later.

**What the developer needs to feel:** that this is the one place their attention is genuinely required, and that a real judgment call — not a formality — is being asked of them. This should never feel routine enough to rubber-stamp.

**Done when:** the developer has made a real decision and the Mission's state reflects it immediately and irreversibly (a changed mind later means starting fresh, not editing history).

---

## Journey 4 — Leaving a lightweight acknowledgment

**Trigger:** the developer glanced at a Mission's output on an everyday, unprotected branch — no approval was ever required, but they have a reaction to it.

**Flow:**
1. While looking at any Mission's result, the developer can leave a quick reaction — good, not what they wanted, worth a second look later — without it blocking anything or requiring justification.
2. Leaving no reaction at all is equally valid and has no negative consequence — this must never feel like a chore the developer is behind on.

**What the developer needs to feel:** that this costs them nothing. If it ever feels like one more thing to keep up with, the journey has failed its own purpose.

**Done when:** the reaction (or the absence of one) is recorded, contributing quietly to the developer's own longer-term track record without demanding anything further from them right now.

---

## Journey 5 — Confirming a proposed follow-up Mission

**Trigger:** while working, the AI team noticed something outside the current Mission's scope (e.g., a latent bug in an unrelated module) and drafted a suggestion for it, rather than acting on it unasked.

**Flow:**
1. The developer sees the suggestion clearly marked as *not yet started* — a draft awaiting their word, not something already underway.
2. They see why it's being suggested — what was actually noticed, grounded in real evidence, not a vague "the AI thinks this might be worth doing."
3. The developer confirms it (turning it into a real, running Mission with its own place in the queue) or dismisses it — both are equally easy, and dismissing has no cost or friction attached.

**What the developer needs to feel:** that the AI team is observant without being presumptuous — it can notice things, but it never acts on a hunch without asking first.

**Done when:** the suggestion is either running as its own Mission or gone, and its origin (which Mission it came from, and why) stays traceable if the developer ever wants to look back at it.

---

## Journey 6 — Rejecting a Mission's output

**Trigger:** a Mission finished, the work is technically sound, but the developer disagrees with the whole approach — not a tweak, a "no."

**Flow:**
1. The developer reviews what was produced, same as any other finished Mission.
2. They decide it's fundamentally not what they wanted — this needs to be a genuinely different action from "needs a small change," not a variant of it.
3. They record the rejection. The Mission's outcome should read, from that point on, as clearly and permanently different from a technical failure — a rejection is a statement about the *output*, not evidence the AI team malfunctioned.
4. If the developer wants the goal pursued differently, that's a fresh Mission, not a resurrection of the rejected one.

**What the developer needs to feel:** safe disagreeing entirely, without the system treating that as an error condition or making them feel like they broke something by saying no.

**Done when:** the rejection is recorded, permanently, as its own distinct outcome — and later, when the developer looks back at their own history, rejected work should read differently from failed work.

---

## Journey 7 — Supervising multiple Missions at once

**Trigger:** the developer has more than one Mission running or waiting at the same time.

**Flow:**
1. The developer sees all of them together, distinguishable at a glance by what state each is in — running unattended, waiting on them, or finished.
2. They can move between Missions freely without losing their place in any of them.
3. Nothing about having several Missions going at once should feel like more cognitive load than having one — the developer should be able to trust that anything genuinely needing them will surface clearly, rather than needing to check each one "just in case."

**What the developer needs to feel:** that running several Missions in parallel is a genuine convenience, not a way to accidentally lose track of something important.

**Done when:** the developer can correctly state, without checking each Mission individually, how many (if any) need their attention right now.

---

## Journey 8 — Consulting the track record before deciding

**Trigger:** the developer is about to make a Decision (Journey 3) or is simply curious how a certain kind of work has gone historically.

**Flow:**
1. At the moment of deciding, the developer is shown anything relevant from their own history that bears on this specific decision — e.g., a pattern in how similar past work has gone — offered as context, never as an instruction.
2. The developer can also, independent of any specific decision, look back at their accumulated track record on their own terms — how much they've approved, rejected, needed changes on, and what that's told them about where they should look more closely.

**What the developer needs to feel:** that their own past judgment is being put to work for them, not that a dashboard is being pushed on them. This should sharpen a decision, never replace it.

**Done when:** the developer either changes their approach because of what they saw, or consciously decides the pattern doesn't apply here — either way, the choice stays theirs.

---

## Journey 9 — Onboarding a new Project

**Trigger:** the developer wants AgentSpace to start managing a local git repository it doesn't yet know about.

**Flow:**
1. The developer points AgentSpace at the repository.
2. AgentSpace reads the repository's own branch protection configuration and reflects it back — the developer should immediately understand which branches the AI team can work on freely and which will always require their approval, in terms of rules they already set up themselves, not a new risk model they have to learn.
3. The developer confirms or adjusts which roles (Planner, Developer, QA, Reviewer, ...) are available for this Project's Missions by default.
4. The Project is ready — the developer can start their first Mission (Journey 1) immediately.

**What the developer needs to feel:** that AgentSpace is deferring to rules they already trust, not inventing new ones to learn.

**Done when:** the Project exists inside AgentSpace with its protection boundaries correctly reflected, and starting a Mission against it requires no further setup.

---

## Cross-Journey Notes

- Every journey above either answers or sets up one of the three questions `01-PRD.md` frames as the whole point of v1: **what did it do, why, what needs me.** A journey (or a future addition to this document) that doesn't serve one of these three should be treated as suspect, not added by default.
- No journey above ever has an AI-originated judgment (a Recommendation) resolve anything by itself — every path where something actually changes what's allowed to happen next (Journeys 1, 3, 5, 6) has an explicit human action as its hinge. Journey 2's autonomous fix-up mention is deliberate: the *only* place autonomy is invisible to the user is exactly the place the domain model says it should be (an `iterate` Recommendation, never a Decision).
- These are inputs to mockup generation, not a replacement for it — the next step (Google Stitch) should produce screens *from* these flows, not the other way around.
