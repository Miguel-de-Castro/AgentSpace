import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ApiError, createRoutine, deleteProject, deleteRoutine, getProject, getProjectBudget, getRunConfig, saveEnv, listRoutines, runRoutineNow, setGithubToken, updateProject, updateRoutine } from "@/lib/api";
import type { BudgetStatus, RunConfig, PermissionMode, PermissionPolicy, Project, Routine, RoutineCadence, TeamRosterEntry } from "@/lib/types";

const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  "read-only": "Read-only",
  "can-edit": "Can edit",
  "can-edit-and-run": "Can edit and run tests",
  custom: "Custom",
};

// .claude/plans/20-plano-consolidado.md Phase 1 finding — what each mode lets
// the team do in practice. "Can edit" auto-approves edits and file commands
// only; running tests/builds needs Bash allowed via Custom.
const PERMISSION_MODE_HINT: Record<PermissionMode, string> = {
  "read-only": "The team can only read and search the code. Nothing is changed.",
  "can-edit": "The team can edit files. Shell commands that only touch files are allowed, but it can't run tests or builds (e.g. npm test).",
  "can-edit-and-run":
    "Can edit files and run npm, node, pnpm, yarn, pytest and similar test and build commands. Pushing and network commands stay blocked. Developer and QA can verify their work; QA still never edits.",
  custom:
    "You choose the tools. Add Bash to Allowed so the Developer and QA can run tests and builds. QA never edits files, and Planner and Reviewer only read.",
};

// .claude/plans/20-plano-consolidado.md item 1.2 — each role's ceiling, always
// narrowed further by the Project's permission (never widened).
const ROLE_HINT: Record<string, string> = {
  Planner: "reads the code and plans · never edits",
  Developer: "makes the changes · uses this Project's permission",
  QA: "runs checks and reports · never edits",
  Reviewer: "reads the result and reports · never edits",
  Challenger: "independent second opinion on the diff, shown when you decide",
};

// .claude/plans/11-project-settings-screen.md — one coherent home for every
// Project-level control, instead of stacking selects onto the ProjectView
// header. Sections: Name · Permission (moved here from the header) · Team
// Roster (plan 10) · Branch Protection (read-only) · GitHub token (write-only).
export function ProjectSettings() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    if (projectId) getProject(projectId).then(setProject);
  }, [projectId]);

  if (!projectId) return null;

  return (
    <main className="max-w-3xl mx-auto p-8 space-y-8">
      <div>
        <Breadcrumbs
          items={[
            { label: "Projects", to: "/" },
            { label: project?.name ?? "Project", to: `/projects/${projectId}` },
            { label: "Settings" },
          ]}
        />
        <h1 className="text-2xl font-bold mt-2">Project Settings</h1>
      </div>

      {project === null ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <>
          <SettingsGroup title="Repository">
            <NameSection project={project} onChanged={setProject} />
            <RepositoryFolderSection project={project} onChanged={setProject} />
          </SettingsGroup>
          <SettingsGroup title="How the team works">
            <PermissionSection project={project} onChanged={setProject} />
            <TeamRosterSection project={project} onChanged={setProject} />
            <CorrectionLoopSection project={project} onChanged={setProject} />
            <BudgetSection project={project} onChanged={setProject} />
            <RunSection project={project} onChanged={setProject} />
            <InstructionsSection project={project} onChanged={setProject} />
          </SettingsGroup>
          <SettingsGroup title="Routines">
            <RoutinesSection project={project} onChanged={setProject} />
          </SettingsGroup>
          <SettingsGroup title="Integrations">
            <BranchProtectionSection project={project} />
            <GithubTokenSection project={project} />
          </SettingsGroup>
          <RemoveProjectSection project={project} />
        </>
      )}
    </main>
  );
}

// .claude/plans/23-ui-ux-polish.md item 8 — sections live inside a SettingsGroup
// (one panel, divided rows) instead of one Card per field.
function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-medium mb-2">{title}</h2>
      <div className="rounded-xl border border-outline bg-surface divide-y divide-outline">{children}</div>
    </section>
  );
}

function SettingsCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="px-5 py-4">
      <h3 className="text-base font-medium">{title}</h3>
      {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      <div className="space-y-3 mt-3">{children}</div>
    </div>
  );
}

function NameSection({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const dirty = name.trim() !== project.name && name.trim().length > 0;

  const save = async () => {
    setSaving(true);
    try {
      const updated = await updateProject(project.id, { name: name.trim() });
      onChanged(updated);
      toast.success("Project name updated.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update name");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard title="Name">
      <div className="flex gap-2">
        <input
          className="flex-1 rounded-md border border-input bg-surface-high px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </SettingsCard>
  );
}

// A local repo moved on disk used to leave its Project pointing at a dead path
// (Missions then failed with `git ENOENT`) and the only fix was editing the DB.
// This re-points the Project, keeping its Mission history. Cloned Projects'
// folders are managed by AgentSpace, so they're shown but not editable.
function RepositoryFolderSection({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const [path, setPath] = useState(project.repo_path);
  const [saving, setSaving] = useState(false);
  const cloned = project.origin_kind !== "local";
  const dirty = path.trim() !== project.repo_path && path.trim().length > 0;

  const save = async () => {
    setSaving(true);
    try {
      onChanged(await updateProject(project.id, { repo_path: path.trim() }));
      toast.success("Repository folder updated.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update the folder");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="Repository folder"
      description={
        cloned
          ? project.origin_kind === "cached"
            ? "AgentSpace keeps only a bare cache of this repository: no working folder. Each Mission works in a temporary copy."
            : "Cloned and managed by AgentSpace."
          : "Where this repository lives on this machine. If you moved it, point the Project at the new folder. Missions and history are kept."
      }
    >
      {!project.repo_available && (
        <p className="text-sm text-destructive">This folder no longer exists. Missions can't run until it's fixed.</p>
      )}
      <div className="flex gap-2">
        <input
          className="flex-1 rounded-md border border-input bg-surface-high px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
          value={path}
          disabled={cloned}
          onChange={(e) => setPath(e.target.value)}
        />
        {!cloned && (
          <Button disabled={!dirty || saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
    </SettingsCard>
  );
}

// Moved verbatim in behaviour from ProjectView's header
// (.claude/plans/completed/06 + 08) — only its home changed.
function PermissionSection({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const [saving, setSaving] = useState(false);

  const save = async (policy: PermissionPolicy) => {
    setSaving(true);
    try {
      onChanged(await updateProject(project.id, { permission_policy: policy }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update permission mode");
    } finally {
      setSaving(false);
    }
  };

  const changeMode = (mode: PermissionMode) => {
    if (mode === "custom") {
      save({
        mode,
        allowed_tools: project.permission_policy.allowed_tools ?? [],
        disallowed_tools: project.permission_policy.disallowed_tools ?? [],
      });
    } else {
      save({ mode });
    }
  };

  return (
    <SettingsCard title="Permission" description="What this Project's Missions are allowed to attempt.">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">This Project can:</span>
        <select
          className="rounded-md border border-input bg-surface-high px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
          value={project.permission_policy.mode}
          disabled={saving}
          onChange={(e) => changeMode(e.target.value as PermissionMode)}
        >
          {(Object.keys(PERMISSION_MODE_LABEL) as PermissionMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {PERMISSION_MODE_LABEL[mode]}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">{PERMISSION_MODE_HINT[project.permission_policy.mode]}</p>
      {project.permission_policy.mode === "custom" && (
        <CustomToolLists policy={project.permission_policy} saving={saving} onSave={save} />
      )}
    </SettingsCard>
  );
}

function CustomToolLists({
  policy,
  saving,
  onSave,
}: {
  policy: PermissionPolicy;
  saving: boolean;
  onSave: (policy: PermissionPolicy) => void;
}) {
  const allowed = policy.allowed_tools ?? [];
  const disallowed = policy.disallowed_tools ?? [];
  const isEmpty = allowed.length === 0 && disallowed.length === 0;

  return (
    <div className="flex flex-col gap-3 w-full max-w-sm">
      <ToolTagList
        label="Allowed"
        tags={allowed}
        saving={saving}
        onChange={(next) => onSave({ mode: "custom", allowed_tools: next, disallowed_tools: disallowed })}
      />
      <ToolTagList
        label="Disallowed"
        tags={disallowed}
        saving={saving}
        onChange={(next) => onSave({ mode: "custom", allowed_tools: allowed, disallowed_tools: next })}
      />
      {isEmpty && (
        <p className="text-xs text-muted-foreground">Add at least one tool, or switch to Read-only / Can edit instead.</p>
      )}
    </div>
  );
}

function ToolTagList({
  label,
  tags,
  saving,
  onChange,
}: {
  label: string;
  tags: string[];
  saving: boolean;
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const addTag = () => {
    const value = draft.trim();
    if (!value || tags.includes(value)) return;
    setDraft("");
    onChange([...tags, value]);
  };

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <div className="flex flex-wrap gap-1 mb-1">
        {tags.map((tag) => (
          <Badge key={tag} variant="outline" className="gap-1">
            {tag}
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              className="opacity-60 hover:opacity-100"
              disabled={saving}
              onClick={() => onChange(tags.filter((t) => t !== tag))}
            >
              ×
            </button>
          </Badge>
        ))}
      </div>
      <input
        className="w-full rounded-md border border-input bg-surface-high px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
        placeholder="e.g. Bash(git *)"
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addTag();
          }
        }}
        onBlur={addTag}
      />
    </div>
  );
}

// .claude/plans/10-team-composition-ui.md gap 1 — which roles are available by
// default for this Project's Missions. A lean default (Developer + Reviewer)
// keeps cost down; the supervisor enables Planner/QA when a Mission warrants
// the heavier composition (Journey 9, step 3).
function TeamRosterSection({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const [saving, setSaving] = useState(false);

  const toggle = async (role: string, enabled: boolean) => {
    const next: TeamRosterEntry[] = project.team_roster.map((r) => (r.role === role ? { ...r, enabled } : r));
    if (!next.some((r) => r.enabled)) {
      toast.error("Keep at least one role enabled: a Mission needs someone to work it.");
      return;
    }
    setSaving(true);
    try {
      onChanged(await updateProject(project.id, { team_roster: next }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update roster");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="Team Roster"
      description="The roles available by default when you start a Mission. Each enabled role runs as its own step, so a leaner roster costs less time."
    >
      <div className="space-y-2">
        {project.team_roster.map((entry) => (
          <label key={entry.role} className="flex items-center justify-between gap-3 text-sm">
            <span>
              {entry.role}
              {ROLE_HINT[entry.role] && <span className="text-xs text-muted-foreground"> · {ROLE_HINT[entry.role]}</span>}
            </span>
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={entry.enabled}
              disabled={saving}
              onChange={(e) => toggle(entry.role, e.target.checked)}
            />
          </label>
        ))}
      </div>
    </SettingsCard>
  );
}

// .claude/plans/20-plano-consolidado.md Phase 6 (D3) — off by default. Each
// round counts toward the Mission's adjustment limit, so it can't loop forever.
function CorrectionLoopSection({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const [saving, setSaving] = useState(false);
  const toggle = async (on: boolean) => {
    setSaving(true);
    try {
      onChanged(await updateProject(project.id, { auto_fix_loop: on }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsCard title="Automatic fixes">
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-primary"
          checked={project.auto_fix_loop}
          disabled={saving}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>
          Fix blocking problems before asking me
          <span className="block text-xs text-muted-foreground mt-0.5">
            When a reviewer reports a blocking problem or an unmet criterion, the Developer gets one more round to fix it
            before the Mission reaches you. Each round uses one of the Mission&apos;s adjustments, so it always stops.
          </span>
        </span>
      </label>
    </SettingsCard>
  );
}

// .claude/plans/25-run-do-project.md — what "Run" does for this Project: the two
// commands (blank = detected from package.json), a fixed port for apps that ignore
// PORT, and the values for the repo's .env.example. Values stay on this computer.
function RunSection({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const [config, setConfig] = useState<RunConfig | null>(null);
  const [runCmd, setRunCmd] = useState(project.run_command ?? "");
  const [installCmd, setInstallCmd] = useState(project.install_command ?? "");
  const [port, setPort] = useState(project.preview_port !== null ? String(project.preview_port) : "");
  const [env, setEnv] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const loadConfig = () => {
    getRunConfig(project.id)
      .then((c) => {
        setConfig(c);
        setEnv(Object.fromEntries(c.vars.map((v) => [v.name, v.value ?? ""])));
      })
      .catch(() => setConfig(null));
  };
  useEffect(loadConfig, [project.id]);

  const commandsDirty =
    runCmd.trim() !== (project.run_command ?? "") ||
    installCmd.trim() !== (project.install_command ?? "") ||
    port.trim() !== (project.preview_port !== null ? String(project.preview_port) : "");

  const saveCommands = async () => {
    const parsedPort = port.trim() === "" ? null : Number(port.trim());
    if (parsedPort !== null && !Number.isInteger(parsedPort)) {
      toast.error("The port must be a whole number, or empty to pick one automatically.");
      return;
    }
    setSaving(true);
    try {
      onChanged(
        await updateProject(project.id, {
          run_command: runCmd.trim() || null,
          install_command: installCmd.trim() || null,
          preview_port: parsedPort,
        })
      );
      toast.success("Run settings saved.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const saveValues = async () => {
    if (!config) return;
    setSaving(true);
    try {
      // A masked field left blank keeps its saved value (null); anything typed replaces it.
      const payload: Record<string, string | null> = {};
      for (const v of config.vars) {
        const typed = env[v.name] ?? "";
        payload[v.name] = v.secret && v.has_value && typed === "" ? null : typed;
      }
      await saveEnv(project.id, payload);
      toast.success("Values saved on this computer.");
      loadConfig();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const fieldClass = "w-full rounded-md border border-input bg-surface-high px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring";
  return (
    <SettingsCard
      title="Run the app"
      description="The Run button starts the app so you can see it. Leave the commands empty to detect them from package.json. Use {PORT} where the app takes its port as an argument."
    >
      <div className="space-y-3">
        <div>
          <label htmlFor="run-install" className="text-xs text-muted-foreground">Install command</label>
          <input id="run-install" className={fieldClass} placeholder={config?.detected.install ?? "e.g. npm install"} value={installCmd} onChange={(e) => setInstallCmd(e.target.value)} />
        </div>
        <div>
          <label htmlFor="run-cmd" className="text-xs text-muted-foreground">Run command</label>
          <input id="run-cmd" className={fieldClass} placeholder={config?.detected.run ?? "e.g. npm run dev"} value={runCmd} onChange={(e) => setRunCmd(e.target.value)} />
        </div>
        <div>
          <label htmlFor="run-port" className="text-xs text-muted-foreground">Fixed port (only for apps that ignore PORT)</label>
          <input id="run-port" className={fieldClass + " w-32"} inputMode="numeric" placeholder="automatic" value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
        <Button size="sm" disabled={saving || !commandsDirty} onClick={saveCommands}>
          Save
        </Button>
      </div>
      {config && config.vars.length > 0 && (
        <div className="space-y-2.5 pt-3 mt-3 border-t border-outline">
          <p className="text-sm font-medium">Values for .env</p>
          <p className="text-xs text-muted-foreground">
            Kept on this computer and written to a .env only in the folder being run. Never sent to the team.
          </p>
          {config.vars.map((v) => (
            <div key={v.name}>
              <label htmlFor={`rv-${v.name}`} className="text-xs font-mono">{v.name}</label>
              {v.comment && <span className="text-xs text-muted-foreground"> · {v.comment}</span>}
              <input
                id={`rv-${v.name}`}
                type={v.secret ? "password" : "text"}
                autoComplete="off"
                className={fieldClass}
                placeholder={v.secret && v.has_value ? "Saved. Leave empty to keep it." : v.default || "(empty)"}
                value={env[v.name] ?? ""}
                onChange={(e) => setEnv((prev) => ({ ...prev, [v.name]: e.target.value }))}
              />
            </div>
          ))}
          <Button size="sm" disabled={saving} onClick={saveValues}>
            Save values
          </Button>
        </div>
      )}
    </SettingsCard>
  );
}

// .claude/plans/24-ideias-para-analisar.md item 7 — optional weekly ceiling. A
// soft limit: routines and automatic fixes stop at it; Missions started by hand
// never do. The figure is API-equivalent cost, not what a subscription bills.
function BudgetSection({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const [value, setValue] = useState(project.weekly_budget_usd !== null ? String(project.weekly_budget_usd) : "");
  const [spent, setSpent] = useState<BudgetStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const current = project.weekly_budget_usd !== null ? String(project.weekly_budget_usd) : "";
  const dirty = value.trim() !== current;

  useEffect(() => {
    getProjectBudget(project.id)
      .then(setSpent)
      .catch(() => setSpent(null));
  }, [project.id, project.weekly_budget_usd]);

  const save = async () => {
    const trimmed = value.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
      toast.error("Enter a positive number, or leave it empty to turn the budget off.");
      return;
    }
    setSaving(true);
    try {
      onChanged(await updateProject(project.id, { weekly_budget_usd: parsed }));
      toast.success(parsed === null ? "Weekly budget turned off." : "Weekly budget saved.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard title="Weekly budget">
      <p className="text-sm text-muted-foreground">
        Optional. When this Project&apos;s last 7 days reach the amount, routines and automatic fixes pause. Missions you start
        yourself are never blocked: you just see a note first. Amounts are API-equivalent cost, not what your subscription
        bills.
      </p>
      <div className="flex items-center gap-2 mt-3">
        <span className="text-sm text-muted-foreground">$</span>
        <input
          className="w-28 rounded-md border border-input bg-surface-high px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          inputMode="decimal"
          placeholder="Off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button size="sm" disabled={saving || !dirty} onClick={save}>
          Save
        </Button>
      </div>
      {spent && (
        <p className="text-xs text-muted-foreground mt-2">
          Last {spent.window_days} days: ${spent.spent_usd.toFixed(2)}
          {spent.reached && " (budget reached)"}
        </p>
      )}
    </SettingsCard>
  );
}

// .claude/plans/20-plano-consolidado.md Phase 7.1 (D5) — the Project's own
// guidance, added after AgentSpace's role instructions. It refines how the
// team works here; it can't change what a role is allowed to do.
function InstructionsSection({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const roles = project.team_roster.map((r) => r.role).filter((r) => r !== "Challenger");
  const [general, setGeneral] = useState(project.instructions ?? "");
  const [perRole, setPerRole] = useState<Record<string, string>>(project.role_instructions ?? {});
  const [saving, setSaving] = useState(false);
  const dirty =
    general.trim() !== (project.instructions ?? "") ||
    roles.some((r) => (perRole[r] ?? "").trim() !== (project.role_instructions?.[r] ?? ""));

  const save = async () => {
    setSaving(true);
    try {
      const updated = await updateProject(project.id, { instructions: general.trim() || null, role_instructions: perRole });
      onChanged(updated);
      setGeneral(updated.instructions ?? "");
      setPerRole(updated.role_instructions ?? {});
      toast.success("Instructions saved. They apply from the next Mission run.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save instructions");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="Instructions for this Project"
      description="Added to what each Team Member already does, never replacing it. Conventions, commands to run, things to avoid."
    >
      <div>
        <label htmlFor="instructions-all" className="text-sm font-medium block mb-1">
          For the whole team
        </label>
        <textarea
          id="instructions-all"
          rows={3}
          className="w-full rounded-md border border-input bg-surface-high px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          placeholder="e.g. Run npm test before finishing. Keep changes inside src/."
          value={general}
          onChange={(e) => setGeneral(e.target.value)}
        />
      </div>
      {roles.map((role) => (
        <div key={role}>
          <label htmlFor={`instructions-${role}`} className="text-sm font-medium block mb-1">
            For the {role}
          </label>
          <textarea
            id={`instructions-${role}`}
            rows={2}
            className="w-full rounded-md border border-input bg-surface-high px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            value={perRole[role] ?? ""}
            onChange={(e) => setPerRole((prev) => ({ ...prev, [role]: e.target.value }))}
          />
        </div>
      ))}
      <Button disabled={!dirty || saving} onClick={save}>
        {saving ? "Saving…" : "Save instructions"}
      </Button>
    </SettingsCard>
  );
}

// .claude/plans/11-project-settings-screen.md item 1 — read-only reflection of
// the repo's own branch protection (Journey 9, step 2). The `implicit-fallback`
// case must read as a fallback, not a real GitHub rule.
function BranchProtectionSection({ project }: { project: Project }) {
  const bp = project.branch_protection;
  const isFallback = bp.source === "implicit-fallback";

  return (
    <SettingsCard title="Branch Protection" description="Which branches always need your approval before the AI team's work can be pushed.">
      <div className="flex flex-wrap gap-1">
        {bp.protected_branches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No protected branches.</p>
        ) : (
          bp.protected_branches.map((b) => (
            <Badge key={b} variant="outline">
              {b}
            </Badge>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {isFallback
          ? `AgentSpace didn't find real branch protection rules, so treating these as protected by default. Confirm your GitHub settings if this doesn't look right.`
          : `Detected from the repository's own branch protection rules.`}
      </p>
    </SettingsCard>
  );
}

// .claude/plans/11-project-settings-screen.md item 2 — write-only. The value is
// never read back from any GET (backend never echoes it), so this field can set
// or replace the token but never shows the current one.
function GithubTokenSection({ project }: { project: Project }) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!token.trim()) return;
    setSaving(true);
    try {
      await setGithubToken(project.id, token.trim());
      setToken("");
      toast.success("GitHub token saved. It's stored write-only and never shown again.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save token");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="GitHub Token"
      description="A read-only personal access token, used only to show branch / PR / CI context in the Approval Gate. Stored write-only, never displayed back."
    >
      <div className="flex gap-2">
        <label htmlFor="github-token" className="sr-only">GitHub personal access token</label>
        <input
          id="github-token"
          type="password"
          autoComplete="off"
          className="flex-1 rounded-md border border-input bg-surface-high px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          placeholder="ghp_… (leave blank to keep the current one)"
          aria-label="GitHub personal access token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Button disabled={!token.trim() || saving} onClick={save}>
          {saving ? "Saving…" : "Save token"}
        </Button>
      </div>
    </SettingsCard>
  );
}

// .claude/plans/19-clone-git-repository.md P1 — remove the Project. A cloned
// Project deletes its managed directory (it only existed for AgentSpace); a
// local one is only disconnected (the user's own folder is never touched). Two
// clicks (confirm), never touches origin.
function RemoveProjectSection({ project }: { project: Project }) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const cloned = project.origin_kind !== "local";

  const remove = async () => {
    setBusy(true);
    try {
      const res = await deleteProject(project.id);
      if (cloned) {
        toast.success(res.directory_removed ? "Project removed and the cloned folder was deleted." : "Project removed (the cloned folder couldn't be deleted, so remove it by hand if needed).");
      } else {
        toast.success("Project disconnected. Your repository folder was left untouched.");
      }
      navigate("/");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to remove project");
      setBusy(false);
    }
  };

  return (
    <Card className="bg-surface border-destructive/50">
      <CardHeader>
        <CardTitle className="text-base text-destructive">{cloned ? "Remove cloned repository" : "Remove project"}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {cloned
            ? "This repo was cloned by AgentSpace. Removing the Project deletes its Missions and the cloned folder on disk. Nothing is pushed to the remote."
            : "Disconnects this Project and deletes its Missions from AgentSpace. Your repository folder on disk is left completely untouched."}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {cloned && (
          <p className="text-xs text-muted-foreground">
            Folder to delete: <span className="font-mono">{project.repo_path}</span>
          </p>
        )}
        {!confirming ? (
          <Button variant="outline" className="border-destructive/60 text-destructive hover:bg-destructive/10" onClick={() => setConfirming(true)}>
            {cloned ? "Remove cloned repository" : "Remove project"}
          </Button>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Are you sure? This can't be undone.</span>
            <Button
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busy}
              onClick={remove}
            >
              {busy ? "Removing…" : cloned ? "Yes, delete it" : "Yes, disconnect"}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// .claude/plans/20-plano-consolidado.md Phase 7.7 (21-N) — recurring, read-only
// looks at the Project that can only PROPOSE Missions. They appear under
// "Proposed" on the Project page and nothing starts until you confirm one.
// Off by default: every run spends Claude usage.
const CADENCE_LABEL: Record<RoutineCadence, string> = { daily: "Every day", weekly: "Every week" };

function RoutinesSection({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState<RoutineCadence>("weekly");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    listRoutines(project.id).then(setRoutines).catch(() => setRoutines([]));
  };
  useEffect(load, [project.id]);

  const add = async () => {
    try {
      await createRoutine(project.id, { name: name.trim(), prompt: prompt.trim(), cadence });
      setName("");
      setPrompt("");
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't add the routine");
    }
  };

  const act = async (id: string, fn: () => Promise<unknown>, done?: (r: unknown) => void) => {
    setBusyId(id);
    try {
      const result = await fn();
      done?.(result);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "That didn't work");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SettingsCard
      title="Scheduled reviews"
      description="A routine looks through the repository on a schedule, read-only, and proposes Missions. It can't change anything: each proposal waits for your OK. Every run uses your Claude usage, so routines start switched off."
    >
      {routines?.map((r) => (
        <div key={r.id} className="rounded-md border border-outline px-3 py-2 space-y-1">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{r.name}</p>
              <p className="text-xs text-muted-foreground">
                {CADENCE_LABEL[r.cadence]}
                {r.last_summary ? ` · last run: ${r.last_summary}` : " · hasn't run yet"}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  disabled={busyId === r.id}
                  onChange={(e) => act(r.id, () => updateRoutine(r.id, { enabled: e.target.checked }))}
                />
                On
              </label>
              <Button
                variant="outline"
                size="sm"
                disabled={busyId === r.id}
                onClick={() => act(r.id, () => runRoutineNow(r.id), (res) => toast.info((res as { summary: string }).summary))}
              >
                {busyId === r.id ? "Working…" : "Run now"}
              </Button>
              <Button variant="outline" size="sm" disabled={busyId === r.id} onClick={() => act(r.id, () => deleteRoutine(r.id))}>
                Delete
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground whitespace-pre-wrap">{r.prompt}</p>
        </div>
      ))}
      {project.routine_exclusions.length > 0 && (
        <div className="rounded-md border border-outline px-3 py-2 space-y-1.5">
          <p className="text-sm font-medium">Ruled out</p>
          <p className="text-xs text-muted-foreground">
            Routines are told not to propose these again. Remove one to let it come back.
          </p>
          <ul className="space-y-1">
            {project.routine_exclusions.map((x) => (
              <li key={x} className="flex items-start justify-between gap-3 text-xs">
                <span className="text-muted-foreground">{x}</span>
                <button
                  type="button"
                  className="shrink-0 underline underline-offset-2 text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    updateProject(project.id, { routine_exclusions: project.routine_exclusions.filter((e) => e !== x) })
                      .then(onChanged)
                      .catch((err) => toast.error(err instanceof ApiError ? err.message : "Couldn't update"))
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-2 pt-1">
        <label htmlFor="routine-name" className="sr-only">Routine name</label>
        <input
          id="routine-name"
          className="w-full rounded-md border border-input bg-surface-high px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          placeholder="Name, e.g. Weekly tidy-up"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor="routine-prompt" className="sr-only">What to look for</label>
        <textarea
          id="routine-prompt"
          className="w-full rounded-md border border-input bg-surface-high px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring min-h-[72px]"
          placeholder="What to look for, e.g. Functions with no tests, or outdated usage of a deprecated API."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <label htmlFor="routine-cadence" className="sr-only">How often</label>
          <select
            id="routine-cadence"
            className="rounded-md border border-input bg-surface-high px-2 py-1.5 text-sm"
            value={cadence}
            onChange={(e) => setCadence(e.target.value as RoutineCadence)}
          >
            <option value="daily">{CADENCE_LABEL.daily}</option>
            <option value="weekly">{CADENCE_LABEL.weekly}</option>
          </select>
          <Button disabled={!name.trim() || !prompt.trim()} onClick={add}>
            Add routine
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}
