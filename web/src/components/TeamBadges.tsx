import { Badge } from "@/components/ui/badge";
import type { AssignedTeamEntry } from "@/lib/types";

// .claude/plans/10-team-composition-ui.md — the Assigned Team made visible.
// "AI Team / Team Member" is central product vocabulary (docs/20-UBIQUITOUS_
// LANGUAGE.md: never "Agent"), but until now it never appeared on any screen.
// A quiet row of role badges, shown wherever a Mission is shown. Renders
// nothing (not an empty shell) when a Mission has no assigned roles.
export function TeamBadges({
  team,
  className = "",
}: {
  team: AssignedTeamEntry[] | null | undefined;
  className?: string;
}) {
  if (!team || team.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {team.map((member) => (
        <Badge key={member.role} variant="outline" className="text-xs font-normal">
          {member.role}
        </Badge>
      ))}
    </div>
  );
}
