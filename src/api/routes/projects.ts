import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { Router } from "express";
import { asyncRoute } from "../asyncRoute.js";
import { serializeMission } from "../serialize.js";
import * as missionEngine from "../../mission-engine/index.js";
import { latestBranchOf, startExecution } from "../../execution-engine/index.js";
import { cloneBareRepository, cloneRepository, removeClonedRepo } from "../../execution-engine/git.js";
import { budgetStatus } from "../../execution-engine/budget.js";
import { runRoutine } from "../../execution-engine/routines.js";
import { NeedsEnvError, detectCommands, getPreview, startPreview, stopPreview } from "../../execution-engine/preview.js";
import { findEnvExample, readEnvExample } from "../../execution-engine/envFile.js";
import type { MissionStatus } from "../../domain/types.js";
import { windowToSince } from "../../util/window.js";

export const projectsRouter = Router();

// docs/07-SCHEMA_API_CONTRACT.md §7.1
projectsRouter.get(
  "/projects",
  asyncRoute(async (_req, res) => {
    res.json(missionEngine.listProjects());
  })
);

projectsRouter.post(
  "/projects",
  asyncRoute(async (req, res) => {
    const { repo_path, name, clone_url, bare_cache } = req.body ?? {};

    // .claude/plans/19-clone-git-repository.md — two ways to connect: a local
    // path (as before), or a git URL that AgentSpace clones into a managed
    // directory. The clone (network + write git) happens in Execution Engine;
    // this route just orchestrates clone-then-onboard. A clone failure surfaces
    // as a clear 400 and no Project row is created.
    if (clone_url) {
      if (typeof clone_url !== "string" || !clone_url.trim()) {
        res.status(400).json({ error: "clone_url must be a non-empty string" });
        return;
      }
      let dest: string;
      try {
        // Phase 7.9: a bare cache keeps no working copy between Missions.
        const cacheOnly = bare_cache === true;
        dest = cacheOnly
          ? cloneBareRepository(clone_url.trim(), typeof name === "string" ? name : undefined)
          : cloneRepository(clone_url.trim(), typeof name === "string" ? name : undefined);
      } catch (err) {
        res.status(400).json({ error: `Clone failed: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      const project = missionEngine.onboardProject({
        repo_path: dest,
        name,
        origin_kind: bare_cache === true ? "cached" : "cloned",
        clone_url: clone_url.trim(),
      });
      res.status(201).json(project);
      return;
    }

    if (!repo_path) {
      res.status(400).json({ error: "repo_path or clone_url is required" });
      return;
    }
    const project = missionEngine.onboardProject({ repo_path, name });
    res.status(201).json(project);
  })
);

// .claude/plans/17-ux-navigation-polish.md P1 — validate a local path BEFORE the
// user submits Connect Repository, so a bad path is an inline hint rather than a
// post-submit toast. Read-only: only reports whether the path exists and looks
// like a git repo.
projectsRouter.post(
  "/projects/validate-path",
  asyncRoute(async (req, res) => {
    const { repo_path } = req.body ?? {};
    if (typeof repo_path !== "string" || !repo_path.trim()) {
      res.status(400).json({ error: "repo_path is required" });
      return;
    }
    const path = repo_path.trim();
    if (!existsSync(path)) {
      res.json({ exists: false, is_git_repo: false });
      return;
    }
    let isGitRepo = false;
    try {
      isGitRepo =
        execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: path, encoding: "utf-8" }).trim() === "true";
    } catch {
      isGitRepo = false;
    }
    res.json({ exists: true, is_git_repo: isGitRepo });
  })
);

// .claude/plans/19-clone-git-repository.md P0 — remove a Project. For a cloned
// Project the managed directory is deleted too (it only existed for AgentSpace);
// for a local one only the DB rows go, never the user's own directory. Refuses
// while a Mission is live. Never touches origin.
projectsRouter.delete(
  "/projects/:id",
  asyncRoute(async (req, res) => {
    const project = missionEngine.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (missionEngine.projectHasLiveMissions(req.params.id)) {
      res.status(409).json({ error: "This Project has a Mission still running — wait for it or cancel it first." });
      return;
    }
    await stopPreview(req.params.id); // plan 25: an app launched from this Project goes with it

    missionEngine.deleteProject(req.params.id);

    let directory_removed = false;
    if (project.origin_kind !== "local") {
      directory_removed = removeClonedRepo(project.repo_path);
    }
    res.json({ deleted: true, origin_kind: project.origin_kind, directory_removed });
  })
);

projectsRouter.get(
  "/projects/:id",
  asyncRoute(async (req, res) => {
    const project = missionEngine.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(project);
  })
);

// .claude/plans/24-ideias-para-analisar.md item 7 — read on demand (Settings,
// New Mission); never polled.
projectsRouter.get(
  "/projects/:id/budget",
  asyncRoute(async (req, res) => {
    const project = missionEngine.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(budgetStatus(project));
  })
);

// .claude/plans/25-run-do-project.md - "Run": launch the Project's app (or one of
// its Missions') and show the localhost link. State lives in memory only.
projectsRouter.post(
  "/projects/:id/preview",
  asyncRoute(async (req, res) => {
    const missionId = typeof req.body?.mission_id === "string" && req.body.mission_id ? req.body.mission_id : null;
    try {
      res.status(201).json(await startPreview(req.params.id, missionId));
    } catch (err) {
      if (err instanceof NeedsEnvError) {
        res.status(409).json({ error: err.message, needs_env: err.vars });
        return;
      }
      throw err;
    }
  })
);

projectsRouter.get(
  "/projects/:id/preview",
  asyncRoute(async (req, res) => {
    res.json(getPreview(req.params.id));
  })
);

projectsRouter.delete(
  "/projects/:id/preview",
  asyncRoute(async (req, res) => {
    await stopPreview(req.params.id);
    res.json({ stopped: true });
  })
);

// What Settings shows for "Run": the commands auto-detected from the repo, the
// variables of its .env.example, and which ones have a saved value. A secret's
// saved value is never sent back; only that one exists.
projectsRouter.get(
  "/projects/:id/run-config",
  asyncRoute(async (req, res) => {
    const project = missionEngine.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const folderOk = project.origin_kind !== "cached" && project.repo_available;
    const saved = missionEngine.getProjectEnv(project.id);
    const example = folderOk && findEnvExample(project.repo_path) ? readEnvExample(project.repo_path) : [];
    const names = new Set([...example.map((v) => v.name), ...Object.keys(saved)]);
    const vars = [...names].map((name) => {
      const fromExample = example.find((v) => v.name === name);
      const secret = fromExample?.secret ?? /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH)/i.test(name);
      return {
        name,
        secret,
        comment: fromExample?.comment ?? null,
        default: fromExample?.default ?? "",
        has_value: name in saved,
        value: name in saved && !secret ? saved[name] : null,
      };
    });
    res.json({ detected: folderOk ? detectCommands(project.repo_path) : { install: null, run: null }, vars });
  })
);

// `null` keeps the stored value of a masked field the user left alone.
projectsRouter.put(
  "/projects/:id/env",
  asyncRoute(async (req, res) => {
    const values = req.body?.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      res.status(400).json({ error: "values must be an object of NAME: value" });
      return;
    }
    const clean: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(values)) clean[name] = typeof value === "string" ? value : null;
    missionEngine.setProjectEnv(req.params.id, clean);
    res.json({ saved: true });
  })
);

projectsRouter.patch(
  "/projects/:id",
  asyncRoute(async (req, res) => {
    const { name, team_roster, permission_policy, repo_path, auto_fix_loop, instructions, role_instructions, weekly_budget_usd, routine_exclusions, run_command, install_command, preview_port } = req.body ?? {};
    const project = missionEngine.updateProject(req.params.id, {
      name,
      team_roster,
      permission_policy,
      repo_path: typeof repo_path === "string" ? repo_path : undefined,
      auto_fix_loop: typeof auto_fix_loop === "boolean" ? auto_fix_loop : undefined,
      instructions: typeof instructions === "string" || instructions === null ? instructions : undefined,
      role_instructions: role_instructions && typeof role_instructions === "object" ? role_instructions : undefined,
      run_command: typeof run_command === "string" || run_command === null ? run_command : undefined,
      install_command: typeof install_command === "string" || install_command === null ? install_command : undefined,
      preview_port: typeof preview_port === "number" || preview_port === null ? preview_port : undefined,
      routine_exclusions: Array.isArray(routine_exclusions) ? routine_exclusions.map(String) : undefined,
      weekly_budget_usd: typeof weekly_budget_usd === "number" || weekly_budget_usd === null ? weekly_budget_usd : undefined,
    });
    res.json(project);
  })
);

// .claude/plans/completed/05-checks-approval-gate.md — a separate write path from the
// general PATCH above, deliberately: a credential shouldn't ride along with
// routine name/roster edits, and this response never echoes the token back.
projectsRouter.post(
  "/projects/:id/github-token",
  asyncRoute(async (req, res) => {
    const { token } = req.body ?? {};
    if (typeof token !== "string" || !token) {
      res.status(400).json({ error: "token is required" });
      return;
    }
    missionEngine.setGithubToken(req.params.id, token);
    res.status(204).end();
  })
);

// .claude/plans/17-ux-navigation-polish.md — open the Project's repo folder in
// the OS file manager. Only possible from the backend: a browser can't launch
// the file explorer (sandbox). The path is the stored repo_path, never client
// input, so there's no injection surface; it's passed as a spawn arg (no shell).
// AgentSpace is a local, single-user tool, so launching a local file manager is
// in-scope here in a way it never would be for a hosted service.
projectsRouter.post(
  "/projects/:id/reveal",
  asyncRoute(async (req, res) => {
    const project = missionEngine.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!existsSync(project.repo_path)) {
      res.status(409).json({ error: `The repository folder no longer exists at ${project.repo_path}` });
      return;
    }

    const os = platform();
    const [cmd, args] =
      os === "win32"
        ? ["explorer.exe", [project.repo_path]]
        : os === "darwin"
          ? ["open", [project.repo_path]]
          : ["xdg-open", [project.repo_path]];

    // Fire-and-forget: `explorer.exe` notoriously exits with code 1 even on
    // success, so a non-zero exit is not treated as failure here — we only
    // report an outright spawn error (e.g. the command isn't on PATH).
    execFile(cmd as string, args as string[], (err) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        console.error(`reveal: could not launch file manager (${cmd}):`, err);
      }
    });
    res.status(202).end();
  })
);

projectsRouter.get(
  "/projects/:id/missions",
  asyncRoute(async (req, res) => {
    const status = req.query.status as MissionStatus | undefined;
    const missions = missionEngine.listMissions(req.params.id, status);
    res.json(missions.map(serializeMission));
  })
);

// Journey 1 — starting a Mission. Kicks off the initial Execution once the
// Mission row exists, per docs/03-ARCHITECTURE.md §5's "commit and walk away."
projectsRouter.post(
  "/projects/:id/missions",
  asyncRoute(async (req, res) => {
    const { brief, reference_material, assigned_team, plan_checkpoint, acceptance_criteria, base_mission_id } = req.body ?? {};
    if (!brief) {
      res.status(400).json({ error: "brief is required" });
      return;
    }
    // Phase 7.7 (21-L): stack on another Mission's branch. Only a Mission that
    // already has a branch to build on can be a parent.
    let base_branch: string | undefined;
    if (base_mission_id !== undefined && base_mission_id !== null) {
      const parent = typeof base_mission_id === "string" ? missionEngine.getMission(base_mission_id) : undefined;
      if (!parent || parent.project_id !== req.params.id) {
        res.status(400).json({ error: "base_mission_id must be a Mission in this Project" });
        return;
      }
      if (parent.status !== "awaiting-approval" && parent.status !== "completed") {
        res.status(409).json({ error: "You can build on a Mission once its result is ready (awaiting your decision or completed)." });
        return;
      }
      base_branch = latestBranchOf(parent.id);
      if (!base_branch) {
        res.status(409).json({ error: "That Mission has no branch to build on." });
        return;
      }
    }
    const mission = missionEngine.createMission(req.params.id, {
      base_mission_id: typeof base_mission_id === "string" ? base_mission_id : undefined,
      base_branch,
      brief,
      reference_material,
      assigned_team,
      plan_checkpoint: plan_checkpoint === true,
      acceptance_criteria,
    });
    // Fire-and-forget (Journey 1 — "free to walk away"), but a failure here
    // must never crash the process: it's surfaced as a failed Execution via
    // finalizeExecution's own error handling, not an unhandled rejection.
    startExecution(mission.id, "initial").catch((err) => {
      console.error(`Failed to start initial Execution for mission ${mission.id}:`, err);
    });
    res.status(201).json(serializeMission(mission));
  })
);

projectsRouter.get(
  "/projects/:id/timeline",
  asyncRoute(async (req, res) => {
    res.json(missionEngine.projectTimeline(req.params.id));
  })
);

projectsRouter.get(
  "/projects/:id/trust-ledger",
  asyncRoute(async (req, res) => {
    const since = req.query.window ? windowToSince(String(req.query.window)) : undefined;
    const pathPrefix = req.query.path_prefix ? String(req.query.path_prefix) : undefined;
    res.json(missionEngine.projectTrustLedger(req.params.id, { since, pathPrefix }));
  })
);

// Phase 7.7 (21-N): routines. They only ever PROPOSE Missions (see
// mission-engine/routines.ts); creating one is off until the supervisor enables it.
projectsRouter.get(
  "/projects/:id/routines",
  asyncRoute(async (req, res) => {
    res.json(missionEngine.listRoutines(req.params.id));
  })
);

projectsRouter.post(
  "/projects/:id/routines",
  asyncRoute(async (req, res) => {
    const { name, prompt, cadence } = req.body ?? {};
    try {
      res.status(201).json(missionEngine.createRoutine(req.params.id, { name, prompt, cadence }));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  })
);

projectsRouter.patch(
  "/routines/:id",
  asyncRoute(async (req, res) => {
    const { name, prompt, cadence, enabled } = req.body ?? {};
    try {
      res.json(
        missionEngine.updateRoutine(req.params.id, {
          name: typeof name === "string" ? name : undefined,
          prompt: typeof prompt === "string" ? prompt : undefined,
          cadence,
          enabled: typeof enabled === "boolean" ? enabled : undefined,
        })
      );
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  })
);

projectsRouter.delete(
  "/routines/:id",
  asyncRoute(async (req, res) => {
    missionEngine.deleteRoutine(req.params.id);
    res.json({ deleted: true });
  })
);

projectsRouter.post(
  "/routines/:id/run",
  asyncRoute(async (req, res) => {
    if (!missionEngine.getRoutine(req.params.id)) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    res.json(await runRoutine(req.params.id));
  })
);
