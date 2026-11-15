import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./db/client.js";
import { apiRouter } from "./api/router.js";
import { isLoopbackOrigin, localOnly } from "./api/localOnly.js";
import { reconcileOrphanedWorktrees, startUsageLimitSweeper } from "./execution-engine/index.js";
import { startRoutineScheduler } from "./execution-engine/routines.js";
import { cleanupOrphanedPreviews, stopAllPreviewsSync } from "./execution-engine/preview.js";
import { getActiveProviderName } from "./provider-adapter/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Defense in depth: a stray unhandled rejection anywhere (e.g. a fire-and-forget
// Execution run) must never take the whole process down. Route-level `.catch()`
// is the primary guard; this is the backstop.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

// .claude/plans/18-mock-provider-safety-and-prod-start.md P1 item 7 — fail fast
// in production rather than silently running the mock. A real deploy that
// forgot AGENTSPACE_PROVIDER=claude-code would otherwise "run" every Mission as
// a simulation that only ever writes a .mcp.json (the originating incident). An
// explicit AGENTSPACE_ALLOW_MOCK=1 is the escape hatch for a deliberate
// mock-in-prod (demo, smoke test). Dev is unaffected — mock stays the default.
if (process.env.NODE_ENV === "production" && getActiveProviderName() === "mock" && process.env.AGENTSPACE_ALLOW_MOCK !== "1") {
  console.error(
    "Refusing to start: NODE_ENV=production but the provider resolved to 'mock' " +
      "(AGENTSPACE_PROVIDER is not 'claude-code'). Every Mission would run as a simulation. " +
      "Set AGENTSPACE_PROVIDER=claude-code, or AGENTSPACE_ALLOW_MOCK=1 to override deliberately."
  );
  process.exit(1);
}

// Plan 25: apps launched with "Run" must not outlive AgentSpace.
process.on("exit", stopAllPreviewsSync);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopAllPreviewsSync();
    process.exit(0);
  });
}

// Opens (and initializes, on first run) the SQLite store before anything else touches it.
getDb();

const app = express();
// Local-only by design: AgentSpace runs commands on this machine. See api/localOnly.ts.
app.use(localOnly);
app.use(cors({ origin: (origin, cb) => cb(null, !origin || isLoopbackOrigin(origin)) }));
app.use(express.json());

app.use("/api", apiRouter);

// The frontend: React + shadcn/ui, built from web/ into dist-web/ (`npm run build:web`).
// During development use the Vite dev server on :5173 instead (`npm run dev:all`).
const webBuildDir = join(__dirname, "..", "dist-web");
if (existsSync(webBuildDir)) {
  app.use(express.static(webBuildDir));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(join(webBuildDir, "index.html"));
  });
} else {
  app.get(/^(?!\/api).*/, (_req, res) => {
    res
      .status(503)
      .type("text/plain")
      .send(
        "The AgentSpace UI hasn't been built yet.\n\n" +
          "Run `npm run dev:all` and open http://localhost:5173,\n" +
          "or run `npm run build:web` and reload this page.\n",
      );
  });
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  const message = err instanceof Error ? err.message : "Unexpected error";
  res.status(400).json({ error: message });
});

const PORT = Number(process.env.PORT ?? 4310);
// Loopback only. Exposing this API to a network would let anyone on it run
// commands on this machine; HOST is overridable, but on purpose, not by default.
const HOST = process.env.HOST ?? "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`AgentSpace running at http://localhost:${PORT}`);
  console.log(`  API base:   http://localhost:${PORT}/api`);
  console.log(`  UI:         http://localhost:${PORT}/`);

  // .claude/plans/02-parallel-isolation.md item 2 — clean up worktrees/Execution
  // rows left behind by a previous process that died mid-Execution. Run only
  // once the server is actually listening, not at module-load time: spawning
  // `git` synchronously that early in process startup was observed to
  // intermittently fail (even `cmd.exe` itself failed to spawn once) under
  // `tsx watch`'s restart — the same call succeeds reliably once the process
  // environment has fully settled, which by definition has happened by the
  // time this callback fires.
  // Plan 25: stop an app a previous session left running BEFORE its worktree is removed.
  void cleanupOrphanedPreviews()
    .catch((err) => console.error("Preview cleanup failed:", err))
    .finally(() => reconcileOrphanedWorktrees());
  // .claude/plans/20-plano-consolidado.md Phase 3 — resume Missions paused on
  // the usage limit once their reset time passes (also catches ones whose time
  // came while AgentSpace was down).
  startUsageLimitSweeper();
  startRoutineScheduler();
});
