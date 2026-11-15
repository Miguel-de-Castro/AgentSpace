import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * .claude/plans/20-plano-consolidado.md Phase 7.5 (21-K) — a unified diff you
 * can comment on line by line. Comments aren't a chat: they're collected on the
 * Approval Gate and sent together as ONE adjustment (the same iterate path as
 * "Send adjustment"), each pinned to its file and line.
 */
export interface DiffComment {
  path: string;
  /** Line number in the new version of the file (null for a removed line). */
  line: number | null;
  /** The code on that line, so the Developer sees exactly what was meant. */
  code: string;
  text: string;
}

interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
  newLine: number | null;
}

function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = raw.match(/\+(\d+)/);
      newLine = m ? Number(m[1]) : 0;
      inHunk = true;
      out.push({ kind: "hunk", text: raw, newLine: null });
    } else if (!inHunk || raw.startsWith("diff ")) {
      // Everything before the first hunk (diff/index/mode/---/+++) is header.
      inHunk = false;
      out.push({ kind: "meta", text: raw, newLine: null });
    } else if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("index ")) {
      out.push({ kind: "meta", text: raw, newLine: null });
    } else if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw, newLine: newLine++ });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw, newLine: null });
    } else {
      out.push({ kind: "ctx", text: raw, newLine: raw === "" ? null : newLine++ });
    }
  }
  return out;
}

const LINE_CLASS: Record<DiffLine["kind"], string> = {
  add: "text-success",
  del: "text-destructive",
  ctx: "text-muted-foreground",
  hunk: "text-primary/80",
  meta: "text-muted-foreground/60",
};

export function DiffView({
  path,
  diff,
  comments,
  onAddComment,
}: {
  path: string;
  diff: string;
  comments: DiffComment[];
  onAddComment: (c: DiffComment) => void;
}) {
  const lines = parseDiff(diff);
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const save = (l: DiffLine) => {
    if (!draft.trim()) return;
    onAddComment({ path, line: l.newLine, code: l.text.slice(1).trim(), text: draft.trim() });
    setDraft("");
    setOpenAt(null);
  };

  return (
    <div className="mt-1.5 rounded-md bg-surface overflow-x-auto text-xs font-mono">
      {lines.map((l, i) => {
        const commentable = l.kind === "add" || l.kind === "del" || (l.kind === "ctx" && l.newLine !== null);
        const here = comments.filter((c) => c.path === path && c.code === l.text.slice(1).trim() && c.line === l.newLine);
        return (
          <div key={i}>
            <div className={`group flex whitespace-pre ${LINE_CLASS[l.kind]}`}>
              <span className="w-10 shrink-0 select-none text-right pr-2 text-muted-foreground/50">{l.newLine ?? ""}</span>
              {commentable ? (
                <button
                  className="w-5 shrink-0 select-none text-primary opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`Comment on line ${l.newLine ?? "(removed)"}`}
                  onClick={() => {
                    setOpenAt(openAt === i ? null : i);
                    setDraft("");
                  }}
                >
                  +
                </button>
              ) : (
                <span className="w-5 shrink-0" />
              )}
              <span className="pr-3">{l.text || " "}</span>
            </div>
            {here.map((c, j) => (
              <p key={j} className="ml-15 my-1 mr-3 rounded border border-primary/40 bg-primary/5 px-2 py-1 font-sans text-foreground whitespace-pre-wrap">
                {c.text}
              </p>
            ))}
            {openAt === i && (
              <div className="ml-15 my-1.5 mr-3 font-sans space-y-1.5">
                <textarea
                  autoFocus
                  rows={2}
                  className="w-full rounded-md border border-input bg-surface-high px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                  placeholder="What should change here?"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(l);
                  }}
                />
                <div className="flex gap-1.5">
                  <Button size="sm" disabled={!draft.trim()} onClick={() => save(l)}>
                    Add comment
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setOpenAt(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The comments, as the one adjustment the Developer receives. */
export function commentsToAdjustment(comments: DiffComment[]): string {
  return [
    "Review comments on specific lines of your change. Address each one:",
    ...comments.map((c) => `- ${c.path}${c.line ? `:${c.line}` : " (removed line)"} \`${c.code.slice(0, 120)}\`: ${c.text}`),
  ].join("\n");
}
