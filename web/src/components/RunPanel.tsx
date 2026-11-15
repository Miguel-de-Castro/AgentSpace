import { useCallback, useEffect, useState } from "react";
import { PlayIcon, SquareIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError, getPreview, saveEnv, startPreview, stopPreview, subscribeToNotifications } from "@/lib/api";
import type { NeedsEnvVar, PreviewInfo } from "@/lib/types";

// .claude/plans/25-run-do-project.md - "Run": launch the app so the supervisor
// can SEE the result before deciding. Only the link and "is it up?" are in
// front; the log stays folded away unless something fails (guardrail #2: no
// progress percentages, no live ticker). It is the supervisor running the code,
// never the team: the buttons here are the only way to start one.
//
// One preview per Project, so the same state shows on the Project page and on
// each Mission page; `missionId` says which one this panel is for.

const STATE_TEXT: Record<PreviewInfo["state"], string> = {
  installing: "Installing dependencies…",
  starting: "Starting the app…",
  running: "Running",
  failed: "Couldn't run",
  stopped: "Stopped",
};

export function RunPanel({ projectId, missionId, repoIsCache = false }: { projectId: string; missionId?: string; repoIsCache?: boolean }) {
  const [preview, setPreview] = useState<PreviewInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsEnv, setNeedsEnv] = useState<NeedsEnvVar[] | null>(null);
  const [showLogs, setShowLogs] = useState(false);

  const load = useCallback(() => {
    getPreview(projectId)
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [projectId]);

  useEffect(() => {
    load();
    // Only this Project's own signals matter; the log isn't pushed live.
    return subscribeToNotifications((signal) => {
      if (signal.type === "preview.changed" && signal.id === projectId) load();
    });
  }, [load, projectId]);

  const isMine = preview !== null && (missionId ? preview.mission_id === missionId : preview.mission_id === null);
  const otherRunActive = preview !== null && !isMine && preview.state !== "stopped" && preview.state !== "failed";
  const active = isMine && (preview.state === "installing" || preview.state === "starting" || preview.state === "running");

  const run = async () => {
    setBusy(true);
    try {
      const result = await startPreview(projectId, missionId);
      if ("needsEnv" in result) {
        setNeedsEnv(result.needsEnv);
      } else {
        setPreview(result.preview);
        setShowLogs(false);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't start the app");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await stopPreview(projectId);
      setPreview(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't stop the app");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-outline bg-surface px-3 py-2.5 text-sm space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          {isMine && preview ? (
            <p>
              <span className={preview.state === "failed" ? "text-destructive" : preview.state === "running" ? "text-success" : "text-muted-foreground"}>
                {STATE_TEXT[preview.state]}
              </span>
              {preview.state === "running" && preview.url && (
                <>
                  {" "}
                  at{" "}
                  <a href={preview.url} target="_blank" rel="noreferrer" className="font-mono underline underline-offset-2 text-primary">
                    {preview.url}
                  </a>
                </>
              )}
            </p>
          ) : (
            <p className="text-muted-foreground">
              {missionId ? "See this Mission's app running before you decide." : "Start the app to see it running."}
            </p>
          )}
          {isMine && preview?.error && <p className="text-xs text-muted-foreground mt-0.5">{preview.error}</p>}
          {otherRunActive && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Another run is active in this Project. Starting this one replaces it.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isMine && preview && preview.logs.length > 0 && (
            <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowLogs((s) => !s)}>
              {showLogs ? "Hide log" : "Show log"}
            </button>
          )}
          {active ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={stop}>
              <SquareIcon className="w-3.5 h-3.5 mr-1.5" />
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={run}>
              <PlayIcon className="w-3.5 h-3.5 mr-1.5" />
              {busy ? "Starting…" : isMine && preview ? "Run again" : missionId ? "Run this Mission" : "Run"}
            </Button>
          )}
        </div>
      </div>
      {showLogs && isMine && preview && (
        <pre className="max-h-56 overflow-auto rounded bg-background border border-outline p-2 text-[11px] leading-snug font-mono text-muted-foreground whitespace-pre-wrap">
          {preview.logs.join("\n") || "No output yet."}
        </pre>
      )}
      <p className="text-xs text-muted-foreground">
        {missionId
          ? "This runs the code the team wrote, on your computer. Your own folder isn't touched."
          : repoIsCache
            ? "Runs a temporary copy of the repository's main branch on your computer."
            : "Runs the app from the repository folder, on your computer."}
      </p>

      {needsEnv && (
        <EnvDialog
          projectId={projectId}
          vars={needsEnv}
          onClose={() => setNeedsEnv(null)}
          onSaved={() => {
            setNeedsEnv(null);
            void run();
          }}
        />
      )}
    </div>
  );
}

// The repo ships a .env.example and the folder has no .env: ask for the values
// once, keep them on this machine for the next Runs, and write the .env only in
// the folder being run. Secrets are masked and never leave this machine.
function EnvDialog({
  projectId,
  vars,
  onClose,
  onSaved,
}: {
  projectId: string;
  vars: NeedsEnvVar[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(vars.map((v) => [v.name, v.secret ? "" : v.default]))
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await saveEnv(projectId, values);
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't save the values");
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Values for the app&apos;s .env</DialogTitle>
          <DialogDescription>
            This repository has a <span className="font-mono">.env.example</span>. Fill in what the app needs to start. The
            values stay on this computer and are reused next time; nothing is sent to the team.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 max-h-[50vh] overflow-auto pr-1">
          {vars.map((v) => (
            <div key={v.name}>
              <label htmlFor={`env-${v.name}`} className="text-sm font-mono block">
                {v.name}
              </label>
              {v.comment && <p className="text-xs text-muted-foreground">{v.comment}</p>}
              <input
                id={`env-${v.name}`}
                type={v.secret ? "password" : "text"}
                autoComplete="off"
                className="mt-1 w-full rounded-md border border-input bg-surface-high px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                placeholder={v.default || "(empty)"}
                value={values[v.name] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Leaving a field empty is fine if the app doesn&apos;t need it.</p>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save and run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
