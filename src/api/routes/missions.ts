import { Router } from "express";
import { asyncRoute } from "../asyncRoute.js";
import { serializeMission } from "../serialize.js";
import * as missionEngine from "../../mission-engine/index.js";
import {
  approveAndPush,
  canStartExecutionNow,
  discardMissionBranch,
  getArtifact,
  getArtifactDiff,
  getAdjustmentChanges,
  getAdjustmentFileDiff,
  getGateFacts,
  getPrDescription,
  getWaitingDetails,
  isMissionMockRun,
  killRunningExecution,
  listArtifactsForMission,
  listExecutions,
  listExecutionsWithCost,
  startExecution,
} from "../../execution-engine/index.js";
import { getRemoteUrl } from "../../execution-engine/git.js";
import { fetchChecks, parseGithubRemote } from "../../integrations/github.js";

export const missionsRouter = Router();

missionsRouter.get(
  "/missions/:id",
  asyncRoute(async (req, res) => {
    const mission = missionEngine.getMission(req.params.id);
    if (!mission) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    res.json(serializeMission(mission));
  })
);

// Journey 5 — confirming a proposed follow-up Mission.
missionsRouter.post(
  "/missions/:id/confirm",
  asyncRoute(async (req, res) => {
    const mission = missionEngine.confirmMission(req.params.id);
    startExecution(mission.id, "initial").catch((err) => {
      console.error(`Failed to start initial Execution for mission ${mission.id}:`, err);
    });
    res.json(serializeMission(mission));
  })
);

missionsRouter.post(
  "/missions/:id/dismiss",
  asyncRoute(async (req, res) => {
    const dismissed = missionEngine.dismissMission(req.params.id);
    // Plan 24 item 2 — "don't propose this again": remember a short text on the
    // Project so routines stop re-proposing it. Default text is the brief.
    const exclude = req.body?.exclude;
    if (exclude !== undefined && exclude !== false && exclude !== null) {
      const text = typeof exclude === "string" && exclude.trim() ? exclude : dismissed.brief;
      missionEngine.addRoutineExclusion(dismissed.project_id, text);
    }
    res.json(serializeMission(dismissed));
  })
);

// .claude/plans/15-live-execution-feedback.md Part 3 — a real cancel does two
// things, in this order: (1) kill the actual provider process of any live
// Execution (Execution Engine owns processes, AT #7), then (2) an atomic
// conditional status write (Mission Engine) that refuses to clobber a Mission
// that already reached 'awaiting-approval'/'completed' between the click and
// here. If the Mission had already finished, cancelMission leaves it untouched
// and returns its honest status — the UI reads that back and shows the real
// result rather than a false "cancelled."
missionsRouter.post(
  "/missions/:id/cancel",
  asyncRoute(async (req, res) => {
    killRunningExecution(req.params.id);
    res.json(serializeMission(missionEngine.cancelMission(req.params.id)));
  })
);

// .claude/plans/18-mock-provider-safety-and-prod-start.md P1 (rejection flow) —
// "adjustment mission": instead of a rejection being a dead end, the user can
// give a correction ("that wasn't the token, use --secondary") that starts a
// new Execution on the SAME branch, building on the prior work. Allowed for a
// Mission the user has already seen a result for (rejected / failed /
// awaiting-approval / completed), never for one still queued/running. Bounded
// by the same iterate cap as any other iteration (Mission Engine policy).
const ITERABLE_STATUSES = new Set(["rejected", "failed", "awaiting-approval", "completed"]);

missionsRouter.post(
  "/missions/:id/iterate",
  asyncRoute(async (req, res) => {
    const adjustment = typeof req.body?.adjustment === "string" ? req.body.adjustment.trim() : "";
    if (!adjustment) {
      res.status(400).json({ error: "adjustment is required" });
      return;
    }

    const mission = missionEngine.getMission(req.params.id);
    if (!mission) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    if (!ITERABLE_STATUSES.has(mission.status)) {
      res.status(400).json({ error: `A Mission in '${mission.status}' can't take an adjustment right now.` });
      return;
    }
    if (!missionEngine.canIterate(req.params.id)) {
      res.status(400).json({ error: "This Mission has reached its adjustment limit — start a fresh Mission instead." });
      return;
    }

    // Consume an iterate attempt (Mission Engine's cap bookkeeping), move the
    // Mission back into the active lane, then start the follow-up Execution.
    missionEngine.registerIterateAttempt(req.params.id);
    missionEngine.transitionMissionStatus(req.params.id, "queued");
    startExecution(req.params.id, "iterate", { adjustment }).catch((err) => {
      console.error(`Failed to start adjustment Execution for mission ${req.params.id}:`, err);
    });

    const updated = missionEngine.getMission(req.params.id);
    res.status(201).json(updated ? serializeMission(updated) : { id: req.params.id });
  })
);

// .claude/plans/20-plano-consolidado.md Phase 7.4 (21-H) — Allow found the
// branch no longer rebases onto the base. One more round moves the branch onto
// the current base itself and asks the Developer to resolve what conflicts,
// counting toward the iterate cap like any other adjustment.
missionsRouter.post(
  "/missions/:id/resolve-conflict",
  asyncRoute(async (req, res) => {
    const mission = missionEngine.getMission(req.params.id);
    if (!mission) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    if (mission.status !== "awaiting-approval") {
      res.status(400).json({ error: "Only a Mission waiting for your approval can be brought up to date." });
      return;
    }
    if (!missionEngine.canIterate(req.params.id)) {
      res.status(400).json({ error: "This Mission has reached its adjustment limit; resolve the conflict by hand or start over." });
      return;
    }
    const can = canStartExecutionNow(req.params.id);
    if (!can.ok) {
      res.status(409).json({ error: can.reason });
      return;
    }
    missionEngine.registerIterateAttempt(req.params.id);
    await startExecution(req.params.id, "iterate", { adjustment: "Bring the branch up to date with the base branch.", resolveConflict: true });
    const updated = missionEngine.getMission(req.params.id);
    res.status(201).json(updated ? serializeMission(updated) : { id: req.params.id });
  })
);

// .claude/plans/20-plano-consolidado.md Phase 3 — what a 'waiting' Mission is
// waiting for (the team's question, the plan to review, or the resume time).
missionsRouter.get(
  "/missions/:id/waiting",
  asyncRoute(async (req, res) => {
    const details = getWaitingDetails(req.params.id);
    if (!details) {
      res.status(404).json({ error: "This Mission isn't waiting." });
      return;
    }
    res.json(details);
  })
);

// Phase 3.2 — the supervisor answers the team's question; the role that asked
// continues its own session with the answer. One answer per question: no chat.
missionsRouter.post(
  "/missions/:id/answer",
  asyncRoute(async (req, res) => {
    const answer = typeof req.body?.answer === "string" ? req.body.answer.trim() : "";
    if (!answer) {
      res.status(400).json({ error: "answer is required" });
      return;
    }
    const mission = missionEngine.getMission(req.params.id);
    if (!mission) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    if (mission.status !== "waiting" || mission.waiting_reason !== "needs-input") {
      res.status(400).json({ error: "This Mission isn't waiting for an answer." });
      return;
    }
    const can = canStartExecutionNow(req.params.id);
    if (!can.ok) {
      res.status(409).json({ error: can.reason });
      return;
    }
    await startExecution(req.params.id, "resume-after-input", { answer });
    const updated = missionEngine.getMission(req.params.id);
    res.status(201).json(updated ? serializeMission(updated) : { id: req.params.id });
  })
);

// Phase 3.3 — the plan checkpoint. approve: record a 'plan' Decision, keep the
// plan, and start the rest of the team from it. revise: record it, and the
// Planner revises in its own session (counts toward the iterate cap). discard:
// record it and cancel the Mission.
missionsRouter.post(
  "/missions/:id/plan",
  asyncRoute(async (req, res) => {
    const action = req.body?.action;
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    const mission = missionEngine.getMission(req.params.id);
    if (!mission) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    if (mission.status !== "waiting" || mission.waiting_reason !== "plan-review") {
      res.status(400).json({ error: "This Mission has no plan waiting for review." });
      return;
    }
    const details = getWaitingDetails(req.params.id);

    if (action === "discard") {
      missionEngine.recordDecision(req.params.id, { tier: "plan", outcome: "plan-discarded", rationale: note || null });
      res.json(serializeMission(missionEngine.cancelMission(req.params.id)));
      return;
    }
    if (action !== "approve" && action !== "revise") {
      res.status(400).json({ error: "action must be approve, revise or discard" });
      return;
    }
    if (action === "revise" && !note) {
      res.status(400).json({ error: "Say what should change in the plan." });
      return;
    }
    if (action === "revise" && !missionEngine.canIterate(req.params.id)) {
      res.status(400).json({ error: "This plan has been revised as many times as allowed. Approve it or discard the Mission." });
      return;
    }
    const can = canStartExecutionNow(req.params.id);
    if (!can.ok) {
      res.status(409).json({ error: can.reason });
      return;
    }

    if (action === "approve") {
      missionEngine.recordDecision(req.params.id, { tier: "plan", outcome: "plan-approved", rationale: note || null });
      missionEngine.setApprovedPlan(req.params.id, details?.plan ?? null);
      await startExecution(req.params.id, "resume-after-approval");
    } else {
      missionEngine.recordDecision(req.params.id, { tier: "plan", outcome: "plan-revised", rationale: note });
      missionEngine.registerIterateAttempt(req.params.id);
      await startExecution(req.params.id, "resume-after-input", { planRevision: note });
    }
    const updated = missionEngine.getMission(req.params.id);
    res.json(updated ? serializeMission(updated) : { id: req.params.id });
  })
);

// .claude/plans/18-mock-provider-safety-and-prod-start.md P1 item 11 — after a
// rejection, offer to discard the Mission's local branch so a rejected attempt
// doesn't leave an orphan branch behind. Local branch only — never origin,
// never the base branch (AT #7: git mechanics live in Execution Engine).
missionsRouter.post(
  "/missions/:id/discard-branch",
  asyncRoute(async (req, res) => {
    const mission = missionEngine.getMission(req.params.id);
    if (!mission) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    res.json(discardMissionBranch(req.params.id));
  })
);

missionsRouter.get(
  "/missions/:id/timeline",
  asyncRoute(async (req, res) => {
    res.json(missionEngine.missionTimeline(req.params.id));
  })
);

// .claude/plans/completed/05-checks-approval-gate.md — read-only, fetched on demand
// when the Approval Gate is open, never polled. 404/empty-shaped responses
// (no PR yet, no token configured, no GitHub remote) are all legitimate,
// non-error states — this is context, not a gate of its own.
missionsRouter.get(
  "/missions/:id/checks",
  asyncRoute(async (req, res) => {
    const mission = missionEngine.getMission(req.params.id);
    if (!mission) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    const project = missionEngine.getProject(mission.project_id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const token = missionEngine.getGithubToken(project.id);
    if (!token) {
      res.json({ configured: false });
      return;
    }

    const remoteUrl = getRemoteUrl(project.repo_path);
    const slug = remoteUrl ? parseGithubRemote(remoteUrl) : undefined;
    if (!slug) {
      res.json({ configured: true, error: "Project's git remote is not a recognizable GitHub URL" });
      return;
    }

    const executions = listExecutions(mission.id);
    const latest = executions[executions.length - 1];
    if (!latest) {
      res.json({ configured: true, error: "Mission has no Executions yet" });
      return;
    }
    // .claude/plans/completed/13-real-merge-on-approval.md — read the
    // stored, human-readable branch name; fall back to the pre-plan-13
    // pattern for Executions that predate the migration.
    const branch = latest.branch_name ?? `agentspace/${latest.id}`;

    const checks = await fetchChecks(token, slug.owner, slug.repo, project.default_branch, branch);
    res.json({ configured: true, ...checks });
  })
);

// .claude/plans/20-plano-consolidado.md Phase 1 — neutral facts for the
// Approval Gate (file rollup, secret guard, QA activity, cost). Read on demand
// when the gate is open, never polled.
missionsRouter.get(
  "/missions/:id/gate-facts",
  asyncRoute(async (req, res) => {
    if (!missionEngine.getMission(req.params.id)) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    res.json(getGateFacts(req.params.id));
  })
);

// Item 5 — what the last adjustment changed (read on demand at the gate).
missionsRouter.get(
  "/missions/:id/adjustment-changes",
  asyncRoute(async (req, res) => {
    if (!missionEngine.getMission(req.params.id)) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    res.json(getAdjustmentChanges(req.params.id));
  })
);

missionsRouter.get(
  "/missions/:id/adjustment-changes/diff",
  asyncRoute(async (req, res) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    const diff = path ? getAdjustmentFileDiff(req.params.id, path) : undefined;
    if (diff === undefined) {
      res.status(404).json({ error: "No such change" });
      return;
    }
    res.json({ diff });
  })
);

// .claude/plans/24-ideias-para-analisar.md item 6 — copy-ready PR text. AgentSpace
// still never opens the PR (plan 13); this only drafts the words.
missionsRouter.get(
  "/missions/:id/pr-description",
  asyncRoute(async (req, res) => {
    if (!missionEngine.getMission(req.params.id)) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    res.json(await getPrDescription(req.params.id));
  })
);

missionsRouter.get(
  "/missions/:id/executions",
  asyncRoute(async (req, res) => {
    res.json(listExecutionsWithCost(req.params.id));
  })
);

// The "what resulted" view (Journey 2 step 3) — union of Artifacts across all
// of the Mission's Executions, never the raw Evidence stream by default.
missionsRouter.get(
  "/missions/:id/artifacts",
  asyncRoute(async (req, res) => {
    res.json(listArtifactsForMission(req.params.id));
  })
);

missionsRouter.get(
  "/missions/:id/reviews",
  asyncRoute(async (req, res) => {
    res.json(missionEngine.listReviews(req.params.id));
  })
);

// docs/07-SCHEMA_API_CONTRACT.md §7.4 — author_type is always 'human' here,
// never client-supplied. AI-authored Reviews never go through this route.
missionsRouter.post(
  "/missions/:id/reviews",
  asyncRoute(async (req, res) => {
    const { artifact_ids, recommendation_outcome, recommendation_rationale, findings } = req.body ?? {};
    if (!artifact_ids || !recommendation_outcome || !recommendation_rationale) {
      res.status(400).json({ error: "artifact_ids, recommendation_outcome, and recommendation_rationale are required" });
      return;
    }
    const review = missionEngine.submitHumanReview(req.params.id, {
      artifact_ids,
      recommendation_outcome,
      recommendation_rationale,
      findings,
    });
    res.status(201).json(review);
  })
);

missionsRouter.get(
  "/missions/:id/decisions",
  asyncRoute(async (req, res) => {
    res.json(missionEngine.listDecisions(req.params.id));
  })
);

// docs/07-SCHEMA_API_CONTRACT.md §7.5 — the only write path for a Binding Decision.
missionsRouter.post(
  "/missions/:id/decisions",
  asyncRoute(async (req, res) => {
    const { tier, outcome, rationale, informed_by } = req.body ?? {};
    if (!tier || !outcome) {
      res.status(400).json({ error: "tier and outcome are required" });
      return;
    }
    // Plan Decisions only come from the plan checkpoint's own route below,
    // where approving/revising actually does something.
    if (tier === "plan") {
      res.status(400).json({ error: "Plan decisions are recorded from the plan review, not here." });
      return;
    }

    // .claude/plans/18-mock-provider-safety-and-prod-start.md P0 item 4 — a
    // Mission whose latest Execution ran in simulation (mock) mode must never
    // be approved into the merge flow. The UI disables "Allow" for a mock
    // Mission; this is the server-side guard behind it. Rejecting a mock
    // Mission is still fine — only the approve path is blocked.
    if (tier === "binding" && outcome === "approved" && isMissionMockRun(req.params.id)) {
      res.status(400).json({
        error:
          "This Mission ran in simulation mode (mock provider) — it made no real code changes and cannot be approved or pushed. Re-run it with the real provider first.",
      });
      return;
    }

    // Phase 7.7: a stacked Mission goes out after the one it builds on; refuse
    // BEFORE recording, so no 'approved' Decision exists for a push that can't happen.
    if (tier === "binding" && outcome === "approved") {
      const self = missionEngine.getMission(req.params.id);
      const parent = self?.base_mission_id ? missionEngine.getMission(self.base_mission_id) : undefined;
      if (parent && parent.status !== "completed") {
        res.status(409).json({
          error: `This Mission builds on "${parent.brief.slice(0, 60)}". Approve that one first, then this one.`,
        });
        return;
      }
    }

    const decision = missionEngine.recordDecision(req.params.id, { tier, outcome, rationale, informed_by });

    // .claude/plans/completed/13-real-merge-on-approval.md — "Allow" now has
    // a real mechanical consequence: rebase the Mission's branch onto the
    // base branch and push it. The Decision itself is recorded either way
    // (the human really did approve) — but only a real problem (rebase
    // conflict, push rejected) holds the Mission at 'awaiting-approval' so
    // the human can act on it; 'no-remote'/'no-execution' aren't failures,
    // just "nothing applicable to push," and still complete normally.
    let push: ReturnType<typeof approveAndPush> | undefined;
    if (tier === "binding" && outcome === "approved") {
      push = approveAndPush(req.params.id);
      const blocksCompletion = !push.pushed && (push.reason === "conflict" || push.reason === "push-failed" || push.reason === "parent-pending");
      missionEngine.transitionMissionStatus(req.params.id, blocksCompletion ? "awaiting-approval" : "completed");
    }

    res.status(201).json({ ...decision, push });
  })
);

missionsRouter.get(
  "/artifacts/:id",
  asyncRoute(async (req, res) => {
    const artifact = getArtifact(req.params.id);
    if (!artifact) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    res.json(artifact);
  })
);

// docs/06-DESIGN_GUARDRAILS.md #6 — "what resulted" needs the actual diff, not
// just the content_ref pointer. Diffs against the Project's repo_path, since
// the Execution's worktree is already gone by the time this is called.
missionsRouter.get(
  "/artifacts/:id/diff",
  asyncRoute(async (req, res) => {
    const diff = getArtifactDiff(req.params.id);
    if (diff === undefined) {
      res.status(404).json({ error: "Artifact not found or not a diff" });
      return;
    }
    res.json({ diff });
  })
);

missionsRouter.get(
  "/reviews/:id",
  asyncRoute(async (req, res) => {
    const review = missionEngine.getReview(req.params.id);
    if (!review) {
      res.status(404).json({ error: "Review not found" });
      return;
    }
    res.json(review);
  })
);
