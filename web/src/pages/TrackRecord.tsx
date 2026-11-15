import { useEffect, useState } from "react";
import { listProjects, projectTrustLedger, workspaceTrustLedger } from "@/lib/api";
import type { Project, TrustLedgerAggregate } from "@/lib/types";

const WINDOWS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "", label: "All time" },
] as const;

// Journey 8 — the developer's own accumulated track record, consulted on
// their own terms, never pushed on them (docs/06-DESIGN_GUARDRAILS.md #7:
// "the developer's own history to consult, not a compliance score being
// reported on them"). Binding Decisions only (approved/rejected) — the
// Trust Ledger, as built (src/mission-engine/trustLedger.ts), deliberately
// aggregates only the moments something merged into a protected branch;
// Lightweight reactions are a different, non-aggregated signal (see
// MissionDetail's LightweightAcknowledgment).
export function TrackRecord() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [window, setWindowValue] = useState<string>("30d");
  const [aggregate, setAggregate] = useState<TrustLedgerAggregate[] | null>(null);

  useEffect(() => {
    listProjects().then(setProjects);
  }, []);

  useEffect(() => {
    setAggregate(null);
    const opts = window ? { window } : {};
    const fetch = projectId ? projectTrustLedger(projectId, opts) : workspaceTrustLedger(opts);
    fetch.then(setAggregate);
  }, [projectId, window]);

  const approved = aggregate?.find((a) => a.outcome === "approved")?.count ?? 0;
  const rejected = aggregate?.find((a) => a.outcome === "rejected")?.count ?? 0;
  const total = approved + rejected;

  return (
    <main className="max-w-3xl mx-auto p-8">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold mb-1">Track Record</h1>
          <p className="text-muted-foreground">
            Your own history of Binding Decisions: the moments you approved or rejected a change to a protected branch.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-6">
        <select
          className="rounded-md border border-input bg-surface-high px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">All Projects</option>
          {projects?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className="rounded-md border border-input bg-surface-high px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
          value={window}
          onChange={(e) => setWindowValue(e.target.value)}
        >
          {WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
      </div>

      {aggregate === null && <p className="text-muted-foreground text-sm">Loading…</p>}

      {aggregate && total === 0 && (
        <p className="text-muted-foreground text-sm">No Binding Decisions recorded in this window.</p>
      )}

      {aggregate && total > 0 && (
        <div className="space-y-4">
          <OutcomeBar label="Approved" count={approved} total={total} className="bg-success" />
          <OutcomeBar label="Rejected" count={rejected} total={total} className="bg-rejected" />
        </div>
      )}
    </main>
  );
}

function OutcomeBar({ label, count, total, className }: { label: string; count: number; total: number; className: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm mb-1">
        <span>{label}</span>
        <span className="text-muted-foreground">
          {count} ({pct}%)
        </span>
      </div>
      <div className="h-2 rounded-full bg-surface-high overflow-hidden">
        <div className={`h-full rounded-full ${className}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
