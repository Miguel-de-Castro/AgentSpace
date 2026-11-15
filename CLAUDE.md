# AgentSpace

A visual workspace for supervising an AI software engineering team (Claude Code) that works autonomously inside a local git repository. Solo-developer v1 (see `docs/01-PRD.md`). Not a chat interface, not a Jira/Linear clone — a calm mission-control tool. Core vocabulary: **Mission**, **Team Member**, **Project** — never "task," "ticket," or "agent" in user-facing copy.

If a `CLAUDE.local.md` exists next to this file, read it too: it holds the author's local working notes (current status, open plans, machine-specific details) and is not part of the repository.

## Read first

Docs pipeline, in order: `docs/00-VISION.md` → `01-PRD.md` → `02-DOMAIN.md` → `03-ARCHITECTURE.md` → `04-USER_JOURNEYS.md`. Supporting docs: `06-DESIGN_GUARDRAILS.md`, `07-SCHEMA_API_CONTRACT.md`, `16-ASSUMPTIONS.md`, `17-DOMAIN_SCENARIOS.md`, `19-ARCHITECTURAL_TESTS.md`, `20-UBIQUITOUS_LANGUAGE.md`. The domain model, the architecture and the user journeys are settled; `docs/*.md` is the source of truth.

## Architecture

Three layers (`docs/03-ARCHITECTURE.md`):

- **Mission Engine** (`src/mission-engine/`): Mission state machine, team roster, approval policy, iterate bounding, Timeline, Trust Ledger, reviews.
- **Execution Engine** (`src/execution-engine/`): git worktree per Mission, readable branch names, diffs, build verification, previews, routines, rebase/push on approval.
- **Provider Adapter** (`src/provider-adapter/`): the only layer that knows Claude Code exists. `claudeCodeAdapter.ts` runs `claude -p --output-format stream-json --verbose` as a subprocess (the CLI rejects `stream-json` without `--verbose`); `mockAdapter.ts` is the default for development.

Storage is `node:sqlite` (`src/db/`), schema mirrored in `src/domain/types.ts`; `web/src/lib/types.ts` mirrors that by hand — keep them in sync. The API (`src/api/`) implements `docs/07-SCHEMA_API_CONTRACT.md` plus SSE at `GET /api/events`.

## Rules that must hold

- A **Decision is always human** (guardrail #8). AgentSpace never merges and never opens a PR: "Allow" rebases the Mission's branch and pushes it to `origin`; the user opens the PR.
- No live telemetry or percentages in the UI (guardrail #2); see `docs/06-DESIGN_GUARDRAILS.md` for the rest.
- Anything Claude-Code-specific belongs in `provider-adapter/` (Architectural Test #1, `docs/19-ARCHITECTURAL_TESTS.md`).
- **Local-only server.** It binds to `127.0.0.1` and `src/api/localOnly.ts` rejects non-localhost `Host`/`Origin`. Don't weaken this: the API can run commands on the machine.
- Mock provider work can never be approved or pushed; `NODE_ENV=production` refuses to start on the mock unless `AGENTSPACE_ALLOW_MOCK=1`.

## Working conventions

- Use `:5173` (Vite dev, HMR) day to day; `:4310` only serves the last `npm run build:web`.
- Anything that touches git state for real (worktrees, branches, rebase, push) is tested against a disposable repository created for the test — a real `git init --bare` acting as `origin` — never against the user's own projects. Test rows created in the database are deleted afterwards.
- Dev processes started for testing are stopped at the end of a session; never kill a server the user started themselves without asking.
