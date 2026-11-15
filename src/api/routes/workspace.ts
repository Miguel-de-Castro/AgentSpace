import { Router } from "express";
import { asyncRoute } from "../asyncRoute.js";
import { workspaceTrustLedger } from "../../mission-engine/index.js";
import { getRateLimitState } from "../../execution-engine/index.js";
import { getActiveProviderName } from "../../provider-adapter/index.js";
import { windowToSince } from "../../util/window.js";

export const workspaceRouter = Router();

// .claude/plans/18-mock-provider-safety-and-prod-start.md P0 item 3 — expose
// the active provider so the UI can show a persistent "simulation mode" banner
// when the server booted without AGENTSPACE_PROVIDER=claude-code. The mode must
// never be a silent, invisible config: a whole session of mock Missions
// otherwise looks exactly like real work.
workspaceRouter.get(
  "/workspace/provider",
  asyncRoute(async (_req, res) => {
    res.json({ provider: getActiveProviderName() });
  })
);

// docs/02-DOMAIN.md — "aggregated across every Mission, every Project, over time."
workspaceRouter.get(
  "/workspace/trust-ledger",
  asyncRoute(async (req, res) => {
    const since = req.query.window ? windowToSince(String(req.query.window)) : undefined;
    res.json(workspaceTrustLedger({ since }));
  })
);

// .claude/plans/04-usage-rate-limit.md — read on demand by the UI, never
// pushed/polled continuously (docs/06-DESIGN_GUARDRAILS.md #2: no live
// telemetry). Workspace-scoped, not per-Project/Mission: all concurrent
// Executions share one subscription's rate-limit window
// (docs/03-ARCHITECTURE.md §8).
workspaceRouter.get(
  "/workspace/usage",
  asyncRoute(async (_req, res) => {
    const state = getRateLimitState();
    res.json(state ?? null);
  })
);
