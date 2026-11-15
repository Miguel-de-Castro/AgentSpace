import { Badge } from "@/components/ui/badge";
import { STATUS_BADGE_CLASS } from "@/lib/status";
import type { Mission } from "@/lib/types";

export function StatusBadge({ mission }: { mission: Pick<Mission, "status" | "display_status"> }) {
  return <Badge className={STATUS_BADGE_CLASS[mission.status]}>{mission.display_status}</Badge>;
}
