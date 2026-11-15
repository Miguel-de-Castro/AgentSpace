import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join, resolve } from "node:path";
import { getDataDir, getDb } from "../db/client.js";
import { eventBus } from "../api/eventBus.js";
import { newId } from "../util/id.js";
import { getProject } from "../mission-engine/projects.js";
import { getProjectEnv } from "../mission-engine/projectEnv.js";
import type { Project } from "../domain/types.js";
import { createTempWorktreeAtSha, createWorktreeFromBranch, currentHeadSha, removeWorktree } from "./git.js";
import { findEnvExample, readEnvExample, renderEnv, type EnvVar } from "./envFile.js";

/**
 * .claude/plans/25-run-do-project.md - "Run": the supervisor launches the app of
 * a Project (or of one of its Missions) to see it working before deciding. It
 * is YOU running the code, never the team and never a routine, and it is not a
 * domain record: the registry below lives in memory only (like Checks), one
 * entry per Project.
 *
 * Which folder runs, in order:
 *   1. a Mission still working  -> its live worktree (hot reload shows the team's work);
 *   2. a Mission that finished  -> a fresh worktree of its branch (removed on Stop);
 *   3. no Mission               -> the Project's own folder (never deleted by Stop);
 *      a bare-cache Project has no folder, so it gets a throwaway worktree of its base.
 */

export type PreviewState = "installing" | "starting" | "running" | "failed" | "stopped";
export type PreviewFolderKind = "mission-live" | "mission-branch" | "project";

export interface PreviewInfo {
  project_id: string;
  mission_id: string | null;
  state: PreviewState;
  port: number | null;
  url: string | null;
  folder: string;
  folder_kind: PreviewFolderKind;
  error: string | null;
  /** The last lines of install/app output, for when it fails to come up. */
  logs: string[];
  started_at: string;
}

interface Preview extends PreviewInfo {
  child?: ChildProcess;
  owned?: { repo: string; path: string };
  /** The process that actually listens on the port (pid + creation time), to recognise it after a crash. */
  listener?: { pid: number; started_ms: number };
  aborted: boolean;
}

/** Thrown when the repo has a `.env.example`, the folder has no `.env` and nothing is saved yet. */
export class NeedsEnvError extends Error {
  constructor(public readonly vars: EnvVar[]) {
    super("This app needs values for its .env before it can start.");
  }
}

const MAX_LOG_LINES = 200;
const START_TIMEOUT_MS = Number(process.env.AGENTSPACE_PREVIEW_START_TIMEOUT_MS ?? 120_000);
const previews = new Map<string, Preview>();

// ---- small helpers --------------------------------------------------------------

function toInfo(p: Preview): PreviewInfo {
  return {
    project_id: p.project_id,
    mission_id: p.mission_id,
    state: p.state,
    port: p.port,
    url: p.url,
    folder: p.folder,
    folder_kind: p.folder_kind,
    error: p.error,
    logs: [...p.logs],
    started_at: p.started_at,
  };
}

function changed(p: Preview): void {
  eventBus.emitNotification({ type: "preview.changed", id: p.project_id });
}

function addLog(p: Preview, chunk: string): void {
  // eslint-disable-next-line no-control-regex
  const clean = chunk.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  for (const line of clean.split("\n")) {
    if (line.trim()) p.logs.push(line.slice(0, 400));
  }
  if (p.logs.length > MAX_LOG_LINES) p.logs.splice(0, p.logs.length - MAX_LOG_LINES);
}

/** Kills a process and everything it started (an `npm run dev` leaves a server grandchild). */
function killTreeSync(pid: number): void {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const server = createServer();
    server.once("error", () => resolveFree(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveFree(true)));
  });
}

function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveOk) => {
    // `localhost` lets Node try both IPv4 and IPv6: a dev server may bind either.
    const socket = connect({ host: "localhost", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolveOk(true);
    });
    socket.once("error", () => resolveOk(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolveOk(false);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- command detection ----------------------------------------------------------

export interface DetectedCommands {
  install: string | null;
  run: string | null;
}

/** From package.json: the package manager by lockfile, and a `dev` (else `start`) script. */
export function detectCommands(folder: string): DetectedCommands {
  const pkgPath = join(folder, "package.json");
  if (!existsSync(pkgPath)) return { install: null, run: null };
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return { install: null, run: null };
  }
  const pm = existsSync(join(folder, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(folder, "yarn.lock")) ? "yarn" : "npm";
  const script = scripts.dev ? "dev" : scripts.start ? "start" : null;
  let run: string | null = null;
  if (script) {
    run = `${pm} run ${script}`;
    // Vite ignores PORT, so it is passed as an argument. npm needs `--` to forward it.
    if (/\bvite\b/.test(scripts[script])) run += `${pm === "npm" ? " --" : ""} --port {PORT} --strictPort`;
  }
  return { install: `${pm} install`, run };
}

// ---- folder + .env --------------------------------------------------------------

function resolveFolder(project: Project, missionId: string | null): { folder: string; kind: PreviewFolderKind; owned?: { repo: string; path: string } } {
  if (missionId) {
    const mission = getDb().prepare("SELECT project_id FROM missions WHERE id = ?").get(missionId) as unknown as { project_id: string } | undefined;
    if (!mission || mission.project_id !== project.id) throw new Error("That Mission doesn't belong to this Project.");
    const live = getDb()
      .prepare("SELECT worktree_path FROM executions WHERE mission_id = ? AND ended_at IS NULL ORDER BY seq DESC LIMIT 1")
      .get(missionId) as unknown as { worktree_path: string } | undefined;
    if (live && existsSync(live.worktree_path)) return { folder: live.worktree_path, kind: "mission-live" };
    const latest = getDb()
      .prepare("SELECT branch_name FROM executions WHERE mission_id = ? AND branch_name IS NOT NULL ORDER BY seq DESC LIMIT 1")
      .get(missionId) as unknown as { branch_name: string } | undefined;
    if (!latest) throw new Error("This Mission hasn't produced a branch yet, so there is nothing to run.");
    const path = createWorktreeFromBranch(project.repo_path, `preview-${newId()}`, latest.branch_name);
    return { folder: path, kind: "mission-branch", owned: { repo: project.repo_path, path } };
  }
  if (project.origin_kind === "cached") {
    const path = createTempWorktreeAtSha(project.repo_path, currentHeadSha(project.repo_path, project.default_branch));
    return { folder: path, kind: "project", owned: { repo: project.repo_path, path } };
  }
  if (!existsSync(project.repo_path)) throw new Error("The repository folder wasn't found.");
  return { folder: project.repo_path, kind: "project" };
}

/** Keeps files the run creates out of the repo's commits, without touching any tracked file. */
function ensureLocallyIgnored(folder: string, patterns: string[]): void {
  try {
    const excludePath = resolve(folder, git(folder, ["rev-parse", "--git-path", "info/exclude"]));
    for (const pattern of patterns) {
      try {
        git(folder, ["check-ignore", "-q", pattern]);
      } catch {
        mkdirSync(join(excludePath, ".."), { recursive: true });
        appendFileSync(excludePath, `\n${pattern}\n`);
      }
    }
  } catch {
    // not a git folder: nothing can be committed from it anyway
  }
}

/** Writes the `.env` when the repo has an example and the folder has none; throws NeedsEnvError when values are missing. */
function prepareEnvFile(project: Project, folder: string): void {
  const examplePath = findEnvExample(folder);
  if (!examplePath || existsSync(join(folder, ".env"))) return;
  const vars = readEnvExample(folder);
  const saved = getProjectEnv(project.id);
  if (Object.keys(saved).length === 0 && vars.length > 0) throw new NeedsEnvError(vars);
  ensureLocallyIgnored(folder, [".env"]);
  writeFileSync(join(folder, ".env"), renderEnv(vars, saved));
}

// ---- lifecycle ------------------------------------------------------------------

function childEnv(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    // AgentSpace's own settings and NODE_ENV=production (which would make an
    // install skip devDependencies) don't belong to the app being launched.
    if (k.startsWith("AGENTSPACE_") || k === "NODE_ENV" || k === "PORT") continue;
    env[k] = v;
  }
  env.PORT = String(port);
  env.BROWSER = "none";
  return env;
}

function runToEnd(p: Preview, command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== "win32" });
    p.child = child;
    child.stdout?.on("data", (d) => addLog(p, String(d)));
    child.stderr?.on("data", (d) => addLog(p, String(d)));
    child.once("error", (err) => {
      addLog(p, `Couldn't run '${command}': ${err.message}`);
      resolveCode(1);
    });
    child.once("exit", (code) => resolveCode(code ?? 1));
  });
}

async function launch(p: Preview, project: Project): Promise<void> {
  const detected = detectCommands(p.folder);
  let install = project.install_command ?? detected.install;
  const run = project.run_command ?? detected.run;
  if (!run) {
    p.state = "failed";
    p.error = "No way to start this app was found. Set a run command in the Project's settings.";
    changed(p);
    return;
  }
  // The team may be editing this folder: never rewrite the lockfile it will commit.
  if (p.folder_kind === "mission-live" && install === "npm install") install = "npm install --no-package-lock";

  try {
    if (install) {
      addLog(p, `$ ${install}`);
      const code = await runToEnd(p, install, p.folder, childEnv(0));
      if (p.aborted) return;
      if (code !== 0) {
        p.state = "failed";
        p.error = `Installing dependencies failed (exit code ${code}).`;
        changed(p);
        return;
      }
      if (p.folder_kind === "mission-live") ensureLocallyIgnored(p.folder, ["node_modules"]);
    }

    let port: number;
    if (project.preview_port) {
      if (!(await isPortFree(project.preview_port))) {
        p.state = "failed";
        p.error = `Port ${project.preview_port} is already in use. Stop whatever is using it, or change the port in the Project's settings.`;
        changed(p);
        return;
      }
      port = project.preview_port;
    } else {
      port = await pickFreePort();
    }
    p.port = port;
    p.url = `http://localhost:${port}`;
    p.state = "starting";
    changed(p);

    const command = run.replace(/\{PORT\}/g, String(port));
    addLog(p, `$ ${command}`);
    const exited = runToEnd(p, command, p.folder, childEnv(port));
    let exitCode: number | null = null;
    void exited.then((c) => {
      exitCode = c;
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!p.aborted && exitCode === null && Date.now() < deadline) {
      if (await canConnect(port)) {
        p.state = "running";
        changed(p);
        void recordListener(p, port);
        // From here the app is up; an exit later means it stopped by itself or crashed.
        void exited.then((c) => {
          if (p.aborted || p.state !== "running") return;
          p.state = "failed";
          p.error = `The app stopped on its own (exit code ${c}).`;
          changed(p);
        });
        return;
      }
      await sleep(500);
    }
    if (p.aborted) return;
    p.state = "failed";
    p.error =
      exitCode !== null
        ? `The app exited before it was ready (exit code ${exitCode}). The log below may say why.`
        : "The app didn't start listening in time. The log below may say why.";
    if (exitCode === null && p.child?.pid) killTreeSync(p.child.pid);
    changed(p);
  } catch (err) {
    p.state = "failed";
    p.error = err instanceof Error ? err.message : String(err);
    changed(p);
  }
}

export function getPreview(projectId: string): PreviewInfo | null {
  const p = previews.get(projectId);
  return p ? toInfo(p) : null;
}

export async function startPreview(projectId: string, missionId: string | null): Promise<PreviewInfo> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  // One preview per Project: starting another replaces the current one.
  await stopPreview(projectId);

  const resolved = resolveFolder(project, missionId);
  try {
    prepareEnvFile(project, resolved.folder);
  } catch (err) {
    if (resolved.owned) removeWorktree(resolved.owned.repo, resolved.owned.path);
    throw err;
  }

  const preview: Preview = {
    project_id: projectId,
    mission_id: missionId,
    state: "installing",
    port: null,
    url: null,
    folder: resolved.folder,
    folder_kind: resolved.kind,
    error: null,
    logs: [],
    started_at: new Date().toISOString(),
    owned: resolved.owned,
    aborted: false,
  };
  previews.set(projectId, preview);
  persist();
  changed(preview);
  void launch(preview, project).finally(persist);
  return toInfo(preview);
}

export async function stopPreview(projectId: string): Promise<void> {
  const p = previews.get(projectId);
  if (!p) return;
  p.aborted = true;
  if (p.child?.pid) killTreeSync(p.child.pid);
  previews.delete(projectId);
  if (p.owned) {
    // Windows can hold file locks for a moment after the process dies.
    for (let attempt = 0; attempt < 4; attempt++) {
      removeWorktree(p.owned.repo, p.owned.path);
      if (!existsSync(p.owned.path)) break;
      await sleep(500);
    }
  }
  p.state = "stopped";
  persist();
  changed(p);
}

/** A Mission's worktree is about to be deleted: stop whatever is running from it. */
export function stopPreviewsInFolder(folder: string): void {
  for (const [projectId, p] of previews) {
    if (p.folder !== folder) continue;
    p.aborted = true;
    if (p.child?.pid) killTreeSync(p.child.pid);
    p.state = "stopped";
    p.error = "The Mission finished and its folder was removed. Run it again to see the final result.";
    p.child = undefined;
    // Keep the entry so the UI can say why; it is replaced by the next Run.
    previews.set(projectId, p);
    changed(p);
  }
}

/** Last-resort cleanup when AgentSpace itself exits. */
export function stopAllPreviewsSync(): void {
  for (const p of previews.values()) {
    p.aborted = true;
    if (p.child?.pid) killTreeSync(p.child.pid);
  }
  previews.clear();
  try {
    unlinkSync(stateFile());
  } catch {
    // nothing recorded
  }
}

// ---- recovery after a crash -----------------------------------------------------

// The top of an `npm run dev` tree (the shell, npm) can die with AgentSpace while
// the server it started keeps running, so what is remembered is the process that
// actually LISTENS on the port: its pid, its creation time and the port.
interface Recorded {
  pid: number;
  started_ms: number;
  port: number;
  folder: string;
}

const stateFile = () => join(getDataDir(), "previews.json");

function persist(): void {
  try {
    const live: Recorded[] = [...previews.values()]
      .filter((p) => p.listener && p.port !== null && p.state !== "stopped")
      .map((p) => ({ pid: p.listener!.pid, started_ms: p.listener!.started_ms, port: p.port as number, folder: p.folder }));
    if (live.length === 0 && !existsSync(stateFile())) return;
    mkdirSync(getDataDir(), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(live));
  } catch {
    // best effort
  }
}

/** pids listening on a TCP port, straight from the OS. */
function listeningPids(port: number): number[] {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf-8" });
      const pids = new Set<number>();
      for (const line of out.split("\n")) {
        const cols = line.trim().split(/\s+/);
        if (cols[0] === "TCP" && cols[3] === "LISTENING" && cols[1].endsWith(`:${port}`)) pids.add(Number(cols[4]));
      }
      return [...pids];
    }
    return execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

/** When a process was created (ms since epoch), or null when no such process exists. */
function startTimeOf(pid: number): Promise<number | null> {
  return new Promise((resolveTime) => {
    const done = (stdout: unknown) => {
      const ms = Date.parse(String(stdout ?? "").trim());
      resolveTime(Number.isFinite(ms) ? ms : null);
    };
    if (process.platform === "win32") {
      execFile(
        "powershell",
        ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')`],
        { encoding: "utf-8" },
        (_err, stdout) => done(stdout)
      );
    } else {
      execFile("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" }, (_err, stdout) => done(stdout));
    }
  });
}

async function recordListener(p: Preview, port: number): Promise<void> {
  for (const pid of listeningPids(port)) {
    const started = await startTimeOf(pid);
    if (started !== null && !p.aborted) {
      p.listener = { pid, started_ms: started };
      persist();
      return;
    }
  }
}

/**
 * Boot-time recovery: a previous AgentSpace process that died without cleaning
 * up may have left an app running. A recorded process is only stopped when it
 * still exists with the same creation time (so a recycled pid is never
 * mistaken for ours) AND still listens on the recorded port. Its whole tree
 * goes; the worktree is removed by reconcileOrphanedWorktrees right after.
 */
export async function cleanupOrphanedPreviews(): Promise<void> {
  if (!existsSync(stateFile())) return;
  let recorded: Recorded[] = [];
  try {
    recorded = JSON.parse(readFileSync(stateFile(), "utf-8")) as Recorded[];
  } catch {
    // unreadable: forget it
  }
  for (const r of recorded) {
    const started = await startTimeOf(r.pid);
    if (started !== null && Math.abs(started - r.started_ms) <= 1000 && listeningPids(r.port).includes(r.pid)) {
      console.warn(`Stopping an app left running from a previous session (${r.folder}, port ${r.port}).`);
      killTreeSync(r.pid);
    }
  }
  try {
    unlinkSync(stateFile());
  } catch {
    // already gone
  }
}
