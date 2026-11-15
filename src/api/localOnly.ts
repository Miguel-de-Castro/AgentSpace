import type { NextFunction, Request, Response } from "express";

/**
 * AgentSpace runs git and shell commands on the machine it's on (Missions, the
 * "Run" preview), so its API must only ever be driven by the local user.
 * The server binds to loopback (see server.ts); this middleware closes the two
 * remaining browser-based paths in:
 *
 * - DNS rebinding: a malicious site re-points its own hostname at 127.0.0.1, so
 *   its requests become "same-origin". The Host header still carries the
 *   attacker's hostname, so anything that isn't a loopback host is refused.
 * - Cross-site requests: a page on another origin POSTing to localhost:4310
 *   (including "simple" requests that skip CORS preflight). Browsers always
 *   send Origin on those, so a non-loopback Origin is refused.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

function hostnameOf(hostHeader: string): string {
  // "localhost:4310" -> "localhost", "[::1]:4310" -> "[::1]"
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
  return hostHeader.split(":")[0];
}

// Only AgentSpace's own pages may call the API: the Express server itself and the
// Vite dev server (strictPort 5173, see web/vite.config.ts). Any other local
// server you happen to run (another dev app on localhost:3000, say) is refused.
// In production there is no Vite dev server, so :5173 isn't trusted there.
const ALLOWED_ORIGIN_PORTS = new Set(
  process.env.NODE_ENV === "production"
    ? [String(process.env.PORT ?? 4310)]
    : [String(process.env.PORT ?? 4310), "5173"],
);

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:") return false;
    return isLoopbackHostname(url.hostname) && ALLOWED_ORIGIN_PORTS.has(url.port || "80");
  } catch {
    return false;
  }
}

export function localOnly(req: Request, res: Response, next: NextFunction): void {
  const host = req.headers.host;
  if (!host || !isLoopbackHostname(hostnameOf(host))) {
    res.status(403).json({ error: "AgentSpace only accepts requests addressed to localhost." });
    return;
  }
  const origin = req.headers.origin;
  if (origin && !isLoopbackOrigin(origin)) {
    res.status(403).json({ error: "Cross-origin requests are not allowed." });
    return;
  }
  next();
}
