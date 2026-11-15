import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { TeamBadges } from "@/components/TeamBadges";
import { OpenFolderButton } from "@/components/OpenFolderButton";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { MissionList, MissionRow } from "@/components/MissionList";
import { Skeleton } from "@/components/ui/skeleton";
import { layoutStacks } from "@/lib/stack";
import { RunPanel } from "@/components/RunPanel";
import { ApiError, confirmMission, createMission, dismissMission, getProject, getProjectBudget, listMissions } from "@/lib/api";
import type { BudgetStatus, Mission, Project } from "@/lib/types";

export function ProjectView() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const navigate = useNavigate();

  const load = () => {
    if (!projectId) return;
    getProject(projectId).then(setProject);
    listMissions(projectId).then(setMissions);
  };

  useEffect(load, [projectId]);

  if (!projectId) return null;

  const proposed = missions?.filter((m) => m.status === "proposed") ?? [];
  const rest = missions?.filter((m) => m.status !== "proposed") ?? [];

  return (
    <main className="max-w-5xl mx-auto p-8">
      {project && (
        <>
          {/* .claude/plans/17-ux-navigation-polish.md P1 — breadcrumb trail. */}
          <Breadcrumbs items={[{ label: "Projects", to: "/" }, { label: project.name }]} />
          <div className="flex items-start justify-between gap-4 mt-2 mb-8">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-3xl font-bold">{project.name}</h1>
                {project.origin_kind !== "local" && (
                  <span className="text-xs px-2 py-0.5 rounded-full border border-outline text-muted-foreground shrink-0">
                    {project.origin_kind === "cached" ? "cache only" : "cloned"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <p className="text-muted-foreground">{project.repo_path}</p>
                <OpenFolderButton projectId={project.id} />
              </div>
            </div>
            {/* .claude/plans/11-project-settings-screen.md — every Project-level
                control now lives on the Settings screen, not stacked in this header. */}
            <Link
              to={`/projects/${project.id}/settings`}
              className="text-sm rounded-md border border-outline px-3 py-1.5 text-muted-foreground hover:text-foreground hover:border-primary/60 transition-colors shrink-0"
            >
              Settings
            </Link>
          </div>
        </>
      )}

      {project && project.repo_available && (
        <div className="mb-8">
          <RunPanel projectId={project.id} repoIsCache={project.origin_kind === "cached"} />
        </div>
      )}

      {proposed.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-medium text-foreground mb-3">Proposed: needs your OK to start</h2>
          <div className="space-y-3">
            {proposed.map((mission) => (
              <ProposedMissionRow key={mission.id} mission={mission} onChanged={load} />
            ))}
          </div>
        </section>
      )}

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-foreground">Missions</h2>
        {project && (
          <NewMissionDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            onCreated={(mission) => {
              setDialogOpen(false);
              load();
              navigate(`/missions/${mission.id}`);
            }}
            project={project}
          />
        )}
      </div>

      {missions === null && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[68px] w-full rounded-xl" />
          ))}
        </div>
      )}
      {missions?.length === 0 && (
        <p className="text-muted-foreground text-sm">No Missions yet. Start one above.</p>
      )}

      {rest.length > 0 && (
        <MissionList>
          {layoutStacks(rest).map(({ mission, depth, waitsFor, builtOnCount }) => (
            <MissionRow
              key={mission.id}
              mission={mission}
              date={mission.created_at}
              showTeam
              depth={depth}
              note={
                waitsFor
                  ? "Waits for the Mission above to be approved"
                  : builtOnCount > 0
                    ? `${builtOnCount} ${builtOnCount === 1 ? "Mission builds" : "Missions build"} on this one`
                    : undefined
              }
            />
          ))}
        </MissionList>
      )}
    </main>
  );
}

function ProposedMissionRow({ mission, onChanged }: { mission: Mission; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  const act = async (action: "confirm" | "dismiss") => {
    setBusy(true);
    try {
      await (action === "confirm" ? confirmMission(mission.id) : dismissMission(mission.id));
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update Mission");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="bg-surface-high border-outline py-0 gap-0">
      <CardContent className="flex items-center justify-between py-4 gap-4">
        <div className="min-w-0">
          <p className="truncate">{mission.brief}</p>
          <div className="flex items-center gap-2 mt-1">
            <TeamBadges team={mission.assigned_team} />
            {mission.proposed_by_mission_id && (
              <Link
                to={`/missions/${mission.proposed_by_mission_id}`}
                className="text-xs text-muted-foreground underline underline-offset-2"
              >
                Proposed from an earlier Mission
              </Link>
            )}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" disabled={busy} onClick={() => act("dismiss")}>
            Dismiss
          </Button>
          <Button disabled={busy} onClick={() => act("confirm")}>
            Confirm
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// .claude/plans/10-team-composition-ui.md gap 2 — the New Mission form now
// proposes a Team (the Project's enabled roster) that the developer can adjust
// before committing (Journey 1, step 2), and accepts free-text reference
// material. The roster is pre-checked, not built from scratch — AgentSpace
// proposes, the human trims.
function NewMissionDialog({
  open,
  onOpenChange,
  onCreated,
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (mission: Mission) => void;
  project: Project;
}) {
  const [brief, setBrief] = useState("");
  const [reference, setReference] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [criteria, setCriteria] = useState("");
  const [planCheckpoint, setPlanCheckpoint] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const hasPlanner = selectedRoles.includes("Planner");
  // Plan 24 item 7 — a calm note when the Project's weekly budget is reached.
  // Never blocks: a Mission started by hand always goes ahead.
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  useEffect(() => {
    if (!open || project.weekly_budget_usd === null) {
      setBudget(null);
      return;
    }
    getProjectBudget(project.id)
      .then(setBudget)
      .catch(() => setBudget(null));
  }, [open, project.id, project.weekly_budget_usd]);

  // Reset the proposed Team to the Project's enabled roster each time the
  // dialog opens, so edits from a previous open don't leak into a new Mission.
  useEffect(() => {
    if (open) {
      setSelectedRoles(project.team_roster.filter((r) => r.enabled).map((r) => r.role));
    }
  }, [open, project.team_roster]);

  const toggleRole = (role: string) => {
    setSelectedRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  };

  const submit = async () => {
    if (!brief.trim() || selectedRoles.length === 0) return;
    setSubmitting(true);
    try {
      const mission = await createMission(project.id, {
        brief: brief.trim(),
        assigned_team: selectedRoles.map((role) => ({ role })),
        reference_material: reference.trim() || undefined,
        // .claude/plans/20-plano-consolidado.md Phase 4 (D4) — one per line;
        // the Planner fills gaps when there's one on the Team.
        acceptance_criteria: criteria
          .split("\n")
          .map((c) => c.replace(/^[-*\d.)\s]+/, "").trim())
          .filter(Boolean),
        plan_checkpoint: hasPlanner && planCheckpoint,
      });
      setBrief("");
      setReference("");
      setCriteria("");
      setPlanCheckpoint(false);
      onCreated(mission);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to start Mission");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button>+ New Mission</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Mission</DialogTitle>
          <DialogDescription>
            Describe what you want done. AgentSpace starts it and you're free to walk away.
          </DialogDescription>
        </DialogHeader>
        {budget?.reached && budget.limit_usd !== null && (
          <p className="rounded-md border border-outline bg-surface px-3 py-2 text-xs text-muted-foreground">
            This Project has used ${budget.spent_usd.toFixed(2)} in the last {budget.window_days} days, past the ${budget.limit_usd.toFixed(2)}{" "}
            budget you set (API-equivalent cost). Routines and automatic fixes are paused; this Mission will still start.
          </p>
        )}
        <Textarea
          className="bg-surface-high"
          rows={5}
          placeholder="e.g. Add rate limiting to the /api/checkout endpoint"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />

        <div>
          <p className="text-sm font-medium text-foreground mb-2">Team</p>
          <div className="flex flex-wrap gap-2">
            {project.team_roster.map((entry) => {
              const on = selectedRoles.includes(entry.role);
              return (
                <button
                  key={entry.role}
                  type="button"
                  onClick={() => toggleRole(entry.role)}
                  className={
                    "rounded-md border px-3 py-1.5 text-sm transition-colors " +
                    (on
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-outline text-muted-foreground hover:border-primary/60")
                  }
                >
                  {on ? "✓ " : ""}
                  {entry.role}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Each selected role runs as its own step. Fewer roles finish faster.
          </p>
        </div>

        {/* Phase 3.3 — only meaningful when someone writes the plan. */}
        {hasPlanner && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-primary"
              checked={planCheckpoint}
              onChange={(e) => setPlanCheckpoint(e.target.checked)}
            />
            <span>
              Review the plan before building
              <span className="block text-xs text-muted-foreground">
                The Planner works alone first. Nothing is built until you approve its plan.
              </span>
            </span>
          </label>
        )}

        <div>
          <label htmlFor="criteria" className="text-sm font-medium block mb-1">
            Done when (optional)
          </label>
          <Textarea
            id="criteria"
            className="bg-surface-high"
            rows={3}
            placeholder={"One per line, e.g.\nThe endpoint returns 429 after 10 requests a minute\nExisting tests still pass"}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-1">
            {hasPlanner
              ? "The Planner adds any that are missing. The Reviewer checks each one."
              : "The Reviewer checks each one."}
          </p>
        </div>

        <div>
          <p className="text-sm font-medium text-foreground mb-2">Reference material (optional)</p>
          <Textarea
            className="bg-surface-high"
            rows={3}
            placeholder="Paste a stack trace, ticket description, or any context that helps."
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>

        <DialogFooter>
          <Button onClick={submit} disabled={submitting || !brief.trim() || selectedRoles.length === 0}>
            {submitting ? "Starting…" : "Start Mission"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
