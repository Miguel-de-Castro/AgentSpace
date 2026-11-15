import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { MissionList, MissionListSkeleton, MissionRow } from "@/components/MissionList";
import { useWorkspaceMissions, type ProjectMission } from "@/lib/useWorkspaceMissions";

const WINDOWS = [
  { value: 1, label: "Last day" },
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 0, label: "Everything" },
] as const;

/**
 * .claude/plans/20-plano-consolidado.md Phase 7.6 (21-M) — a plain Markdown
 * changelog of what shipped in the window (completed Missions only: approved,
 * or finished with nothing to approve), grouped by Project, ready to paste into
 * a standup, a PR description or release notes.
 */
function buildChangelog(missions: ProjectMission[], windowLabel: string): string {
  const done = missions.filter((m) => m.status === "completed");
  const byProject = new Map<string, ProjectMission[]>();
  for (const m of done) byProject.set(m.project.name, [...(byProject.get(m.project.name) ?? []), m]);
  const lines = [`## Changelog (${windowLabel.toLowerCase()})`];
  for (const [project, items] of byProject) {
    lines.push("", `### ${project}`);
    for (const m of items) lines.push(`- ${m.brief.replace(/\s+/g, " ").trim()}`);
  }
  return lines.join("\n");
}

// Journey 2 — "what did it do while I was away," across every Project at
// once, in under a minute (01-PRD.md's own success criterion). A
// reverse-chronological recap of what changed, not a live feed — this is a
// point-in-time read, refetched on open, never pushed to (unlike Parallel
// Supervision, which is deliberately live: Digest is "catch up," not
// "watch now").
export function Digest() {
  const { missions } = useWorkspaceMissions();
  const [windowDays, setWindowDays] = useState<number>(7);

  const cutoff = windowDays > 0 ? Date.now() - windowDays * 24 * 60 * 60 * 1000 : 0;
  const inWindow = (missions ?? [])
    .filter((m) => new Date(m.updated_at).getTime() >= cutoff)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  const completedCount = inWindow.filter((m) => m.status === "completed").length;
  const windowLabel = WINDOWS.find((w) => w.value === windowDays)?.label ?? "";

  const copyChangelog = async () => {
    try {
      await navigator.clipboard.writeText(buildChangelog(inWindow, windowLabel));
      toast.success(`Copied a changelog of ${completedCount} completed ${completedCount === 1 ? "Mission" : "Missions"}.`);
    } catch {
      toast.error("Couldn't copy to the clipboard.");
    }
  };

  return (
    <main className="max-w-5xl mx-auto p-8">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold mb-1">Digest</h1>
          <p className="text-muted-foreground">What happened while you were away, across every Project.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" disabled={completedCount === 0} onClick={copyChangelog}>
            Copy changelog
          </Button>
          <select
            className="rounded-md border border-input bg-surface-high px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
          >
            {WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {missions === null && <MissionListSkeleton />}
      {missions && inWindow.length === 0 && (
        <p className="text-muted-foreground text-sm">Nothing changed in this window.</p>
      )}

      {inWindow.length > 0 && (
        <MissionList>
          {inWindow.map((mission) => (
            <MissionRow key={mission.id} mission={mission} projectName={mission.project.name} date={mission.updated_at} />
          ))}
        </MissionList>
      )}
    </main>
  );
}
