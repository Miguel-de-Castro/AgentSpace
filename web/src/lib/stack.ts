import type { Mission } from "./types";

export interface StackRow<T extends Mission = Mission> {
  mission: T;
  /** 0 for a Mission that stands alone or starts a chain. */
  depth: number;
  /** Set when this Mission builds on one that isn't completed yet. */
  waitsFor: T | null;
  /** How many Missions are built directly on this one. */
  builtOnCount: number;
}

/**
 * .claude/plans/24-ideias-para-analisar.md item 3 — lays stacked Missions out as
 * an indented tree (parent, then the Missions built on it) so the approval
 * order is visible. Plain data, no graph drawing. Missions that aren't part of
 * a chain keep their original order; a chain sits where its first Mission was,
 * children oldest first.
 */
export function layoutStacks<T extends Mission>(missions: T[]): StackRow<T>[] {
  const byId = new Map(missions.map((m) => [m.id, m]));
  const children = new Map<string, T[]>();
  for (const m of missions) {
    if (m.base_mission_id && byId.has(m.base_mission_id)) {
      const list = children.get(m.base_mission_id) ?? [];
      list.push(m);
      children.set(m.base_mission_id, list);
    }
  }
  for (const list of children.values()) list.sort((a, b) => a.created_at.localeCompare(b.created_at));

  const rows: StackRow<T>[] = [];
  const visit = (m: T, depth: number, parent: T | null, seen: Set<string>) => {
    if (seen.has(m.id)) return; // a cycle can't happen, but never loop if data is odd
    seen.add(m.id);
    rows.push({
      mission: m,
      depth,
      waitsFor: parent && parent.status !== "completed" ? parent : null,
      builtOnCount: children.get(m.id)?.length ?? 0,
    });
    for (const child of children.get(m.id) ?? []) visit(child, depth + 1, m, seen);
  };
  const seen = new Set<string>();
  for (const m of missions) {
    const isChild = m.base_mission_id !== null && byId.has(m.base_mission_id);
    if (!isChild) visit(m, 0, null, seen);
  }
  return rows;
}
