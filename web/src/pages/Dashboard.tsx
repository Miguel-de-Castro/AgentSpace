import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { listProjects, onboardProject, validateRepoPath, ApiError } from "@/lib/api";
import { UsageIndicator } from "@/components/UsageIndicator";
import { formatWhen } from "@/components/MissionList";
import { useWorkspaceMissions } from "@/lib/useWorkspaceMissions";
import { OpenFolderButton } from "@/components/OpenFolderButton";
import type { Project } from "@/lib/types";

export function Dashboard() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const navigate = useNavigate();
  // .claude/plans/23-ui-ux-polish.md item 7: last activity + what is running, per Project.
  const { missions } = useWorkspaceMissions({ live: true });
  const activityFor = (projectId: string): Activity => {
    const mine = (missions ?? []).filter((m) => m.project.id === projectId);
    const last = mine.reduce<string | null>((acc, m) => (acc === null || m.updated_at > acc ? m.updated_at : acc), null);
    return {
      loaded: missions !== null,
      lastActivity: last,
      running: mine.filter((m) => m.status === "running" || m.status === "queued").length,
    };
  };

  const load = () => {
    listProjects().then(setProjects);
  };

  useEffect(load, []);

  return (
    <main className="max-w-5xl mx-auto p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold mb-1">Projects</h1>
          <p className="text-muted-foreground">The git repositories AgentSpace is supervising.</p>
        </div>
        <div className="flex items-center gap-3">
          <UsageIndicator />
          <ConnectRepositoryDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            onConnected={(project) => {
              setDialogOpen(false);
              load();
              navigate(`/projects/${project.id}`);
            }}
          />
        </div>
      </div>

      {projects === null && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[132px] w-full rounded-xl" />
          ))}
        </div>
      )}

      {projects?.length === 0 && (
        <div className="text-center py-24 text-muted-foreground">
          <p className="text-lg">No Projects yet.</p>
          <p className="text-sm mt-2">Connect a git repository to start your first Mission.</p>
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} activity={activityFor(project.id)} onOpen={() => navigate(`/projects/${project.id}`)} />
          ))}
        </div>
      )}
    </main>
  );
}

// .claude/plans/17-ux-navigation-polish.md P2 — a keyboard-accessible card
// (role=button + Enter/Space), replacing a bare div onClick. The Open-folder
// control stops propagation so it doesn't also trigger navigation.
type Activity = { loaded: boolean; lastActivity: string | null; running: number };

function ProjectCard({ project, activity, onOpen }: { project: Project; activity: Activity; onOpen: () => void }) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="bg-surface border-outline cursor-pointer hover:border-primary/60 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors"
    >
      <CardHeader className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle className="truncate">{project.name}</CardTitle>
          {project.origin_kind !== "local" && (
            <span className="text-xs px-2 py-0.5 rounded-full border border-outline text-muted-foreground shrink-0">
              {project.origin_kind === "cached" ? "cache only" : "cloned"}
            </span>
          )}
        </div>
        {!project.repo_available && (
          <span className="text-xs px-2 py-0.5 rounded-full border border-destructive/60 text-destructive shrink-0">
            Folder not found
          </span>
        )}
        {!!project.needs_attention_count && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-primary-container text-on-primary-container shrink-0">
            {project.needs_attention_count} need{project.needs_attention_count === 1 ? "s" : ""} you
          </span>
        )}
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground truncate">{project.repo_path}</p>
        {!project.repo_available && (
          <p className="text-xs text-destructive mt-1">
            This folder was moved or deleted. Point the Project at its new location in Settings.
          </p>
        )}
        {activity.loaded && (
          <p className="text-xs text-muted-foreground mt-2">
            {activity.running > 0 && (
              <span className="text-foreground">{activity.running} running now · </span>
            )}
            {activity.lastActivity ? `Last activity ${formatWhen(activity.lastActivity)}` : "No Missions yet"}
          </p>
        )}
        <div className="flex items-center justify-between mt-2 gap-2">
          <p className="text-xs text-muted-foreground">Default branch: {project.default_branch}</p>
          <span onClick={(e) => e.stopPropagation()}>
            <OpenFolderButton projectId={project.id} label="Open folder" />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

type ConnectMode = "local" | "clone";

function ConnectRepositoryDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (project: Project) => void;
}) {
  const [mode, setMode] = useState<ConnectMode>("local");
  const [repoPath, setRepoPath] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  // Phase 7.9: keep only a bare cache, no working folder. Off by default (the usual clone stays as it was).
  const [bareCache, setBareCache] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // .claude/plans/17-ux-navigation-polish.md P1 — inline validation of the local
  // path (debounced), so a bad path is a hint before submit, not a toast after.
  const [pathState, setPathState] = useState<"idle" | "checking" | "ok" | "not-git" | "missing">("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (mode !== "local") return;
    const value = repoPath.trim();
    if (!value) {
      setPathState("idle");
      return;
    }
    setPathState("checking");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      validateRepoPath(value)
        .then((r) => setPathState(!r.exists ? "missing" : r.is_git_repo ? "ok" : "not-git"))
        .catch(() => setPathState("idle"));
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [repoPath, mode]);

  const reset = () => {
    setRepoPath("");
    setCloneUrl("");
    setBareCache(false);
    setName("");
    setPathState("idle");
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const project =
        mode === "clone"
          ? await onboardProject({ clone_url: cloneUrl.trim(), bare_cache: bareCache || undefined, name: name.trim() || undefined })
          : await onboardProject({ repo_path: repoPath.trim(), name: name.trim() || undefined });
      reset();
      onConnected(project);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to connect repository");
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = mode === "clone" ? !!cloneUrl.trim() : !!repoPath.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button>+ Connect Repository</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Repository</DialogTitle>
          <DialogDescription>
            Point AgentSpace at a git repository: one already on this machine, or a URL to clone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-md border border-outline p-1 text-sm w-fit">
          {(["local", "clone"] as ConnectMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={
                "px-3 py-1 rounded transition-colors " +
                (mode === m ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground")
              }
            >
              {m === "local" ? "Local path" : "Clone a git URL"}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          {mode === "local" ? (
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium" htmlFor="repo-path">
                Local repository path
              </label>
              <input
                id="repo-path"
                className="rounded-md border border-input bg-surface-high px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                placeholder="C:\Users\you\code\my-project"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
              />
              {pathState === "checking" && <p className="text-xs text-muted-foreground">Checking…</p>}
              {pathState === "ok" && <p className="text-xs text-success">✓ Git repository found</p>}
              {pathState === "not-git" && (
                <p className="text-xs text-primary">Path exists, but it isn't a git repository.</p>
              )}
              {pathState === "missing" && <p className="text-xs text-destructive">No folder found at that path.</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium" htmlFor="clone-url">
                Git URL
              </label>
              <input
                id="clone-url"
                className="rounded-md border border-input bg-surface-high px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                placeholder="https://github.com/you/repo.git"
                value={cloneUrl}
                onChange={(e) => setCloneUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                AgentSpace clones this into a managed folder. You can remove it later from the Project's Settings.
              </p>
              <label className="flex items-start gap-2 text-sm mt-2">
                <input type="checkbox" className="mt-1" checked={bareCache} onChange={(e) => setBareCache(e.target.checked)} />
                <span>
                  Keep only a cache, no working folder
                  <span className="block text-xs text-muted-foreground">
                    Every Mission works in a temporary copy taken from this cache, which is refreshed from the remote each time.
                    Nothing is left to browse between Missions.
                  </span>
                </span>
              </label>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="project-name">
              Project name (optional)
            </label>
            <input
              id="project-name"
              className="rounded-md border border-input bg-surface-high px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              placeholder="Defaults to the folder / repo name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={submit} disabled={submitting || !canSubmit}>
            {submitting ? (mode === "clone" ? "Cloning…" : "Connecting…") : mode === "clone" ? "Clone & Connect" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
