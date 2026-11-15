import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MissionListSkeleton, formatWhen } from "@/components/MissionList";
import { TeamBadges } from "@/components/TeamBadges";
import { ApiError, answerQuestion, confirmMission, dismissMission, getWaitingDetails } from "@/lib/api";
import { isRunning, needsYou } from "@/lib/needsYou";
import { useWorkspaceMissions, type ProjectMission } from "@/lib/useWorkspaceMissions";
import type { WaitingDetails } from "@/lib/types";

// .claude/plans/24-ideias-para-analisar.md item 1 — one inbox for everything
// that is waiting on the supervisor, ordered by what blocks the most work:
// a result to decide on, a question the team can't continue without, a plan to
// review, then proposals. Guardrail #8: an inline action never hides the
// context of a binding decision, so a result always opens its own page (the gate
// with the diff, build and criteria); only questions and proposals act in place.
// No counters ticking down, no red urgency (#2): a calm list that is empty most
// of the time.

type Kind = "result" | "question" | "plan" | "proposal";

const KIND_ORDER: Kind[] = ["result", "question", "plan", "proposal"];
const KIND_TITLE: Record<Kind, string> = {
  result: "Results to decide on",
  question: "Questions from the team",
  plan: "Plans to review",
  proposal: "Proposed Missions",
};

function kindOf(m: ProjectMission): Kind | null {
  if (m.status === "awaiting-approval") return "result";
  if (m.status === "proposed") return "proposal";
  if (m.status === "waiting" && m.waiting_reason === "needs-input") return "question";
  if (m.status === "waiting" && m.waiting_reason === "plan-review") return "plan";
  return null;
}

export function Today() {
  const { missions, reload } = useWorkspaceMissions({ live: true });

  const mine = (missions ?? []).filter(needsYou);
  const running = (missions ?? []).filter(isRunning).length;
  // Oldest first inside a group: the longest-waiting item is the one to clear.
  const byKind = (kind: Kind) =>
    mine.filter((m) => kindOf(m) === kind).sort((a, b) => a.updated_at.localeCompare(b.updated_at));

  return (
    <main className="max-w-5xl mx-auto p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">Today</h1>
        <p className="text-muted-foreground">
          {missions === null
            ? " "
            : mine.length === 0
              ? `Nothing needs you.${running > 0 ? ` ${running} ${running === 1 ? "Mission is" : "Missions are"} running.` : ""}`
              : `${mine.length} ${mine.length === 1 ? "thing needs" : "things need"} you.${running > 0 ? ` ${running} running unattended.` : ""}`}
        </p>
      </div>

      {missions === null ? (
        <MissionListSkeleton />
      ) : (
        KIND_ORDER.map((kind) => {
          const items = byKind(kind);
          if (items.length === 0) return null;
          return (
            <section key={kind} className="mb-8">
              <h2 className="text-sm font-medium text-foreground mb-3">
                {KIND_TITLE[kind]} · {items.length}
              </h2>
              <ul className="rounded-xl border border-outline bg-surface divide-y divide-outline overflow-hidden">
                {items.map((m) => (
                  <li key={m.id}>
                    {kind === "question" ? (
                      <QuestionItem mission={m} onDone={reload} />
                    ) : kind === "proposal" ? (
                      <ProposalItem mission={m} onDone={reload} />
                    ) : (
                      <LinkItem mission={m} kind={kind} />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </main>
  );
}

function ItemHeader({ mission }: { mission: ProjectMission }) {
  return (
    <>
      <p className="text-sm">{mission.brief}</p>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        <Link to={`/projects/${mission.project.id}`} className="shrink-0 hover:text-foreground">
          {mission.project.name}
        </Link>
        <span className="shrink-0">{formatWhen(mission.updated_at)}</span>
        <TeamBadges team={mission.assigned_team} />
      </div>
    </>
  );
}

// A result or a plan: the decision is made on the Mission's own page, with the
// whole context in front of you.
function LinkItem({ mission, kind }: { mission: ProjectMission; kind: "result" | "plan" }) {
  return (
    <Link
      to={`/missions/${mission.id}`}
      className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-high focus-visible:bg-surface-high focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div className="min-w-0">
        <ItemHeader mission={mission} />
      </div>
      <span className="shrink-0 text-sm text-primary">{kind === "result" ? "Review the result" : "Review the plan"}</span>
    </Link>
  );
}

function QuestionItem({ mission, onDone }: { mission: ProjectMission; onDone: () => void }) {
  const [details, setDetails] = useState<WaitingDetails | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getWaitingDetails(mission.id)
      .then(setDetails)
      .catch(() => setDetails(null));
  }, [mission.id]);

  const send = async () => {
    setBusy(true);
    try {
      await answerQuestion(mission.id, answer.trim());
      toast.success("Answer sent. The team is continuing.");
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to send the answer");
      setBusy(false);
    }
  };

  return (
    <div className="px-4 py-3 space-y-2.5">
      <div>
        <ItemHeader mission={mission} />
      </div>
      <p className="text-sm font-medium leading-snug">
        {details?.role ? `${details.role}: ` : ""}
        {details?.question ?? "Loading the question…"}
      </p>
      <Textarea className="bg-surface-high" rows={2} placeholder="Your answer" value={answer} onChange={(e) => setAnswer(e.target.value)} />
      <div className="flex items-center justify-between gap-3">
        <Link to={`/missions/${mission.id}`} className="text-xs text-muted-foreground underline underline-offset-2">
          Open the Mission
        </Link>
        <Button size="sm" disabled={busy || !answer.trim()} onClick={send}>
          {busy ? "Sending…" : "Send answer"}
        </Button>
      </div>
    </div>
  );
}

const MAX_EXCLUSION_DEFAULT = 140;

function ProposalItem({ mission, onDone }: { mission: ProjectMission; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  // Item 2 — "don't propose this again" asks for a short phrase (prefilled with
  // the brief) so the rule stays readable in Settings and can be removed later.
  const [excluding, setExcluding] = useState(false);
  const [phrase, setPhrase] = useState(mission.brief.slice(0, MAX_EXCLUSION_DEFAULT));
  // Only ideas a routine raised can be "taught away"; one an AI Team Member
  // proposed from a Mission comes with its own link instead.
  const fromRoutine = !mission.proposed_by_mission_id;

  const act = async (action: "confirm" | "dismiss" | "exclude") => {
    setBusy(true);
    try {
      if (action === "confirm") await confirmMission(mission.id);
      else if (action === "dismiss") await dismissMission(mission.id);
      else {
        await dismissMission(mission.id, phrase.trim() || true);
        toast.success("Dismissed. Routines won't propose this again.");
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update the Mission");
      setBusy(false);
    }
  };

  return (
    <div className="px-4 py-3 space-y-2.5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <ItemHeader mission={mission} />
          {mission.proposed_by_mission_id && (
            <Link
              to={`/missions/${mission.proposed_by_mission_id}`}
              className="mt-1 inline-block text-xs text-muted-foreground underline underline-offset-2"
            >
              Proposed from an earlier Mission
            </Link>
          )}
        </div>
        {!excluding && (
          <div className="flex gap-2 shrink-0">
            {fromRoutine && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setExcluding(true)}>
                Don&apos;t propose again
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act("dismiss")}>
              Dismiss
            </Button>
            <Button size="sm" disabled={busy} onClick={() => act("confirm")}>
              Start
            </Button>
          </div>
        )}
      </div>
      {excluding && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Routines will skip anything like this in {mission.project.name}. Edit the phrase if it&apos;s too specific.
          </p>
          <Textarea className="bg-surface-high" rows={2} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setExcluding(false)}>
              Back
            </Button>
            <Button size="sm" disabled={busy || !phrase.trim()} onClick={() => act("exclude")}>
              Dismiss and don&apos;t propose again
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
