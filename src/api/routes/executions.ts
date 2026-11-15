import { Router } from "express";
import { asyncRoute } from "../asyncRoute.js";
import { getExecution, getReasoningSummary, listEvidence } from "../../execution-engine/index.js";

export const executionsRouter = Router();

executionsRouter.get(
  "/executions/:id",
  asyncRoute(async (req, res) => {
    const execution = getExecution(req.params.id);
    if (!execution) {
      res.status(404).json({ error: "Execution not found" });
      return;
    }
    res.json(execution);
  })
);

// Process detail (docs/06-DESIGN_GUARDRAILS.md #6) — never the default view;
// fetched only when the developer explicitly expands "how it got there."
executionsRouter.get(
  "/executions/:id/evidence",
  asyncRoute(async (req, res) => {
    res.json(listEvidence(req.params.id));
  })
);

// docs/07-SCHEMA_API_CONTRACT.md §4 — a Reasoning Summary is synthesized on
// read, never stored as its own durable row (.claude/plans/09-reasoning-summary.md).
executionsRouter.get(
  "/executions/:id/evidence/summary",
  asyncRoute(async (req, res) => {
    const summary = await getReasoningSummary(req.params.id);
    res.json({ summary });
  })
);
