import type { Mission, MissionStatus } from "./types";

// Shared by Today, Parallel Supervision and (via the server's own count) the
// header: what "needs the supervisor" and what "runs unattended" mean, in one
// place. A usage-limit pause resumes on its own, so it sits with the
// unattended work; a question or a plan to review needs the supervisor.
const NEEDS_YOU: MissionStatus[] = ["awaiting-approval", "proposed"];
const RUNNING: MissionStatus[] = ["queued", "running"];

type StatusFields = Pick<Mission, "status" | "waiting_reason">;

export const needsYou = (m: StatusFields) =>
  NEEDS_YOU.includes(m.status) || (m.status === "waiting" && m.waiting_reason !== "usage-limit");

export const isRunning = (m: StatusFields) =>
  RUNNING.includes(m.status) || (m.status === "waiting" && m.waiting_reason === "usage-limit");
