import { useState } from "react";
import { FolderOpenIcon } from "lucide-react";
import { toast } from "sonner";
import { ApiError, revealProjectFolder } from "@/lib/api";

// .claude/plans/17-ux-navigation-polish.md — opens the Project's repo folder in
// the OS file manager (via the local backend; a browser can't). Used on the
// Dashboard card, the Project header, and Settings. `stopPropagation` so it can
// sit inside a clickable card without also triggering the card's navigation.
export function OpenFolderButton({ projectId, label }: { projectId: string; label?: string }) {
  const [busy, setBusy] = useState(false);

  const open = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      await revealProjectFolder(projectId);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't open the folder");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={open}
      disabled={busy}
      title="Open folder in file explorer"
      aria-label="Open folder in file explorer"
      className="inline-flex items-center gap-1.5 rounded-md border border-outline px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-primary/60 transition-colors disabled:opacity-60"
    >
      <FolderOpenIcon className="w-3.5 h-3.5" />
      {label && <span>{label}</span>}
    </button>
  );
}
