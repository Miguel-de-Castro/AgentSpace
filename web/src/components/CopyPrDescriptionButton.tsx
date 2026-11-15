import { useState } from "react";
import { ClipboardCopyIcon } from "lucide-react";
import { toast } from "sonner";
import { ApiError, getPrDescription } from "@/lib/api";
import { Button } from "@/components/ui/button";

// .claude/plans/24-ideias-para-analisar.md item 6 — copies a ready-to-paste PR
// title + body drafted from what the Mission recorded. AgentSpace never opens
// the PR (plan 13); this only saves writing the words. The first line is the
// title, then a blank line, then the Markdown body.
export function CopyPrDescriptionButton({ missionId }: { missionId: string }) {
  const [busy, setBusy] = useState(false);

  const copy = async () => {
    setBusy(true);
    try {
      const { title, body } = await getPrDescription(missionId);
      await navigator.clipboard.writeText(`${title}\n\n${body}`);
      toast.success("PR description copied. Paste it when you open the PR.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't copy the PR description");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={copy}>
      <ClipboardCopyIcon className="w-3.5 h-3.5 mr-1.5" />
      {busy ? "Drafting…" : "Copy PR description"}
    </Button>
  );
}
