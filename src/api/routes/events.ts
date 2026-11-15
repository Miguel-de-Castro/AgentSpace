import { Router } from "express";
import { eventBus, type Notification } from "../eventBus.js";

export const eventsRouter = Router();

/**
 * docs/07-SCHEMA_API_CONTRACT.md §7.7 — Server-Sent Events is the
 * transport-appropriate equivalent chosen for a plain-Node/localhost
 * deployment (an Electron build would use IPC instead; the contract itself
 * doesn't care which). Payloads are always `{ type, id }` only — the UI is
 * required to re-fetch the actual resource, never render from this payload.
 */
eventsRouter.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":ok\n\n");

  const onNotification = (notification: Notification) => {
    res.write(`data: ${JSON.stringify(notification)}\n\n`);
  };

  eventBus.on("notification", onNotification);

  req.on("close", () => {
    eventBus.off("notification", onNotification);
  });
});
