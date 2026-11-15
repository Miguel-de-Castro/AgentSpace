import { useState } from "react";
import { MissionList, MissionListSkeleton, MissionRow } from "@/components/MissionList";
import { useWorkspaceMissions, type ProjectMission } from "@/lib/useWorkspaceMissions";
import { isRunning, needsYou } from "@/lib/needsYou";
import type { MissionStatus } from "@/lib/types";

// Journey 7 — supervising multiple Missions at once. Grouped by what each
// one needs from the developer right now, not by Project (the whole point
// is "distinguishable at a glance," not re-deriving that per Project). Live
// via SSE (docs/03-ARCHITECTURE.md §7), never polled — a group's membership
// just quietly updates when something changes, no refresh habit invited
// (docs/06-DESIGN_GUARDRAILS.md #2).
const FINISHED: MissionStatus[] = ["completed", "rejected", "failed", "cancelled"];
// History is context, not the point of this screen: show the latest few and let
// the rest expand on request instead of an ever-growing wall.
const FINISHED_PREVIEW = 8;

export function ParallelSupervision() {
  const { missions } = useWorkspaceMissions({ live: true });

  const needsYouList = missions?.filter(needsYou) ?? [];
  const running = missions?.filter(isRunning) ?? [];
  const finished = missions?.filter((m) => FINISHED.includes(m.status)) ?? [];

  return (
    <main className="max-w-5xl mx-auto p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">Parallel Supervision</h1>
        <p className="text-muted-foreground">
          {missions === null
            ? " "
            : missions.length === 0
              ? "No Missions across any Project yet."
              : `${needsYouList.length} need${needsYouList.length === 1 ? "s" : ""} you, ${running.length} running unattended, ${finished.length} finished.`}
        </p>
      </div>

      {missions === null ? (
        <MissionListSkeleton />
      ) : (
        <>
          <MissionGroup title="Needs you" missions={needsYouList} emptyText="Nothing needs you right now." />
          <MissionGroup title="Running unattended" missions={running} emptyText="Nothing running right now." />
          <MissionGroup title="Finished" missions={finished} emptyText="Nothing finished yet." limit={FINISHED_PREVIEW} />
        </>
      )}
    </main>
  );
}

function MissionGroup({
  title,
  missions,
  emptyText,
  limit,
}: {
  title: string;
  missions: ProjectMission[];
  emptyText: string;
  limit?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  if (missions.length === 0) return null;
  const visible = limit && !showAll ? missions.slice(0, limit) : missions;

  return (
    <section className="mb-8">
      <h2 className="text-sm font-medium text-foreground mb-3">
        {title} · {missions.length}
      </h2>
      {missions.length === 0 ? (
        <p className="text-muted-foreground text-sm">{emptyText}</p>
      ) : (
        <>
          <MissionList>
            {visible.map((mission) => (
              <MissionRow key={mission.id} mission={mission} projectName={mission.project.name} date={mission.updated_at} />
            ))}
          </MissionList>
          {visible.length < missions.length && (
            <button
              className="mt-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowAll(true)}
            >
              Show all {missions.length}
            </button>
          )}
        </>
      )}
    </section>
  );
}
