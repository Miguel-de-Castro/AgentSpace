import { Router } from "express";
import { projectsRouter } from "./routes/projects.js";
import { missionsRouter } from "./routes/missions.js";
import { executionsRouter } from "./routes/executions.js";
import { workspaceRouter } from "./routes/workspace.js";
import { eventsRouter } from "./routes/events.js";

// The full contract from docs/07-SCHEMA_API_CONTRACT.md §7, one router per resource group.
export const apiRouter = Router();
apiRouter.use(projectsRouter);
apiRouter.use(missionsRouter);
apiRouter.use(executionsRouter);
apiRouter.use(workspaceRouter);
apiRouter.use(eventsRouter);
