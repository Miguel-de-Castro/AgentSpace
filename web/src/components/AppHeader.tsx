import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { getActiveProvider, listProjects, subscribeToNotifications } from "@/lib/api";
import type { ProviderName } from "@/lib/types";

const NAV_LINKS = [
  { to: "/today", label: "Today" },
  { to: "/", label: "Projects" },
  { to: "/supervision", label: "Supervision" },
  { to: "/digest", label: "Digest" },
  { to: "/track-record", label: "Track Record" },
] as const;

// "Projects" is active on the home list AND inside any Project/Mission screen,
// so there's always a lit, obvious way back to where you started — the logo was
// the only route home before (.claude/plans/17-ux-navigation-polish.md).
function isActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/" || pathname.startsWith("/projects") || pathname.startsWith("/missions");
  return pathname === to;
}

// docs/06-DESIGN_GUARDRAILS.md #3 — no central chat/prompt box as a primary
// surface. This header carries navigation only.
export function AppHeader() {
  const location = useLocation();
  // .claude/plans/18-mock-provider-safety-and-prod-start.md P0 item 3 — the mode
  // is fixed for the life of the server process, so fetch once (no polling).
  const [provider, setProvider] = useState<ProviderName | null>(null);
  useEffect(() => {
    getActiveProvider()
      .then((p) => setProvider(p.provider))
      .catch(() => setProvider(null));
  }, []);

  // .claude/plans/20-plano-consolidado.md Phase 7.3 (21-J) — how many Missions
  // need the supervisor (approval, a question, a plan, a proposal), shown on
  // "Today" wherever you are. Re-read on SSE signals, never polled.
  const [needsYou, setNeedsYou] = useState(0);
  useEffect(() => {
    const refresh = () =>
      listProjects()
        .then((ps) => setNeedsYou(ps.reduce((n, p) => n + (p.needs_attention_count ?? 0), 0)))
        .catch(() => {});
    refresh();
    // Only status changes can change the count; evidence signals arrive every
    // second during a run and would refetch for nothing.
    return subscribeToNotifications((signal) => {
      if (signal.type === "mission.status_changed") refresh();
    });
  }, []);

  return (
    <>
      {provider === "mock" && (
        <div className="bg-primary/10 border-b border-primary/40 px-8 py-1.5 text-center text-xs text-primary">
          Simulation mode: the mock provider is active. Missions make no real code changes. Set{" "}
          <span className="font-mono">AGENTSPACE_PROVIDER=claude-code</span> and restart to run for real.
        </div>
      )}
      <header className="flex items-center justify-between px-8 h-16 border-b border-outline">
        <Link to="/" className="flex items-baseline gap-2">
          <span className="font-bold text-lg text-primary">AgentSpace</span>
          <span className="text-muted-foreground text-xs uppercase tracking-widest">Mission Control</span>
        </Link>
        <nav className="flex items-center gap-5 text-sm">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={
                isActive(location.pathname, link.to)
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground transition-colors"
              }
            >
              {link.label}
              {link.to === "/today" && needsYou > 0 && (
                <span
                  className="ml-1.5 rounded-full bg-primary-container px-1.5 py-px text-[11px] text-on-primary-container"
                  aria-label={`${needsYou} need you`}
                >
                  {needsYou}
                </span>
              )}
            </Link>
          ))}
        </nav>
      </header>
    </>
  );
}
