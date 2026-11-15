import { useCallback, useEffect, useState } from "react";
import { listMissions, listProjects, subscribeToNotifications } from "./api";
import type { Mission, Project } from "./types";

export interface ProjectMission extends Mission {
  project: Project;
}

/**
 * Shared across Parallel Supervision and Digest — both are views over "every
 * Mission across every Project," just grouped differently. No dedicated
 * cross-Project endpoint exists (`.claude/plans/07-remaining-web-screens.md`
 * deliberately didn't add one — nothing here needs server-side aggregation),
 * so this fetches per-Project and merges client-side.
 *
 * `live: true` re-fetches on every SSE signal (docs/03-ARCHITECTURE.md §7 —
 * re-read the record, never trust the notification payload) instead of
 * polling, so a multi-Mission view stays current without an anxious refresh
 * habit (docs/06-DESIGN_GUARDRAILS.md #2).
 */
export function useWorkspaceMissions(opts: { live?: boolean } = {}) {
  const [missions, setMissions] = useState<ProjectMission[] | null>(null);

  const load = useCallback(() => {
    listProjects().then(async (projects) => {
      const perProject = await Promise.all(
        projects.map((project) => listMissions(project.id).then((ms) => ms.map((m): ProjectMission => ({ ...m, project }))))
      );
      setMissions(perProject.flat());
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!opts.live) return;
    return subscribeToNotifications(() => load());
  }, [load, opts.live]);

  return { missions, reload: load };
}
