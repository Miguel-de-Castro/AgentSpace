import { RunPanel } from "@/components/RunPanel";
import { CopyPrDescriptionButton } from "@/components/CopyPrDescriptionButton";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/StatusBadge";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import {
  ApiError,
  cancelMission,
  discardMissionBranch,
  getArtifactDiff,
  getEvidenceSummary,
  answerQuestion,
  createMission,
  resolveConflict,
  getAdjustmentChanges,
  getAdjustmentFileDiff,
  getGateFacts,
  getMission,
  getWaitingDetails,
  reviewPlan,
  getMissionChecks,
  getProject,
  iterateMission,
  listArtifactsForMission,
  listDecisions,
  listEvidence,
  listExecutions,
  listReviews,
  projectTrustLedger,
  recordDecision,
  subscribeToNotifications,
  updateProject,
} from "@/lib/api";
import { TeamBadges } from "@/components/TeamBadges";
import { DiffView, commentsToAdjustment, type DiffComment } from "@/components/DiffView";
import { roleProgress, type RoleProgress } from "@/lib/executionActivity";
import type {
  Artifact,
  Decision,
  Evidence,
  Execution,
  GateFacts,
  LightweightOutcome,
  Mission,
  MissionChecks,
  Review,
  TrustLedgerAggregate,
  WaitingDetails,
} from "@/lib/types";

const LIVE_STATUSES: Mission["status"][] = ["queued", "running"];
// Statuses whose screen should follow SSE updates: the live ones, plus a
// paused Mission, which AgentSpace resumes on its own.
const SUBSCRIBED_STATUSES: Mission["status"][] = [...LIVE_STATUSES, "waiting"];

export function MissionDetail() {
  const { missionId } = useParams<{ missionId: string }>();
  const [mission, setMission] = useState<Mission | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [executions, setExecutions] = useState<Execution[] | null>(null);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  // Phase 7.7: the Mission this one builds on (its Allow waits for that one's).
  const [parent, setParent] = useState<Mission | null>(null);
  // .claude/plans/15-live-execution-feedback.md Part 2 — Evidence of the
  // Execution that's still running, so the detail view can show live progress.
  const [runningExecution, setRunningExecution] = useState<Execution | null>(null);
  const [runningEvidence, setRunningEvidence] = useState<Evidence[]>([]);

  const load = useCallback(() => {
    if (!missionId) return;
    getMission(missionId).then(setMission);
    listArtifactsForMission(missionId).then(setArtifacts);
    listReviews(missionId).then(setReviews);
    listDecisions(missionId).then(setDecisions);
    listExecutions(missionId).then((execs) => {
      setExecutions(execs);
      const running = execs.find((e) => e.ended_at === null) ?? null;
      setRunningExecution(running);
      if (running) {
        listEvidence(running.id).then(setRunningEvidence);
      } else {
        setRunningEvidence([]);
      }
    });
  }, [missionId]);

  useEffect(load, [load]);

  useEffect(() => {
    if (mission?.base_mission_id) getMission(mission.base_mission_id).then(setParent).catch(() => setParent(null));
    else setParent(null);
  }, [mission?.base_mission_id, mission?.status]);

  // .claude/plans/17-ux-navigation-polish.md P1 — the Project's name for the
  // breadcrumb (context: which Project this Mission belongs to).
  useEffect(() => {
    if (mission?.project_id) getProject(mission.project_id).then((p) => setProjectName(p.name)).catch(() => {});
  }, [mission?.project_id]);

  // .claude/plans/15-live-execution-feedback.md Part 2 — first Mission-detail
  // screen to use the SSE stream (docs/03-ARCHITECTURE.md §7). While the
  // Mission is running, every incremental Evidence write (throttled server-side)
  // re-reads the record — no polling, no refresh habit (guardrail #2). The
  // subscription is dropped the moment the Mission leaves a live state.
  useEffect(() => {
    if (!mission || !SUBSCRIBED_STATUSES.includes(mission.status)) return;
    return subscribeToNotifications(() => load());
  }, [mission?.status, load]);

  if (!missionId || !mission) {
    return (
      <main className="max-w-4xl mx-auto p-8">
        <p className="text-muted-foreground">Loading…</p>
      </main>
    );
  }

  // .claude/plans/18-mock-provider-safety-and-prod-start.md P0 — did the
  // latest Execution run in simulation mode? A mock result must never look
  // like real agent work: it gets a loud banner, and the Approval Gate below
  // refuses to let it be approved/pushed.
  const latestExecution = executions?.[executions.length - 1] ?? null;
  const isMockRun = latestExecution?.provider === "mock";
  const visibleReviews =
    mission.status === "awaiting-approval" ? (reviews ?? []).filter((r) => r.author_type !== "ai_team_member") : reviews ?? [];

  return (
    <main className="max-w-4xl mx-auto p-8 space-y-8">
      <div>
        <Breadcrumbs
          items={[
            { label: "Projects", to: "/" },
            { label: projectName ?? "Project", to: `/projects/${mission.project_id}` },
            { label: mission.brief },
          ]}
        />
        <div className="flex items-start justify-between mt-2 gap-4">
          <BriefTitle brief={mission.brief} />
          <StatusBadge mission={mission} />
        </div>
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <p className="text-xs text-muted-foreground">Started {new Date(mission.created_at).toLocaleString()}</p>
          <TeamBadges team={mission.assigned_team} />
          {latestExecution?.branch_name && <CheckoutBranchButton branch={latestExecution.branch_name} />}
        </div>
        {mission.base_mission_id && <StackedNote parent={parent} />}
      </div>

      {latestExecution?.branch_name && <RunPanel projectId={mission.project_id} missionId={mission.id} />}

      {!LIVE_STATUSES.includes(mission.status) && isMockRun && <SimulationNotice />}

      {mission.status === "awaiting-approval" && (
        <ApprovalGate
          missionId={mission.id}
          projectId={mission.project_id}
          artifacts={artifacts}
          reviews={reviews}
          isMock={isMockRun}
          blockedBy={parent && parent.status !== "completed" ? parent.brief : null}
          onDecided={load}
        />
      )}

      {mission.status === "completed" && latestExecution?.branch_name && !isMockRun && (
        <div className="flex justify-end">
          <CopyPrDescriptionButton missionId={mission.id} />
        </div>
      )}

      {(mission.status === "awaiting-approval" || mission.status === "completed") && latestExecution?.branch_name && !isMockRun && (
        <FollowUpPanel mission={mission} />
      )}

      {(mission.status === "rejected" || mission.status === "failed") && (
        <>
          <AdjustmentPanel
            missionId={mission.id}
            branchName={latestExecution?.branch_name ?? null}
            status={mission.status}
            onChanged={load}
          />
          <StartOverPanel mission={mission} />
          {mission.status === "rejected" && <RulePanel mission={mission} />}
        </>
      )}

      {(mission.status === "completed" || mission.status === "rejected" || mission.status === "failed") && (
        <LightweightAcknowledgment missionId={mission.id} decisions={decisions} onRecorded={load} />
      )}

      {mission.status === "waiting" && mission.waiting_reason === "usage-limit" && (
        <PausedPanel
          mission={mission}
          onCancel={() =>
            cancelMission(mission.id)
              .then(load)
              .catch((err) => toast.error(err instanceof ApiError ? err.message : "Failed to cancel"))
          }
        />
      )}

      {mission.status === "waiting" && mission.waiting_reason === "needs-input" && (
        <QuestionPanel mission={mission} onChanged={load} />
      )}

      {mission.status === "waiting" && mission.waiting_reason === "plan-review" && (
        <PlanReviewPanel mission={mission} onChanged={load} />
      )}

      {LIVE_STATUSES.includes(mission.status) && (
        <LiveExecutionPanel
          mission={mission}
          execution={runningExecution}
          evidence={runningEvidence}
          onCancel={() =>
            cancelMission(mission.id)
              .then((m) => {
                // .claude/plans/15-live-execution-feedback.md Part 3 — the
                // atomic cancel may have found the Mission already finished.
                // Say so honestly instead of implying we stopped something.
                if (m.status !== "cancelled") {
                  toast.info("This Mission already finished, so nothing to cancel.");
                }
                load();
              })
              .catch((err) => toast.error(err instanceof ApiError ? err.message : "Failed to cancel"))
          }
        />
      )}

      {/* Outcome — what resulted, always the default view (guardrail #6). */}
      <section>
        <h2 className="text-sm font-medium text-foreground mb-3">What resulted</h2>
        {artifacts === null && <p className="text-muted-foreground text-sm">Loading…</p>}
        {artifacts?.length === 0 && <p className="text-muted-foreground text-sm">No Artifacts yet.</p>}
        <div className="space-y-2">
          {artifacts?.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </div>
      </section>

      {/* While the gate is open it already shows the AI Reviews ("A second
          opinion"); listing them again here just repeated the same text. */}
      {visibleReviews.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-foreground mb-3">Reviews</h2>
          <div className="space-y-2">
            {visibleReviews.map((review) => (
              <Card key={review.id} className="bg-surface border-outline py-0 gap-0">
                <CardContent className="py-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">
                      {review.author_type === "human" ? "You" : review.author_role ?? "Team Member"} ·{" "}
                      {/* AI recommendations must never read as resolved decisions (guardrail #8). */}
                      <span className="text-muted-foreground font-normal">
                        {review.author_type === "human" ? review.recommendation_outcome : `advises: ${review.recommendation_outcome}`}
                      </span>
                    </p>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">
                    <InlineCode text={review.recommendation_rationale} />
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {decisions && decisions.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-foreground mb-3">Decisions</h2>
          <div className="space-y-2">
            {decisions.map((decision) => (
              <Card key={decision.id} className="bg-surface border-outline py-0 gap-0">
                <CardContent className="py-3">
                  <p className="text-sm font-medium capitalize">{decision.outcome.replace(/-/g, " ")}</p>
                  {decision.rationale && <p className="text-sm text-muted-foreground mt-1">{decision.rationale}</p>}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Process — collapsed by default (guardrail #6): the raw Evidence stream per Execution. */}
      <section>
        <h2 className="text-sm font-medium text-foreground mb-3">Process</h2>
        <div className="space-y-2">
          {executions?.map((execution) => (
            <ProcessDisclosure key={execution.id} execution={execution} />
          ))}
        </div>
      </section>
    </main>
  );
}

// AI Reviews are written in Markdown-ish prose; `code` spans are the one bit
// worth rendering (file names, identifiers), without pulling in a Markdown lib.
function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          <code key={i} className="font-mono text-[0.85em] text-foreground/90 bg-surface-high rounded px-1 py-px">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        )
      )}
    </>
  );
}

// .claude/plans/20-plano-consolidado.md Phase 3 — the details behind a
// 'waiting' Mission (question or plan), fetched when the panel mounts.
function useWaitingDetails(missionId: string) {
  const [details, setDetails] = useState<WaitingDetails | null>(null);
  useEffect(() => {
    getWaitingDetails(missionId)
      .then(setDetails)
      .catch(() => setDetails(null));
  }, [missionId]);
  return details;
}

// Phase 3.2 — the team stopped to ask one thing only the supervisor knows. One
// answer resumes the same session; it's a question, not a chat.
function QuestionPanel({ mission, onChanged }: { mission: Mission; onChanged: () => void }) {
  const details = useWaitingDetails(mission.id);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setBusy(true);
    try {
      await answerQuestion(mission.id, answer.trim());
      toast.success("Answer sent. The team is continuing.");
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to send the answer");
      setBusy(false);
    }
  };

  return (
    <Card className="bg-surface-high border-outline py-0 gap-0">
      <CardContent className="py-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          {details?.role ? `The ${details.role} needs an answer before continuing` : "The team needs an answer before continuing"}
        </p>
        <p className="text-base font-medium leading-snug">{details?.question ?? "Loading the question…"}</p>
        <Textarea
          className="bg-surface"
          rows={3}
          placeholder="Your answer"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              cancelMission(mission.id)
                .then(onChanged)
                .catch((err) => toast.error(err instanceof ApiError ? err.message : "Failed to cancel"))
            }
          >
            Cancel Mission
          </Button>
          <Button className="flex-1" disabled={busy || !answer.trim()} onClick={send}>
            {busy ? "Sending…" : "Send answer"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Phase 3.3 — the plan checkpoint: the Planner worked alone and nothing was
// built yet. Approving starts the rest of the team from this plan; revising
// sends it back to the Planner with a note; discarding cancels the Mission.
function PlanReviewPanel({ mission, onChanged }: { mission: Mission; onChanged: () => void }) {
  const details = useWaitingDetails(mission.id);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const act = async (action: "approve" | "revise" | "discard") => {
    setBusy(true);
    try {
      await reviewPlan(mission.id, action, note.trim() || undefined);
      toast.success(
        action === "approve"
          ? "Plan approved. The team is building it."
          : action === "revise"
            ? "Revision requested. The Planner is updating the plan."
            : "Mission discarded."
      );
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to record your decision");
      setBusy(false);
    }
  };

  return (
    <Card className="bg-surface-high border-outline py-0 gap-0">
      <CardContent className="py-4 space-y-3">
        <div>
          <p className="text-base font-medium">Review the plan</p>
          <p className="text-sm text-muted-foreground mt-0.5">Nothing has been built yet. The team starts once you approve.</p>
        </div>
        <div className="rounded-md border border-outline bg-background px-3 py-2.5 max-h-96 overflow-y-auto">
          <p className="text-sm whitespace-pre-wrap leading-relaxed">
            {details?.plan ? <InlineCode text={details.plan} /> : "Loading the plan…"}
          </p>
        </div>
        {mission.acceptance_criteria.length > 0 && (
          <div>
            <p className="text-sm font-medium">Done when</p>
            <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground list-disc pl-5">
              {mission.acceptance_criteria.map((c, i) => (
                <li key={i}>
                  {c.text}
                  {c.source === "planner" && <span className="text-xs"> (added by the Planner)</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <Textarea
          className="bg-surface"
          rows={2}
          placeholder="What should change? Required to revise, optional note otherwise."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="flex gap-2 flex-wrap">
          {confirmDiscard ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => act("discard")} className="border-destructive/60 text-destructive">
                Yes, discard
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setConfirmDiscard(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={busy} onClick={() => setConfirmDiscard(true)}>
              Discard Mission
            </Button>
          )}
          <Button variant="outline" disabled={busy || !note.trim()} onClick={() => act("revise")}>
            Revise plan
          </Button>
          <Button className="flex-1" disabled={busy || !details?.plan} onClick={() => act("approve")}>
            Approve plan
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// .claude/plans/20-plano-consolidado.md Phase 3 (21-A) — the subscription's
// usage limit stopped the team mid-run. Nothing is lost: the partial work is
// committed on the branch and the same sessions continue after the reset.
// Informational, calm (guardrail #2): no countdown, just when it resumes.
function PausedPanel({ mission, onCancel }: { mission: Mission; onCancel: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  const resumeAt = mission.resume_at ? new Date(mission.resume_at) : null;
  const when = resumeAt
    ? resumeAt.toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <Card className="bg-surface border-outline py-0 gap-0">
      <CardContent className="py-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Paused: the usage limit was reached</p>
          <p className="text-xs text-muted-foreground mt-1">
            {when ? `AgentSpace resumes it on its own around ${when}.` : "AgentSpace resumes it on its own once the limit resets."}{" "}
            Work done so far is saved on the branch, and the team picks up where it stopped.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={cancelling}
          onClick={() => {
            setCancelling(true);
            onCancel();
          }}
        >
          {cancelling ? "Cancelling…" : "Cancel Mission"}
        </Button>
      </CardContent>
    </Card>
  );
}

// .claude/plans/15-live-execution-feedback.md Part 2 — what the user sees
// while a Mission runs. A discrete per-role state list (guardrail #2: never a
// percentage, nothing that invites refreshing), plus the current role's last
// plain-text action. Updates live via the SSE subscription above. The Cancel
// button lives here too — it's the one action available during a run, now
// backed by a real process kill (Part 3).
const ROLE_STATE_MARK: Record<RoleProgress["state"], string> = {
  done: "✓",
  running: "●",
  queued: "·",
};

const ROLE_STATE_LABEL: Record<RoleProgress["state"], string> = {
  done: "done",
  running: "running",
  queued: "queued",
};

function LiveExecutionPanel({
  mission,
  execution,
  evidence,
  onCancel,
}: {
  mission: Mission;
  execution: Execution | null;
  evidence: Evidence[];
  onCancel: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const progress = execution ? roleProgress(mission.assigned_team, execution, evidence) : [];

  const handleCancel = () => {
    setCancelling(true);
    onCancel();
  };

  return (
    <Card className="bg-surface border-outline py-0 gap-0">
      <CardContent className="py-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">
              {mission.status === "queued" ? "Queued, starting shortly" : "Working now"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">In good hands. No action needed while this runs.</p>
          </div>
          <Button variant="outline" size="sm" disabled={cancelling} onClick={handleCancel}>
            {cancelling ? "Cancelling…" : "Cancel Mission"}
          </Button>
        </div>

        {progress.length > 0 && (
          <ul className="space-y-1.5">
            {progress.map((row) => (
              <li key={row.role} className="flex items-baseline gap-3 text-sm">
                <span
                  className={
                    row.state === "running"
                      ? "text-primary"
                      : row.state === "done"
                        ? "text-success"
                        : "text-muted-foreground"
                  }
                >
                  {ROLE_STATE_MARK[row.state]}
                </span>
                <span className={row.state === "queued" ? "text-muted-foreground w-24 shrink-0" : "w-24 shrink-0"}>
                  {row.role}
                </span>
                <span className="text-muted-foreground truncate">
                  {row.state === "running" && row.detail ? `${ROLE_STATE_LABEL[row.state]}: ${row.detail}` : ROLE_STATE_LABEL[row.state]}
                </span>
              </li>
            ))}
          </ul>
        )}
        {execution && progress.length === 0 && (
          <p className="text-sm text-muted-foreground">Starting up…</p>
        )}
      </CardContent>
    </Card>
  );
}

function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isDiff = artifact.kind === "diff";
  // .claude/plans/16-build-verification.md — a test_report's full output lives
  // in content_ref (already in hand from the list), so it expands without a
  // fetch. A real build regression is the one case that earns visual weight
  // (guardrail #5: not manufactured drama, but a genuine regression is worth
  // seeing) — keyed off the verdict title the backend sets.
  const isBuildCheck = artifact.kind === "test_report";
  const isRegression = isBuildCheck && artifact.title.toLowerCase().includes("regression");
  const expandable = isDiff || isBuildCheck;

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && diff === null && isDiff) {
      getArtifactDiff(artifact.id)
        .then((res) => setDiff(res.diff))
        .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load diff"));
    }
  };

  const expandLabel = isDiff ? (expanded ? "Hide diff" : "View diff") : expanded ? "Hide output" : "View output";

  return (
    <Card className={isRegression ? "bg-surface border-destructive/60 py-0 gap-0" : "bg-surface border-outline py-0 gap-0"}>
      <CardContent className="py-3">
        <button className="w-full flex items-center justify-between text-left" onClick={toggle} disabled={!expandable}>
          <div className="min-w-0">
            <p className={`text-sm truncate ${isBuildCheck ? "font-medium" : "font-mono"}`}>
              {isRegression && <span className="text-destructive mr-1.5">⚠</span>}
              {artifact.title}
            </p>
            {artifact.summary && <p className="text-sm text-muted-foreground mt-1">{artifact.summary}</p>}
          </div>
          {expandable && <span className="text-muted-foreground text-sm shrink-0 ml-3">{expandLabel}</span>}
        </button>
        {expanded && (
          <pre className="mt-3 text-xs font-mono overflow-x-auto bg-background rounded-md p-3 text-muted-foreground whitespace-pre">
            {isDiff ? error ?? diff ?? "Loading…" : artifact.content_ref}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

// .claude/plans/17-ux-navigation-polish.md P1 — validating a Mission means
// checking out its branch locally, and hunting down the branch name was a real
// point of friction in the E2E test. This copies the exact `git checkout`
// command so it's one paste away.
function CheckoutBranchButton({ branch }: { branch: string }) {
  const [copied, setCopied] = useState(false);
  const command = `git checkout ${branch}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy. Here's the command: " + command);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy: ${command}`}
      className="text-xs font-mono px-2 py-0.5 rounded-md border border-outline text-muted-foreground hover:text-foreground hover:border-primary/60 transition-colors"
    >
      {copied ? "copied ✓" : `⧉ git checkout ${branch}`}
    </button>
  );
}

// .claude/plans/18-mock-provider-safety-and-prod-start.md P0 item 2 — a loud,
// unmissable notice when the Mission's result came from the mock provider, so a
// simulation is never mistaken for real agent work anywhere it's viewed (not
// only inside the Approval Gate). Shown on any finished Mock Mission.
function SimulationNotice() {
  return (
    <Card className="bg-surface border-primary/50 py-0 gap-0">
      <CardContent className="py-3">
        <p className="text-sm font-medium text-primary flex items-center gap-1.5">
          <span aria-hidden>▲</span> Simulation: no real code changes
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          This Mission ran with the mock provider, not a real agent. Any Artifacts here are from the simulation and
          nothing was actually built. Re-run with <span className="font-mono">AGENTSPACE_PROVIDER=claude-code</span> for
          real work.
        </p>
      </CardContent>
    </Card>
  );
}

// .claude/plans/18-mock-provider-safety-and-prod-start.md P1 (rejection flow) —
// a rejection (or failure) isn't a dead end. The user can (a) send an
// adjustment that starts a fresh Execution on the SAME branch, applying the
// correction on top of the prior work, and (b) discard the Mission's local
// branch so it doesn't linger as an orphan. Both are explicit choices, never
// automatic (guardrail #8).
function AdjustmentPanel({
  missionId,
  branchName,
  status,
  onChanged,
}: {
  missionId: string;
  branchName: string | null;
  status: "rejected" | "failed";
  onChanged: () => void;
}) {
  const [adjustment, setAdjustment] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [branchGone, setBranchGone] = useState(false);

  const sendAdjustment = async () => {
    const text = adjustment.trim();
    if (!text) return;
    setBusy(true);
    try {
      await iterateMission(missionId, text);
      toast.success("Adjustment started. A new run is picking up your correction on the same branch.");
      setAdjustment("");
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to start adjustment");
    } finally {
      setBusy(false);
    }
  };

  const discardBranch = async () => {
    setDiscarding(true);
    try {
      const res = await discardMissionBranch(missionId);
      if (res.deleted) {
        toast.success(`Discarded branch ${res.branch_name}.`);
        setBranchGone(true);
      } else {
        toast.info("No branch to discard, it may already be gone.");
        setBranchGone(true);
      }
      setConfirmingDiscard(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to discard branch");
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <Card className="bg-surface border-outline">
      <CardHeader>
        <CardTitle className="text-base">{status === "failed" ? "Try again with direction" : "Not quite? Adjust it"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Tell the team what to change and a new run will pick up on the same branch, building on what's already there,
          instead of starting over.
        </p>
        <Textarea
          className="bg-surface"
          placeholder="e.g. That wasn't the right color token. Change --secondary instead, and keep it green."
          value={adjustment}
          onChange={(e) => setAdjustment(e.target.value)}
        />
        <div className="flex items-center gap-2 flex-wrap">
          <Button disabled={busy || !adjustment.trim()} onClick={sendAdjustment}>
            {busy ? "Starting…" : "Send adjustment"}
          </Button>
          {branchName && !branchGone && !confirmingDiscard && (
            <Button variant="outline" onClick={() => setConfirmingDiscard(true)}>
              Discard branch
            </Button>
          )}
          {branchName && !branchGone && confirmingDiscard && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">
                Delete local branch <span className="font-mono text-xs">{branchName}</span>?
              </span>
              <Button variant="outline" size="sm" disabled={discarding} onClick={discardBranch}>
                {discarding ? "Discarding…" : "Yes, discard"}
              </Button>
              <Button variant="outline" size="sm" disabled={discarding} onClick={() => setConfirmingDiscard(false)}>
                Keep it
              </Button>
            </div>
          )}
        </div>
        {branchName && !branchGone && (
          <p className="text-xs text-muted-foreground">
            Discarding removes only the local branch <span className="font-mono">{branchName}</span>, never anything on
            the remote.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// .claude/plans/20-plano-consolidado.md Phase 7.2 (F6) — when the brief itself
// was wrong, adjusting the result keeps the wrong premise. Starting over creates
// a NEW Mission with the corrected brief (same Team and criteria) on a fresh
// branch; this one stays in the record as it is.
function StartOverPanel({ mission }: { mission: Mission }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState(mission.brief);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const created = await createMission(mission.project_id, {
        brief: brief.trim(),
        assigned_team: mission.assigned_team,
        acceptance_criteria: mission.acceptance_criteria.filter((c) => c.source === "user").map((c) => c.text),
        plan_checkpoint: mission.plan_checkpoint,
        reference_material: mission.reference_material ?? undefined,
      });
      toast.success("New Mission started with the corrected brief.");
      navigate(`/missions/${created.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to start the new Mission");
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-2" onClick={() => setOpen(true)}>
        The brief was the problem? Start over with a corrected brief
      </button>
    );
  }
  return (
    <Card className="bg-surface border-outline py-0 gap-0">
      <CardContent className="py-4 space-y-3">
        <p className="text-sm font-medium">Start over with a corrected brief</p>
        <p className="text-xs text-muted-foreground">
          A new Mission with the same Team and criteria, on a new branch. This one stays as it is.
        </p>
        <Textarea className="bg-surface-high" rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} />
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !brief.trim() || brief.trim() === mission.brief} onClick={start}>
            {busy ? "Starting…" : "Start new Mission"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// .claude/plans/20-plano-consolidado.md Phase 7.1 (F6) — after a rejection, the
// cheapest fix is often a rule the team didn't know. Kept as a Project
// instruction (applies from the next run), or turned into a Mission that adds
// it to the repo's own CLAUDE.md (so it also helps outside AgentSpace).
function RulePanel({ mission }: { mission: Mission }) {
  const navigate = useNavigate();
  const [rule, setRule] = useState("");
  const [busy, setBusy] = useState(false);

  const saveAsInstruction = async () => {
    setBusy(true);
    try {
      const project = await getProject(mission.project_id);
      const current = project.instructions?.trim();
      await updateProject(project.id, { instructions: current ? `${current}\n${rule.trim()}` : rule.trim() });
      toast.success("Saved as a Project instruction. It applies from the next run.");
      setRule("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save the rule");
    } finally {
      setBusy(false);
    }
  };

  const addToRepo = async () => {
    setBusy(true);
    try {
      const created = await createMission(mission.project_id, {
        brief: `Add this rule to the repository's CLAUDE.md (create the file at the repository root if it doesn't exist), in the section that fits best, without changing anything else: ${rule.trim()}`,
        assigned_team: [{ role: "Developer" }],
      });
      toast.success("Mission started to add the rule to CLAUDE.md.");
      navigate(`/missions/${created.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to start the Mission");
      setBusy(false);
    }
  };

  return (
    <Card className="bg-surface border-outline py-0 gap-0">
      <CardContent className="py-4 space-y-3">
        <div>
          <p className="text-sm font-medium">Would a rule have prevented this?</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Write it once and the team follows it next time, for example &quot;Never edit files under migrations/&quot;.
          </p>
        </div>
        <Textarea className="bg-surface-high" rows={2} value={rule} onChange={(e) => setRule(e.target.value)} />
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" disabled={busy || !rule.trim()} onClick={saveAsInstruction}>
            Save as Project instruction
          </Button>
          <Button variant="outline" disabled={busy || !rule.trim()} onClick={addToRepo}>
            Add it to the repo&apos;s CLAUDE.md
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ApprovalGate({
  missionId,
  projectId,
  artifacts,
  reviews,
  isMock,
  blockedBy,
  onDecided,
}: {
  missionId: string;
  projectId: string;
  artifacts: Artifact[] | null;
  reviews: Review[] | null;
  isMock: boolean;
  /** Phase 7.7: brief of the unapproved Mission this one is stacked on, if any. */
  blockedBy?: string | null;
  onDecided: () => void;
}) {
  // .claude/plans/20-cross-model-review-council.md Phase 1 — an AI Team Member's
  // Review (e.g. the Challenger's) is shown right here at decision time as
  // advice, never as a resolved decision (guardrail #8). The full Reviews list
  // still lives below; this is the "second opinion in your ear" at the gate.
  const aiReviews = (reviews ?? []).filter((r) => r.author_type === "ai_team_member");
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<MissionChecks | null>(null);
  // Phase 7.4 — set when Allow's rebase hit a conflict with the base branch.
  const [conflict, setConflict] = useState<string | null>(null);
  // Phase 7.5 — line comments on the diff, sent together as one adjustment.
  const [comments, setComments] = useState<DiffComment[]>([]);

  const sendComments = async () => {
    setBusy(true);
    try {
      await iterateMission(missionId, commentsToAdjustment(comments));
      toast.success(`Sent ${comments.length} ${comments.length === 1 ? "comment" : "comments"} to the Developer.`);
      setComments([]);
      onDecided();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to send the comments");
    } finally {
      setBusy(false);
    }
  };
  const [facts, setFacts] = useState<GateFacts | null>(null);

  // .claude/plans/16-build-verification.md + (b) resolved 2026-09-09: a build
  // regression is SURFACED at decision time, never blocks (the supervisor stays
  // in control — calm mission-control, guardrail #8). The banner lives inside
  // the gate, right where the choice is made, not only in the Artifacts list.
  const regression = artifacts?.find(
    (a) => a.kind === "test_report" && a.title.toLowerCase().includes("regression")
  );

  useEffect(() => {
    getMissionChecks(missionId)
      .then(setChecks)
      .catch(() => setChecks(null));
    getGateFacts(missionId)
      .then(setFacts)
      .catch(() => setFacts(null));
  }, [missionId]);

  // .claude/plans/completed/13-real-merge-on-approval.md — "Allow" now
  // really rebases + pushes the Mission's branch; the human still opens
  // the PR themselves afterward. A push that didn't go through (conflict,
  // rejected) is reported plainly, not disguised as success.
  const decide = async (outcome: "approved" | "rejected") => {
    setBusy(true);
    try {
      const result = await recordDecision(missionId, { tier: "binding", outcome, rationale: rationale.trim() || undefined });
      if (outcome === "approved" && result.push) {
        if (result.push.pushed) {
          toast.success(`Pushed to origin/${result.push.branch_name}. Open a PR when you're ready to merge it.`);
        } else if (result.push.reason === "conflict") {
          setConflict(result.push.detail ?? "");
        } else if (result.push.reason === "push-failed") {
          toast.error(`Approved, but the push failed: ${result.push.detail ?? "unknown error"}`);
        }
      }
      onDecided();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to record decision");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="bg-surface-high border-outline">
      <CardHeader>
        <CardTitle className="text-base">Waiting on you</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Allow rebases this Mission&apos;s branch onto the base branch and pushes it to origin. Nothing is merged: you
          open the PR yourself.
        </p>
        {isMock && (
          <div className="rounded-md border border-primary/50 bg-primary/10 px-3 py-2.5">
            <p className="text-sm font-medium text-primary flex items-center gap-1.5">
              <span aria-hidden>▲</span> Simulation: not real agent work
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              This Mission ran in mock mode and made no real code changes, so it can't be approved or pushed. Re-run it
              with the real provider (<span className="font-mono">AGENTSPACE_PROVIDER=claude-code</span>) to produce
              something to review.
            </p>
          </div>
        )}
        {conflict !== null && (
          <div className="rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2.5 space-y-2">
            <p className="text-sm font-medium text-destructive">The branch conflicts with the latest base branch</p>
            <p className="text-xs text-muted-foreground">
              Nothing was pushed. The team can move the branch onto the latest base and resolve the conflicting files, then
              it comes back here for your approval.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  resolveConflict(missionId)
                    .then(() => {
                      toast.success("The Developer is resolving the conflict.");
                      setConflict(null);
                      onDecided();
                    })
                    .catch((err) => toast.error(err instanceof ApiError ? err.message : "Failed to start"))
                }
              >
                Ask the Developer to resolve it
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConflict(null)}>
                I&apos;ll resolve it myself
              </Button>
            </div>
          </div>
        )}
        {facts && facts.secret_paths.length > 0 && (
          <div className="rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2.5">
            <p className="text-sm font-medium text-destructive flex items-center gap-1.5">
              <span aria-hidden>⚠</span> Possible secrets left out of this Mission
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              The team created or changed files that look like secrets. They were kept out of the commit, so Allow
              won&apos;t push them, but check why they were touched:
            </p>
            <ul className="mt-1.5 text-xs font-mono text-destructive/90 space-y-0.5">
              {facts.secret_paths.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        {regression && (
          <div className="rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2.5">
            <p className="text-sm font-medium text-destructive flex items-center gap-1.5">
              <span aria-hidden>⚠</span> Build regression detected
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {regression.summary ??
                "The build passed before this Mission but fails on its result. You can still Allow it, but review the build report below first."}
            </p>
          </div>
        )}
        {aiReviews.length > 0 && (
          <div className="border border-outline rounded-md bg-background overflow-hidden">
            <p className="text-xs font-medium text-foreground px-3 py-2 border-b border-outline">
              A second opinion
            </p>
            {aiReviews.map((review) => (
              <div key={review.id} className="px-3 py-2 border-b border-outline last:border-b-0">
                <p className="text-sm font-medium">
                  {review.author_role ?? "Team Member"}{" "}
                  <span className="text-muted-foreground font-normal">advises: {review.recommendation_outcome}</span>
                </p>
                <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">
                  <InlineCode text={review.recommendation_rationale} />
                </p>
              </div>
            ))}
            <p className="text-xs text-muted-foreground px-3 py-2">Advice from the AI team. The call is still yours.</p>
          </div>
        )}
        {facts && <CriteriaPanel facts={facts} />}
        {facts && (
          <GateFactsPanel facts={facts} comments={comments} onAddComment={(c) => setComments((prev) => [...prev, c])} />
        )}
        <AdjustmentChangesPanel missionId={missionId} comments={comments} onAddComment={(c) => setComments((prev) => [...prev, c])} />
        {comments.length > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 px-3 py-2">
            <p className="text-sm">
              {comments.length} {comments.length === 1 ? "comment" : "comments"} on the diff
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setComments([])}>
                Clear
              </Button>
              <Button size="sm" disabled={busy} onClick={sendComments}>
                Ask for these changes
              </Button>
            </div>
          </div>
        )}
        {checks?.configured && <ChecksPanel checks={checks} />}
        <TrustLedgerPanel projectId={projectId} artifacts={artifacts} />
        {!isMock && (
          <div className="flex justify-end">
            <CopyPrDescriptionButton missionId={missionId} />
          </div>
        )}
        <Textarea
          className="bg-surface"
          placeholder="Optional note (e.g. reason for declining)"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
        />
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy} onClick={() => decide("rejected")} className="flex-1">
            Don't Allow
          </Button>
          <Button disabled={busy || isMock || !!blockedBy} onClick={() => decide("approved")} className="flex-1">
            {isMock ? "Allow (unavailable in simulation)" : blockedBy ? "Allow (approve the one it builds on first)" : "Allow"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// .claude/plans/20-plano-consolidado.md Phase 1 — neutral facts next to the
// decision: what the branch touches (1.5), whether QA actually ran something
// (1.4) and what the run cost (1.6). Plain statements, never a score, never a
// gate of their own (guardrail #8).
function formatUsd(value: number): string {
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

type RollupFile = NonNullable<GateFacts["rollup"]>["files"][number];

// .claude/plans/20-plano-consolidado.md Phase 4 — what "done" means and what
// the AI reviewers said about it, criterion by criterion, then their findings
// with blocking ones first. Advice only: none of it disables Allow (#8).
const VERDICT_CLASS = { met: "text-success", "not-met": "text-destructive", unclear: "text-muted-foreground" } as const;
const VERDICT_LABEL = { met: "met", "not-met": "not met", unclear: "unclear" } as const;
const SEVERITY_CLASS = { blocking: "text-destructive", warning: "text-primary", info: "text-muted-foreground" } as const;

function CriteriaPanel({ facts }: { facts: GateFacts }) {
  const { criteria, findings, drift } = facts;
  const unplanned = drift?.unplanned ?? [];
  return (
    <div className="border border-outline rounded-md bg-background overflow-hidden text-sm">
      <div className="px-3 py-2.5 border-b border-outline last:border-b-0">
        <p className="font-medium">Done when</p>
        {criteria.length === 0 ? (
          <p className="text-muted-foreground mt-1">No acceptance criteria for this Mission.</p>
        ) : (
          <ol className="mt-1.5 space-y-2 list-decimal pl-5">
            {criteria.map((c, i) => (
              <li key={i}>
                <span>{c.text}</span>
                {c.source === "planner" && <span className="text-xs text-muted-foreground"> (added by the Planner)</span>}
                {c.verdicts.length === 0 ? (
                  <p className="text-xs text-muted-foreground mt-0.5">Not judged by any reviewer.</p>
                ) : (
                  c.verdicts.map((v, j) => (
                    <p key={j} className="text-xs mt-0.5">
                      <span className="text-muted-foreground">{v.by}: </span>
                      <span className={VERDICT_CLASS[v.verdict]}>{VERDICT_LABEL[v.verdict]}</span>
                      {v.note && <span className="text-muted-foreground">. {v.note}</span>}
                    </p>
                  ))
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
      {findings.length > 0 && (
        <div className="px-3 py-2.5 border-b border-outline last:border-b-0">
          <p className="font-medium">Findings</p>
          <ul className="mt-1.5 space-y-1.5">
            {findings.map((f, i) => (
              <li key={i} className="text-xs leading-relaxed">
                <span className={`font-medium ${SEVERITY_CLASS[f.severity]}`}>{f.severity}</span>{" "}
                {f.path && (
                  <span className="font-mono text-foreground/80">
                    {f.path}
                    {f.line ? `:${f.line}` : ""}
                  </span>
                )}{" "}
                <span className="text-muted-foreground">
                  {f.text} ({f.by})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {unplanned.length > 0 && (
        <div className="px-3 py-2.5 text-xs">
          <p>
            {unplanned.length} {unplanned.length === 1 ? "file changed that wasn't" : "files changed that weren't"} in the plan:
          </p>
          <p className="font-mono text-muted-foreground mt-0.5 break-all">{unplanned.join(", ")}</p>
        </div>
      )}
    </div>
  );
}

function GateFactsPanel({
  facts,
  comments,
  onAddComment,
}: {
  facts: GateFacts;
  comments: DiffComment[];
  onAddComment: (c: DiffComment) => void;
}) {
  const [filesOpen, setFilesOpen] = useState(false);
  const { rollup, qa, cost } = facts;
  if (!rollup && !qa && !cost.total) return null;

  return (
    <div className="border border-outline rounded-md bg-background overflow-hidden text-sm">
      {rollup && (
        <div className="border-b border-outline last:border-b-0">
          <button
            className="w-full flex items-center justify-between px-3 py-2 text-left"
            onClick={() => setFilesOpen((o) => !o)}
          >
            <span>
              {rollup.files.length} {rollup.files.length === 1 ? "file" : "files"} ·{" "}
              <span className="text-success">+{rollup.added}</span>{" "}
              <span className="text-destructive">−{rollup.removed}</span>
            </span>
            <span className="text-muted-foreground text-xs">{filesOpen ? "Hide" : "Show files"}</span>
          </button>
          {filesOpen && (
            <ul className="px-3 pb-2 space-y-1">
              {rollup.files.map((f) => (
                <RollupFileRow key={f.path} file={f} comments={comments} onAddComment={onAddComment} />
              ))}
            </ul>
          )}
        </div>
      )}
      {qa && (
        <div className="px-3 py-2 border-b border-outline last:border-b-0">
          {qa.command_count > 0 ? (
            <>
              <p>
                QA ran {qa.command_count} {qa.command_count === 1 ? "command" : "commands"}
              </p>
              <ul className="mt-1 space-y-0.5">
                {qa.commands.map((c, i) => (
                  <li key={i} className="text-xs font-mono text-muted-foreground truncate">
                    $ {c}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-muted-foreground">QA didn&apos;t run any command. It only read the code.</p>
          )}
        </div>
      )}
      {cost.total && (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          <p>
            {formatUsd(cost.total.cost_usd)} API-equivalent · {formatTokens(cost.total.input_tokens)} in ·{" "}
            {formatTokens(cost.total.output_tokens)} out · {formatDuration(cost.total.duration_ms)}
          </p>
          {cost.by_role.length > 1 && (
            <p className="mt-0.5">{cost.by_role.map((r) => `${r.role ?? "Team"} ${formatUsd(r.cost_usd)}`).join(" · ")}</p>
          )}
          <p className="mt-0.5">With a subscription login this is what the API would have charged, not a bill.</p>
        </div>
      )}
    </div>
  );
}

// .claude/plans/24-ideias-para-analisar.md item 5 — after "Adjust", the gate shows
// the whole branch's change; this answers the other question, "did my adjustment
// do what I asked?", by showing only what the last attempt changed on top of the
// previous one. Hidden when there's only one attempt.
function AdjustmentChangesPanel({
  missionId,
  comments,
  onAddComment,
}: {
  missionId: string;
  comments: DiffComment[];
  onAddComment: (c: DiffComment) => void;
}) {
  const [changes, setChanges] = useState<Awaited<ReturnType<typeof getAdjustmentChanges>>>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    getAdjustmentChanges(missionId)
      .then(setChanges)
      .catch(() => setChanges(null));
  }, [missionId]);

  if (!changes) return null;
  return (
    <div className="border border-outline rounded-md bg-background overflow-hidden text-sm">
      <button className="w-full flex items-center justify-between px-3 py-2 text-left" onClick={() => setOpen((o) => !o)}>
        <span>What the last adjustment changed</span>
        <span className="text-muted-foreground text-xs">
          {changes.files.length === 0
            ? "Nothing changed"
            : `${changes.files.length} ${changes.files.length === 1 ? "file" : "files"} · ${open ? "Hide" : "Show"}`}
        </span>
      </button>
      {open && changes.files.length > 0 && (
        <ul className="px-3 pb-2 space-y-1">
          {changes.files.map((f) => (
            <AdjustmentFileRow key={f.path} missionId={missionId} file={f} comments={comments} onAddComment={onAddComment} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AdjustmentFileRow({
  missionId,
  file,
  comments,
  onAddComment,
}: {
  missionId: string;
  file: { path: string; added: number | null; removed: number | null };
  comments: DiffComment[];
  onAddComment: (c: DiffComment) => void;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && diff === null) {
      getAdjustmentFileDiff(missionId, file.path)
        .then((d) => setDiff(d.diff))
        .catch(() => setDiff("Couldn't load this diff."));
    }
  };

  return (
    <li>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-mono truncate">{file.path}</span>
        <span className="flex items-center gap-3 shrink-0">
          {file.added === null ? (
            <span className="text-muted-foreground">binary</span>
          ) : (
            <span>
              <span className="text-success">+{file.added}</span> <span className="text-destructive">−{file.removed}</span>
            </span>
          )}
          <button className="text-muted-foreground hover:text-foreground" onClick={toggle}>
            {open ? "Hide diff" : "View diff"}
          </button>
        </span>
      </div>
      {open &&
        (diff === null ? (
          <p className="mt-1.5 text-xs text-muted-foreground">Loading…</p>
        ) : (
          <DiffView path={file.path} diff={diff} comments={comments} onAddComment={onAddComment} />
        ))}
    </li>
  );
}

function RollupFileRow({
  file,
  comments,
  onAddComment,
}: {
  file: RollupFile;
  comments: DiffComment[];
  onAddComment: (c: DiffComment) => void;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && diff === null && file.artifact_id) {
      getArtifactDiff(file.artifact_id)
        .then((d) => setDiff(d.diff))
        .catch(() => setDiff("Couldn't load this diff."));
    }
  };

  return (
    <li>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-mono truncate">{file.path}</span>
        <span className="flex items-center gap-3 shrink-0">
          {file.added === null ? (
            <span className="text-muted-foreground">binary</span>
          ) : (
            <span>
              <span className="text-success">+{file.added}</span> <span className="text-destructive">−{file.removed}</span>
            </span>
          )}
          {file.artifact_id && (
            <button className="text-muted-foreground hover:text-foreground" onClick={toggle}>
              {open ? "Hide diff" : "View diff"}
            </button>
          )}
        </span>
      </div>
      {open &&
        (diff === null ? (
          <p className="mt-1.5 text-xs text-muted-foreground">Loading…</p>
        ) : (
          <DiffView path={file.path} diff={diff} comments={comments} onAddComment={onAddComment} />
        ))}
    </li>
  );
}

// Journey 4 — a quick, non-blocking reaction on any finished Mission's
// output, distinct from the Approval Gate's Binding Decision above: costs
// nothing, never required, never blocks anything (docs/20-UBIQUITOUS_LANGUAGE.md's
// Decision entry). Leaving no reaction is equally valid, so this never nags —
// it just quietly offers the three reactions, with the most recent one (if
// any) shown as currently selected.
const LIGHTWEIGHT_LABEL: Record<LightweightOutcome, string> = {
  "acknowledged-good": "Good",
  "acknowledged-not-wanted": "Not what I wanted",
  "flag-for-later": "Worth a second look",
};

function LightweightAcknowledgment({
  missionId,
  decisions,
  onRecorded,
}: {
  missionId: string;
  decisions: Decision[] | null;
  onRecorded: () => void;
}) {
  const [busy, setBusy] = useState<LightweightOutcome | null>(null);

  const current = decisions?.find((d) => d.tier === "lightweight")?.outcome as LightweightOutcome | undefined;

  const react = async (outcome: LightweightOutcome) => {
    setBusy(outcome);
    try {
      await recordDecision(missionId, { tier: "lightweight", outcome });
      onRecorded();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to record reaction");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Your take, no pressure:</span>
      {(Object.keys(LIGHTWEIGHT_LABEL) as LightweightOutcome[]).map((outcome) => (
        <Button
          key={outcome}
          size="sm"
          variant={current === outcome ? "default" : "outline"}
          disabled={busy !== null}
          onClick={() => react(outcome)}
        >
          {busy === outcome ? "…" : LIGHTWEIGHT_LABEL[outcome]}
        </Button>
      ))}
    </div>
  );
}

// .claude/plans/05-checks-approval-gate.md — external, read-only context.
// Never a second gate: no styling here implies a decision, only state
// (guardrail #8). Rendered only when a token is configured for the Project;
// silently absent otherwise rather than nagging to set one up.
function ChecksPanel({ checks }: { checks: MissionChecks }) {
  if (checks.error) {
    return <p className="text-xs text-muted-foreground border border-outline rounded-md px-3 py-2">Checks unavailable: {checks.error}</p>;
  }

  const rows: { label: string; detail: string; state: "ok" | "warn" | "bad" | "neutral" }[] = [];

  if (checks.branch) {
    rows.push({
      label: "Branch",
      detail: checks.branch.behind_by > 0 ? `${checks.branch.behind_by} commit(s) behind ${checks.branch.base}` : `Up to date with ${checks.branch.base}`,
      state: checks.branch.behind_by > 0 ? "warn" : "ok",
    });
  }
  if (checks.pull_request) {
    rows.push({
      label: "Pull Request",
      detail: `#${checks.pull_request.number}${checks.pull_request.draft ? " (draft)" : ""}`,
      state: checks.pull_request.state === "open" ? "neutral" : "ok",
    });
  } else {
    rows.push({ label: "Pull Request", detail: "No PR opened for this branch yet", state: "neutral" });
  }
  if (checks.ci) {
    rows.push({
      label: "CI checks",
      detail: checks.ci.total === 0 ? "None configured" : `${checks.ci.passed} of ${checks.ci.total} passed`,
      state: checks.ci.state === "success" ? "ok" : checks.ci.state === "failure" ? "bad" : checks.ci.state === "pending" ? "warn" : "neutral",
    });
  }
  if (checks.reviewers_requesting_changes !== null && checks.reviewers_requesting_changes !== undefined) {
    rows.push({
      label: "Review threads",
      detail: checks.reviewers_requesting_changes > 0 ? `${checks.reviewers_requesting_changes} reviewer(s) requesting changes` : "Clear",
      state: checks.reviewers_requesting_changes > 0 ? "warn" : "ok",
    });
  }

  const stateColor: Record<string, string> = {
    ok: "bg-success",
    warn: "bg-primary",
    bad: "bg-destructive",
    neutral: "bg-muted-foreground",
  };

  return (
    <div className="border border-outline rounded-md bg-background overflow-hidden">
      <p className="text-xs font-medium text-foreground px-3 py-2 border-b border-outline">Checks</p>
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-3 px-3 py-2 border-b border-outline last:border-b-0 text-sm">
          <div>
            <span>{row.label}</span>
            <p className="text-xs text-muted-foreground">{row.detail}</p>
          </div>
          <span className={`w-2 h-2 rounded-full shrink-0 ${stateColor[row.state]}`} />
        </div>
      ))}
    </div>
  );
}

// .claude/plans/12-contextual-track-record.md — Journey 8, step 1: the Trust
// Ledger surfaced AT the moment of deciding, filtered to the area this Mission
// touches, offered as context and never as an instruction (guardrail #8, same
// as ChecksPanel). It stays absent — not empty, not "1 of 1" — until there's a
// real pattern (MIN_HISTORY prior binding Decisions in the same path prefix).
const MIN_HISTORY = 2;

// Longest common path prefix across the Mission's diff Artifacts (whose titles
// are file paths, src/execution-engine/index.ts). Used as the LIKE prefix the
// Trust Ledger already supports. A single changed file yields its own full
// path; multiple files yield their common leading segments.
function commonPathPrefix(artifacts: Artifact[] | null): string | null {
  const paths = (artifacts ?? []).filter((a) => a.kind === "diff").map((a) => a.title);
  if (paths.length === 0) return null;
  const split = paths.map((p) => p.split("/"));
  const first = split[0];
  const common: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (split.every((s) => s[i] === seg)) common.push(seg);
    else break;
  }
  if (common.length === 0) return null;
  return common.join("/");
}

function TrustLedgerPanel({ projectId, artifacts }: { projectId: string; artifacts: Artifact[] | null }) {
  const [aggregates, setAggregates] = useState<TrustLedgerAggregate[] | null>(null);
  const prefix = commonPathPrefix(artifacts);

  useEffect(() => {
    if (!prefix) {
      setAggregates(null);
      return;
    }
    projectTrustLedger(projectId, { pathPrefix: prefix })
      .then(setAggregates)
      .catch(() => setAggregates(null));
  }, [projectId, prefix]);

  if (!prefix || !aggregates) return null;

  const total = aggregates.reduce((sum, a) => sum + a.count, 0);
  if (total < MIN_HISTORY) return null;

  const approved = aggregates.find((a) => a.outcome === "approved")?.count ?? 0;

  return (
    <div className="border border-outline rounded-md bg-background px-3 py-2.5">
      <p className="text-xs font-medium text-foreground mb-1">Your history here</p>
      <p className="text-sm">
        You've approved {approved} of the last {total} change{total === 1 ? "" : "s"} touching{" "}
        <span className="font-mono text-xs">{prefix}</span>.
      </p>
      <p className="text-xs text-muted-foreground mt-1">Context from your own past decisions. The call is still entirely yours.</p>
    </div>
  );
}

function ProcessDisclosure({ execution }: { execution: Execution }) {
  const [expanded, setExpanded] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && summary === null) {
      getEvidenceSummary(execution.id).then((s) => setSummary(s.summary));
    }
  };

  return (
    <Card className="bg-surface border-outline py-0 gap-0">
      <CardContent className="py-3">
        <button
          className="w-full flex items-center justify-between text-left text-sm"
          onClick={toggle}
        >
          <span>
            Execution {execution.seq} · {execution.trigger} · {execution.outcome ?? "in progress"}
            {/* .claude/plans/20-plano-consolidado.md item 1.6 — only once it's over, never a live meter. */}
            {execution.ended_at && execution.cost_usd != null && (
              <span className="text-muted-foreground"> · {formatUsd(execution.cost_usd)} API-equivalent</span>
            )}
          </span>
          <span className="text-muted-foreground">{expanded ? "Hide" : "Show"}</span>
        </button>
        {expanded && (
          <div className="mt-3 text-sm text-muted-foreground">
            {summary ?? "Loading…"}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// .claude/plans/23-ui-ux-polish.md item 5 — a long brief is clamped to two
// lines; the full text is one click away, never lost.
const BRIEF_CLAMP_CHARS = 140;

function BriefTitle({ brief }: { brief: string }) {
  const [open, setOpen] = useState(false);
  const long = brief.length > BRIEF_CLAMP_CHARS || brief.includes("\n");
  return (
    <div className="min-w-0">
      <h1 className={`text-2xl font-bold whitespace-pre-wrap break-words ${long && !open ? "line-clamp-2" : ""}`}>{brief}</h1>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground mt-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {open ? "Show less" : "Show full brief"}
        </button>
      )}
    </div>
  );
}

// .claude/plans/20-plano-consolidado.md Phase 7.7 (21-L) — a stacked Mission says
// what it builds on, and, until that one is approved, why its own Allow waits.
function StackedNote({ parent }: { parent: Mission | null }) {
  if (!parent) return null;
  return (
    <p className="text-xs text-muted-foreground mt-2">
      Builds on{" "}
      <Link to={`/missions/${parent.id}`} className="underline underline-offset-2 hover:text-foreground">
        {parent.brief.length > 80 ? parent.brief.slice(0, 80) + "…" : parent.brief}
      </Link>
      {parent.status !== "completed" && ". Allow becomes available once that Mission is approved."}
    </p>
  );
}

// Phase 7.7 (21-L) — "Start a follow-up from this branch": a new Mission whose
// work starts from THIS Mission's result instead of from the base branch.
function FollowUpPanel({ mission }: { mission: Mission }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const created = await createMission(mission.project_id, {
        brief: brief.trim(),
        base_mission_id: mission.id,
        assigned_team: mission.assigned_team.map((t) => ({ role: t.role })),
      });
      navigate(`/missions/${created.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't start the follow-up");
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Start a follow-up from this branch
        </Button>
      </div>
    );
  }
  return (
    <Card className="bg-surface border-outline py-0 gap-0">
      <CardContent className="py-3 space-y-2">
        <p className="text-sm font-medium">Follow-up Mission</p>
        <p className="text-xs text-muted-foreground">
          It starts from this Mission&apos;s result, so it can build on it before you decide. It can only be allowed after this one is.
        </p>
        <Textarea className="bg-surface" placeholder="What should the next step do?" value={brief} onChange={(e) => setBrief(e.target.value)} />
        <div className="flex gap-2">
          <Button disabled={busy || !brief.trim()} onClick={start}>
            {busy ? "Starting…" : "Start follow-up"}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
