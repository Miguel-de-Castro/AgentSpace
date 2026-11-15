# Schema & Mission Engine ↔ UI Contract

Written against the frozen domain model (`02-DOMAIN.md`, `20-UBIQUITOUS_LANGUAGE.md`) and the architecture it's realized under (`03-ARCHITECTURE.md`, §2–§3). This is the last planning artifact before scaffolding: it pins down the actual SQLite tables and the actual interface the UI (governed by `06-DESIGN_GUARDRAILS.md`) is built against.

Nothing here reopens a naming, boundary, or persistence-shape decision already made. Where this doc has to choose something `03-ARCHITECTURE.md` left open (e.g., the exact iteration-cap default), that's called out as a tunable, not a new architectural commitment.

---

## 1. Scope and non-decisions

- **One SQLite file per Workspace**, consistent with `03-ARCHITECTURE.md` §3 (relational, not graph) and the desktop-first, single-local-user non-goals in `01-PRD.md`.
- **v1 has exactly one Workspace per install** (`02-DOMAIN.md`). A `workspaces` table still exists — one row — rather than hardcoding the assumption into every other table's absence of a workspace reference, so a future multi-workspace change is additive, not a migration that touches every table. This is not speculative multi-tenancy (explicitly a non-goal); it's just where the row that owns "all Projects" lives.
- **No graph database, no event sourcing, no CQRS** — per §3 and §9 of `03-ARCHITECTURE.md`. Every table below is a plain row store; the "Mission Graph" is realized as foreign keys for in-aggregate relationships plus one small edge table for the genuinely cross-aggregate ones (§4).
- **Transport for the Mission Engine ↔ UI contract is described here as REST-shaped JSON** (verb + path + body) because that's the clearest way to specify it, and because it keeps Mission Engine honestly UI-agnostic (§7 of `03-ARCHITECTURE.md` — the UI is "whatever layer is listening," local desktop app today). Whether it's actually wired up as local HTTP, an Electron IPC bridge, or an in-process function-call layer is an implementation choice with no bearing on this contract; every endpoint below must remain expressible as a plain request/response pair regardless of transport.

---

## 2. Entity-relationship overview

```
workspaces (1) ──< projects (1) ──< missions (1) ──< executions (1) ──< evidence
                       │                  │                 │
                       │                  │                 └──< artifacts
                       │                  │
                       │                  ├──< reviews (1) ──< findings
                       │                  │        │
                       │                  │        └── recommendation (columns on reviews)
                       │                  │
                       │                  └──< decisions
                       │
                       └── team_roster (JSON column on projects, v1)

mission_graph_edges — cross-aggregate only: triggered_by (mission→mission),
                       informed_by (decision→review | decision→artifact),
                       superseded_by (review→review)
```

Every `≤1:many` relationship drawn as a nested arrow above is a foreign key. The only relationships that get their own edge rows are the ones `03-ARCHITECTURE.md` §3 explicitly named as cross-aggregate: a Mission triggering another Mission, a Decision being informed by Review(s)/Artifact(s) it didn't directly own, and a Review being superseded by a later one. This is deliberately the smallest possible edge set — it's the seam `03-ARCHITECTURE.md` flagged as where a future graph-shaped migration would happen, not a place to add convenience edges speculatively (AT #5).

---

## 3. Tables (SQLite DDL)

Conventions: `id` is a ULID (`TEXT PRIMARY KEY`) — sortable by creation time without a separate index, useful for both Timeline and Trust Ledger queries. Timestamps are `TEXT` ISO-8601 UTC. `JSON` columns use SQLite's native `TEXT` + `json_valid()` check; they hold data that is genuinely a document (roster config, evidence payload shape that varies by event type) rather than data with its own query/foreign-key needs — anything another table needs to join against or filter by is a real column, never buried in JSON.

### 3.1 `workspaces`

```sql
CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT 'My Workspace',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

Exactly one row in v1. Not exposed as something the user manages (`01-PRD.md` non-goal); exists so `projects.workspace_id` has a real, stable target.

### 3.2 `projects`

```sql
CREATE TABLE projects (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id),
  name                  TEXT NOT NULL,
  repo_path             TEXT NOT NULL UNIQUE,       -- absolute local filesystem path
  default_branch        TEXT NOT NULL,               -- e.g. "main"
  branch_protection     TEXT NOT NULL,               -- JSON: { protected_branches: string[], source: "detected"|"implicit-fallback" }
  team_roster           TEXT NOT NULL,               -- JSON: [{ role: "Planner"|"Developer"|"QA"|"Reviewer"|..., enabled: bool }]
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

`branch_protection` and `team_roster` are JSON here deliberately: both are per-Project config documents read as a whole (Journey 9 — reflecting the repo's own rules back, letting the developer adjust the default roster), never filtered or joined on a per-role or per-branch basis anywhere in the frozen domain scenarios. If a future need requires querying "which Projects have QA enabled," that's the trigger to normalize `team_roster` into its own table — not before (AT #5).

### 3.3 `missions`

```sql
CREATE TABLE missions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  brief          TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN (
                   'proposed', 'queued', 'running', 'awaiting-approval',
                   'completed', 'rejected', 'failed', 'cancelled'
                 )),
  assigned_team  TEXT NOT NULL,   -- JSON: [{ role: "Developer", ... }] — subset of project's roster actually activated
  reference_material TEXT,        -- JSON, nullable: attachments given as context only (stack trace, ticket text) — never a Mission output
  proposed_by_mission_id TEXT REFERENCES missions(id), -- set only when status started as 'proposed' (Journey 5); the *edge* is also recorded in mission_graph_edges (§4) — this column is a fast-path denormalization for "what proposed me," not a substitute for the edge
  iterate_count  INTEGER NOT NULL DEFAULT 0, -- consecutive iterate-triggered Executions under this Mission (§5.2, 03-ARCHITECTURE.md)
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_missions_project_status ON missions(project_id, status);
```

`status` is the literal enum from `02-DOMAIN.md` / `20-UBIQUITOUS_LANGUAGE.md` — no additional values, no UI-only synonyms stored in the database (the UI's own display labels — "Running Unattended," "Waiting on You" — are a presentation-layer mapping over this column, kept in the UI, not persisted; see §6).

`iterate_count` exists because `03-ARCHITECTURE.md` §5.2 requires Mission Engine to enforce a cap on consecutive `iterate`-triggered Executions and force `awaiting-approval` when the cap is hit. **The cap's default value is a tunable, not fixed here** — §10 of `03-ARCHITECTURE.md` explicitly leaves it open; this schema stores the running counter, not the threshold (the threshold lives in Mission Engine config, not per-Mission data).

### 3.4 `executions`

```sql
CREATE TABLE executions (
  id               TEXT PRIMARY KEY,
  mission_id       TEXT NOT NULL REFERENCES missions(id),
  seq              INTEGER NOT NULL,   -- 1, 2, 3... ordering within the Mission (pause/resume, retry, iterate)
  trigger          TEXT NOT NULL CHECK (trigger IN ('initial', 'resume-after-approval', 'iterate', 'retry-after-failure')),
  started_at       TEXT NOT NULL,
  ended_at         TEXT,               -- null while running
  outcome          TEXT CHECK (outcome IN ('success', 'failure', 'interrupted')), -- null while running
  git_before_sha   TEXT NOT NULL,
  git_after_sha    TEXT,               -- null until the Execution ends
  worktree_path    TEXT NOT NULL,
  UNIQUE(mission_id, seq)
);

CREATE INDEX idx_executions_mission ON executions(mission_id);
```

Diffing is always `git_before_sha`..`git_after_sha` (git-computed, per `03-ARCHITECTURE.md` §4 / AT #4) — never a provider checkpoint. `trigger` records *why* this Execution exists, which is what lets a Mission Timeline read as a coherent story ("resumed after your approval," "the team caught an issue and iterated") instead of an undifferentiated list of runs.

### 3.5 `evidence`

```sql
CREATE TABLE evidence (
  id           TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  seq          INTEGER NOT NULL,        -- strict ordering within the Execution
  type         TEXT NOT NULL,           -- normalized event type, e.g. "tool_call", "file_edit", "test_run", "git_diff_chunk"
  payload      TEXT NOT NULL,           -- JSON, normalized shape per `type` — never the provider's raw stream-json line
  occurred_at  TEXT NOT NULL,
  UNIQUE(execution_id, seq)
);

CREATE INDEX idx_evidence_execution ON evidence(execution_id);
```

Per `03-ARCHITECTURE.md` §4's schema-defense requirement (T-006, AT #9): rows here are only ever the Execution Engine's **normalized** shape. An event that doesn't match a known `type` is not silently coerced into this table — it's logged as a normalization gap (a separate, lower-stakes operational log, not part of the domain schema) and surfaced, so the durability claim over `evidence` never quietly rests on guessing at an unversioned upstream format.

### 3.6 `artifacts`

```sql
CREATE TABLE artifacts (
  id           TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  kind         TEXT NOT NULL CHECK (kind IN ('diff', 'new_file', 'document', 'test_report')),
  title        TEXT NOT NULL,           -- e.g. "src/middleware/rate_limit.ts"
  content_ref  TEXT NOT NULL,           -- pointer: a git blob/diff reference, not inlined file content
  summary      TEXT,                    -- short human-readable description, nullable
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_artifacts_execution ON artifacts(execution_id);
```

`content_ref` is a pointer (a git ref/blob hash, or a path to a generated report file) rather than inlined content — the diff itself always resolves through git, keeping git as the single source of truth for *what changed* (AT #4), while `artifacts` is the index of *which reviewable units exist* and where to find them. One Execution can produce several Artifacts (Scenario 1's four distinct reviewable units), which this table supports directly via the 1:many FK.

### 3.7 `reviews`

```sql
CREATE TABLE reviews (
  id                        TEXT PRIMARY KEY,
  mission_id                TEXT NOT NULL REFERENCES missions(id),  -- Mission-scoped, not Execution-scoped (02-DOMAIN.md)
  author_type                TEXT NOT NULL CHECK (author_type IN ('human', 'ai_team_member')),
  author_role                TEXT,        -- e.g. "Reviewer"; null when author_type = 'human'
  recommendation_outcome     TEXT NOT NULL CHECK (recommendation_outcome IN ('approve', 'iterate', 'reject-suggested')),
  recommendation_rationale   TEXT NOT NULL,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_reviews_mission ON reviews(mission_id);
```

Recommendation is embedded as columns rather than a child table — `20-UBIQUITOUS_LANGUAGE.md` is explicit that it "has no independent identity or lifecycle... a structured value belonging to the Review that produced it." A Review is immutable once submitted (a changed mind is a new Review row, never an `UPDATE`), so there's no update path to reconcile against a would-be separate table anyway.

### 3.8 `review_artifacts`

```sql
CREATE TABLE review_artifacts (
  review_id   TEXT NOT NULL REFERENCES reviews(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  PRIMARY KEY (review_id, artifact_id)
);
```

A join table because a Review can examine Artifacts spanning more than one Execution (`02-DOMAIN.md`: "a human approving a merge is typically looking at the net accumulated result of every Execution the Mission has had so far") — a genuine many-to-many, not flattened to a single `execution_id` FK on `reviews` (AT #10).

### 3.9 `findings`

```sql
CREATE TABLE findings (
  id           TEXT PRIMARY KEY,
  review_id    TEXT NOT NULL REFERENCES reviews(id),
  artifact_id  TEXT NOT NULL REFERENCES artifacts(id),   -- the specific Artifact this Finding points at
  evidence_id  TEXT REFERENCES evidence(id),              -- the citation grounding this Finding (T-003); nullable only if a Finding can be grounded purely in the Artifact's own diff content with no separate Evidence event to cite
  text         TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocking')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_findings_review ON findings(review_id);
```

Findings get real rows (per `03-ARCHITECTURE.md` §3's explicit call-out: "Finding/Recommendation → Review" as an in-aggregate FK relationship) but are **never** a target of `mission_graph_edges` (§4) and never exposed as an independently-addressable resource in the API contract (§7) — matching `20-UBIQUITOUS_LANGUAGE.md`'s "not independently identified or addressable outside its parent Review in v1." They're always read as part of their owning Review, never fetched or linked to on their own.

### 3.10 `decisions`

```sql
CREATE TABLE decisions (
  id           TEXT PRIMARY KEY,
  mission_id   TEXT NOT NULL REFERENCES missions(id),
  tier         TEXT NOT NULL CHECK (tier IN ('binding', 'lightweight')),
  outcome      TEXT NOT NULL,
  rationale    TEXT,             -- optional even for binding (Journey 3: "isn't forced to explain why in detail")
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (tier = 'binding'     AND outcome IN ('approved', 'rejected'))
    OR
    (tier = 'lightweight' AND outcome IN ('acknowledged-good', 'acknowledged-not-wanted', 'flag-for-later'))
  )
);

CREATE INDEX idx_decisions_mission ON decisions(mission_id);
CREATE INDEX idx_decisions_tier_outcome ON decisions(tier, outcome); -- Trust Ledger's primary aggregate query
```

No `updated_at` — Decision is, per `03-ARCHITECTURE.md` §2, "an immutable record of something that happened... nothing about a Decision is ever updated after it's written." The `CHECK` constraint encodes both tiers' distinct outcome vocabularies in one table rather than two, because every other Decision behavior (immutability, Mission-scoping, Trust-Ledger aggregation) is identical between tiers — splitting into `binding_decisions` / `lightweight_decisions` tables would duplicate that shared shape for a distinction that's just one column's worth of difference.

Lightweight outcome values (`acknowledged-good` / `acknowledged-not-wanted` / `flag-for-later`) map directly to Journey 4's "good, not what they wanted, worth a second look later." This vocabulary is **not yet in `20-UBIQUITOUS_LANGUAGE.md`** — flagged here as a gap this doc surfaces but doesn't have standing to resolve; `20-UBIQUITOUS_LANGUAGE.md` should be updated to include these three values as canonical the next time that doc is revised, since they're now load-bearing schema, not just journey prose.

**Mission rejection vs. Mission status:** note `missions.status` has its own `rejected` value, separate from `decisions.outcome`. A Mission's terminal `rejected` status (Journey 6 — "fundamentally not what they wanted") is set by Mission Engine *as a consequence of* a Binding Decision recorded with `outcome = 'rejected'` on a Mission that had reached a review-complete point outside the approval-gate flow, or — more commonly in practice — is itself the trigger: recording a `rejected` Binding Decision (or the rejection action from Journey 6, which is a Binding-tier Decision even off a strictly protected-branch context, since it's the same "this needs to be a genuinely different action" semantics) is what flips `missions.status` to `'rejected'`. This mapping (which Decision outcomes flip which Mission statuses) belongs to Mission Engine's policy layer, not to the schema — the schema only guarantees both facts (the Decision row, the Mission status) are recorded, never that the schema itself infers one from the other.

### 3.11 `mission_graph_edges`

```sql
CREATE TABLE mission_graph_edges (
  id         TEXT PRIMARY KEY,
  edge_type  TEXT NOT NULL CHECK (edge_type IN ('triggered-by', 'informed-by', 'superseded-by')),
  from_kind  TEXT NOT NULL CHECK (from_kind IN ('mission', 'decision', 'review')),
  from_id    TEXT NOT NULL,
  to_kind    TEXT NOT NULL CHECK (to_kind IN ('mission', 'review', 'artifact')),
  to_id      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_edges_from ON mission_graph_edges(from_kind, from_id);
CREATE INDEX idx_edges_to   ON mission_graph_edges(to_kind, to_id);
```

Deliberately generic (`from_kind`/`to_kind` rather than nullable type-specific FK columns) because this table only ever holds three edge types, all cross-aggregate by definition (§2) — adding a fifth typed FK column per possible edge shape would cost more than the genericity does, for a table this narrow in purpose. No SQLite foreign key constraints are declared on `from_id`/`to_id` (they're polymorphic references) — referential integrity here is enforced by Mission Engine at write time, not by the database, which is the accepted tradeoff for a polymorphic edge table of this size.

`(from_kind='mission', to_kind='mission', edge_type='triggered-by')` is the durable record behind `missions.proposed_by_mission_id` (§3.3) and Journey 5's "its origin... stays traceable." `(from_kind='decision', to_kind='review'|'artifact', edge_type='informed-by')` is what a Binding Decision's "informed by, never required to agree with" relationship (`02-DOMAIN.md`) resolves to — a Decision can be informed by zero, one, or several Reviews/Artifacts, which is exactly what a join-style edge table supports and a single FK column wouldn't.

---

## 4. What's deliberately *not* a table

- **Timeline and Trust Ledger** — both are query shapes over the tables above (`03-ARCHITECTURE.md` §3), never materialized or separately written to. §5 gives the actual queries.
- **Notifications** — per `03-ARCHITECTURE.md` §7, these are transient signals (an id + a type: `mission.status_changed`, `execution.started`, `execution.ended`, `review.submitted`, `decision.recorded`), not a system-of-record concern. They are **not persisted** in this schema; they're an in-process pub/sub emitted by Mission Engine/Execution Engine as state changes commit, consumed by whatever UI layer is listening. A UI that was offline when a signal fired simply re-reads current state on reconnect (§7's own design already requires the UI to re-read rather than trust the payload) — no missed-notification recovery mechanism is needed because the signal was never the source of truth to begin with.
- **A separate `reasoning_summaries` table** — a Reasoning Summary (`20-UBIQUITOUS_LANGUAGE.md`) is generated from Evidence on read/request, not stored as its own durable row, so there's nothing to keep consistent with the Evidence it's grounded in if it were cached and the underlying Evidence were (hypothetically) reinterpreted. If generation cost ever makes on-demand synthesis impractical, a cache keyed by `(execution_id, evidence_max_seq)` is the future addition — not built speculatively now (AT #5).

---

## 5. Timeline and Trust Ledger as queries

Confirming both stay projections, never separate stores (`02-DOMAIN.md`):

**Project Timeline** ("what happened while I was away"):
```sql
-- Interleave Mission-level and Execution/Review/Decision-level events for a Project,
-- ordered by timestamp. Each row's `kind` tells the UI which detail to fetch on drill-in.
SELECT 'mission_created' AS kind, id, created_at AS at FROM missions WHERE project_id = ?
UNION ALL
SELECT 'execution_started', e.id, e.started_at FROM executions e
  JOIN missions m ON m.id = e.mission_id WHERE m.project_id = ?
UNION ALL
SELECT 'review_submitted', r.id, r.created_at FROM reviews r
  JOIN missions m ON m.id = r.mission_id WHERE m.project_id = ?
UNION ALL
SELECT 'decision_recorded', d.id, d.created_at FROM decisions d
  JOIN missions m ON m.id = d.mission_id WHERE m.project_id = ?
ORDER BY at DESC;
```

**Mission Timeline** is the same shape, filtered to one `mission_id` instead of `project_id` — the "drill-in" zoom level `02-DOMAIN.md` describes.

**Trust Ledger** (pattern surfacing over Decisions, e.g. Digest View's "You've approved 11 of the last 12 changes to `api/`"):
```sql
SELECT
  outcome,
  COUNT(*) AS count
FROM decisions d
JOIN missions m ON m.id = d.mission_id
JOIN projects p ON p.id = m.project_id
WHERE d.tier = 'binding'
  AND p.id = ?
  AND d.created_at >= ?          -- window start
GROUP BY outcome;
```
Path-scoped variants (`"auth/middleware needed changes 3 of the last 4 times"`) join through `decisions → informed-by edges → reviews/artifacts → artifacts.title` to filter by path prefix. This is a straightforward relational join, not a graph traversal — confirming `03-ARCHITECTURE.md` §3's claim that Trust Ledger's stated v1 payoff never required a graph database.

---

## 6. Status vocabulary: schema vs. UI display

`missions.status` stores the exact domain enum (§3.3) and nothing else. The visually-verified mockups (`06-DESIGN_GUARDRAILS.md`) use calmer display labels in places — "Running Unattended," "Waiting on You," "In good hands" — that are **presentation-layer text, not schema values**. The mapping Mission Engine's API responses use by default:

| `missions.status`   | Default UI display label                    |
|----------------------|----------------------------------------------|
| `proposed`            | "Proposed — not yet started"                 |
| `queued`               | "Queued"                                     |
| `running`              | "Running" (unattended) / "Running" (attended, if the developer is actively viewing) |
| `awaiting-approval`    | "Waiting on you"                             |
| `completed`            | "Completed"                                  |
| `rejected`             | "Rejected" (never styled to imply failure — `06-DESIGN_GUARDRAILS.md` #4/#5) |
| `failed`               | "Failed"                                     |
| `cancelled`             | "Cancelled"                                  |

This table lives in the API layer (§7), not the database — keeping copy changes (a real risk, per `06-DESIGN_GUARDRAILS.md`'s note that tone drifts back easily) a UI/API concern that never requires a schema migration.

---

## 7. Mission Engine ↔ UI contract

Grouped by resource. Every endpoint is scoped to the single Workspace implicitly (v1 has one).

### 7.1 Projects

| Verb & path | Purpose | Notes |
|---|---|---|
| `GET /projects` | List Projects, each with a `needs_attention_count` (Missions in `awaiting-approval` or `proposed`) | Powers the cross-Project "what needs me" surface |
| `POST /projects` | Onboard a Project (Journey 9): `{ repo_path }` | Mission Engine reads branch protection from the repo and returns the detected config; does not require the client to supply it |
| `GET /projects/:id` | Full Project detail incl. `team_roster`, `branch_protection` | |
| `PATCH /projects/:id` | Adjust `team_roster` or `name` | Never accepts a `branch_protection` override that contradicts what's actually detected in the repo — Journey 9's "deferring to rules already trusted," not a new risk model to configure |

### 7.2 Missions

| Verb & path | Purpose | Notes |
|---|---|---|
| `GET /projects/:id/missions?status=` | List Missions for a Project, optionally filtered | Default view excludes `cancelled` unless explicitly requested |
| `POST /projects/:id/missions` | Start a Mission (Journey 1): `{ brief, reference_material?, assigned_team? }` | If `assigned_team` omitted, Mission Engine proposes one from the roster; response includes the proposed team so the UI can let the developer adjust before the client confirms. Created with `status = 'queued'` — this endpoint is for developer-initiated Missions only, never for AI-proposed ones (see next row) |
| `GET /missions/:id` | Full Mission detail: status, brief, assigned team, `iterate_count`, links to its Executions/Reviews/Decisions | |
| `POST /missions/:id/confirm` | Turn a `proposed` Mission into `queued` (Journey 5) | 404/409 if status isn't `proposed`. Records the `triggered-by` edge (already present from proposal creation) |
| `POST /missions/:id/dismiss` | Discard a `proposed` Mission (Journey 5) | Sets `status = 'cancelled'`; no cost/friction, per journey — no rationale field |
| `POST /missions/:id/cancel` | Cancel a running Mission | |
| `GET /missions/:id/timeline` | Mission Timeline (§5) | |

AI-proposed Missions (`status = 'proposed'`, `proposed_by_mission_id` set) are created internally by Mission Engine, not via `POST /projects/:id/missions` — there is no public endpoint for a client to fabricate a proposal that looks AI-originated, which is a deliberate (if narrow) instance of the same "no unattended shortcut around a human-facing surface" caution `03-ARCHITECTURE.md` §5.5 applies to Decisions.

### 7.3 Executions, Evidence, Artifacts

| Verb & path | Purpose | Notes |
|---|---|---|
| `GET /missions/:id/executions` | List Executions for a Mission, ordered by `seq` | |
| `GET /executions/:id` | Execution detail: trigger, timing, git shas, outcome | |
| `GET /executions/:id/evidence` | Ordered Evidence stream | Process detail (`06-DESIGN_GUARDRAILS.md` #6) — never the default view; the UI fetches this only when the developer explicitly expands "how it got there" |
| `GET /executions/:id/evidence/summary` | A generated Reasoning Summary over this Evidence stream (§4 — synthesized on read, not stored) | |
| `GET /missions/:id/artifacts` | All Artifacts across all of the Mission's Executions (the "what resulted" view, Journey 2 step 3) | This is the union query `02-DOMAIN.md` describes — Artifacts belong to Executions, but the Mission-level view is what the UI actually renders by default |
| `GET /artifacts/:id` | Artifact detail incl. resolved diff content (dereferences `content_ref` through git) | |

### 7.4 Reviews

| Verb & path | Purpose | Notes |
|---|---|---|
| `GET /missions/:id/reviews` | All Reviews for a Mission (human- and AI-authored), each with its Findings and Recommendation | |
| `GET /reviews/:id` | Single Review detail | |
| `POST /missions/:id/reviews` | Submit a human-authored Review: `{ artifact_ids[], recommendation_outcome, recommendation_rationale, findings? }` | `author_type` is set server-side to `'human'` from the authenticated session — never a client-supplied field, closing off the same "who's actually behind this write" concern as §7.2's proposal note. AI-authored Reviews are written by Mission Engine directly from Provider Adapter output, never through this endpoint |

Findings are never independently fetchable (`GET /findings/:id` does not exist) — always read embedded in their parent Review's response, per §3.9.

### 7.5 Decisions

| Verb & path | Purpose | Notes |
|---|---|---|
| `POST /missions/:id/decisions` | Record a Decision: `{ tier, outcome, rationale?, informed_by: { review_ids?, artifact_ids? } }` | The **only** write path capable of producing a `tier: 'binding'` Decision is this endpoint, called from the interactive approval flow inside AgentSpace itself — per `03-ARCHITECTURE.md` §5.5, there is no separate automation-friendly path. `tier: 'lightweight'` Decisions use the same endpoint (Journey 4 — "costs them nothing," not a different code path with different friction) |
| `GET /missions/:id/decisions` | All Decisions for a Mission | |

A `binding` Decision with `outcome: 'approved'` is what triggers Mission Engine to actually let the blocked merge proceed (§5.1 of `03-ARCHITECTURE.md`) — this endpoint is the domain-record write; the mechanical merge action it authorizes is a Provider Adapter/Execution Engine concern downstream of it, not part of this contract.

### 7.6 Trust Ledger

| Verb & path | Purpose | Notes |
|---|---|---|
| `GET /projects/:id/trust-ledger?window=&path_prefix=` | Aggregate Decision outcomes (§5's query) | Powers both Journey 8's "consult before deciding" (called with a `path_prefix` matching the Mission currently being decided on) and the standalone Track Record screen (no `path_prefix` — full history) |
| `GET /workspace/trust-ledger` | Same aggregation across every Project | `02-DOMAIN.md`: "aggregated across every Mission, every Project, over time" |

### 7.7 Events (notification signals, §4)

`GET /events` (or the transport-appropriate equivalent — an Electron IPC subscription in practice) streams the five signal types from `03-ARCHITECTURE.md` §7: `mission.status_changed`, `execution.started`, `execution.ended`, `review.submitted`, `decision.recorded`. Each payload is `{ type, id }` only — **the UI is required to re-fetch the actual resource**, never to render directly from the event payload, keeping the relational store the single source of truth as §7 mandates.

---

## 8. Open items carried forward, not resolved here

- **Lightweight Decision outcome vocabulary** (`acknowledged-good` / `acknowledged-not-wanted` / `flag-for-later`, §3.10) needs to be promoted into `20-UBIQUITOUS_LANGUAGE.md` as canonical — currently only implied by Journey 4's prose.
- **The iterate-cap default value** (§3.3) remains an implementation tunable per `03-ARCHITECTURE.md` §10 — not set here.
- **Whether Review's isolation from Mission (its own table vs. nested) ever becomes a real performance question** — per `03-ARCHITECTURE.md` §10, this schema defaults to the same pattern as Execution (own table, FK-referenced) and revisits only against observed evidence.
- **Path-prefix matching for Trust Ledger queries** (§5) is specified here only as "join through to `artifacts.title` and filter by prefix" — the exact matching rule (literal prefix vs. a smarter path/glob match) is an implementation detail for scaffolding, not an architectural commitment.
