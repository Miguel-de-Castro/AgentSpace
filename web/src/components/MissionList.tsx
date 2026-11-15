import { Link } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { TeamBadges } from "@/components/TeamBadges";
import type { Mission } from "@/lib/types";

/**
 * .claude/plans/23-ui-ux-polish.md item 1 — every Mission list (Project view,
 * Parallel Supervision, Digest) used to render one Card per row inside a
 * `<Link>`. The Link is an inline `<a>`, so the parent's `space-y-*` margin
 * never applied and the cards sat flush against each other; each Card also
 * doubled its vertical padding (Card py-4 + CardContent py-3). A status list
 * doesn't need one elevated surface per item: this is a single panel with
 * divided rows, each row a full-width block link with hover and focus states.
 */
export function MissionList({ children }: { children: React.ReactNode }) {
  return (
    <ul className="rounded-xl border border-outline bg-surface divide-y divide-outline overflow-hidden">{children}</ul>
  );
}

export function MissionRow({
  mission,
  projectName,
  date,
  showTeam = false,
  depth = 0,
  note,
}: {
  mission: Pick<Mission, "id" | "brief" | "status" | "display_status" | "assigned_team">;
  /** Shown above the brief on cross-Project screens. */
  projectName?: string;
  /** The timestamp that matters on this screen (created vs. last changed). */
  date?: string;
  showTeam?: boolean;
  /** Indent level for a stacked Mission (plan 24 item 3). */
  depth?: number;
  /** A calm one-liner under the brief, e.g. "Waits for the one it builds on". */
  note?: string;
}) {
  const hasMeta = Boolean(projectName || date || showTeam);
  return (
    <li>
      <Link
        to={`/missions/${mission.id}`}
        style={depth > 0 ? { paddingLeft: `${1 + depth * 1.5}rem` } : undefined}
        className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-high focus-visible:bg-surface-high focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="min-w-0">
          <p className="truncate text-sm">
            {depth > 0 && (
              <span aria-hidden className="text-muted-foreground mr-1.5">
                └
              </span>
            )}
            {mission.brief}
          </p>
          {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
          {hasMeta && (
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              {projectName && <span className="shrink-0">{projectName}</span>}
              {date && <span className="shrink-0">{formatWhen(date)}</span>}
              {showTeam && <TeamBadges team={mission.assigned_team} />}
            </div>
          )}
        </div>
        <StatusBadge mission={mission} />
      </Link>
    </li>
  );
}

/** "Today 21:21", "Yesterday 18:47", or "10 Sep 18:47": scannable, no seconds, and in the UI's language (English) rather than the browser locale, so "Today" never sits next to "10 de set." */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
  return `${date} ${time}`;
}

/** .claude/plans/23-ui-ux-polish.md item 9: the loading state has the list's own shape. */
export function MissionListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <MissionList>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="px-4 py-3 space-y-2" aria-hidden>
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-3 w-1/4" />
        </li>
      ))}
    </MissionList>
  );
}
