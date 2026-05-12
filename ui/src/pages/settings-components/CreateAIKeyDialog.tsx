import { useState } from "react";
import { useCreateAIKey } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// --- Create AI Key Dialog ---
//
// Claude Code-only. GitHub Copilot is intentionally not exposed here —
// the backend rejects `provider=github_copilot` on POST /keys (see
// `src/routes/ai-keys.ts`), so we don't render a provider switcher. If
// Copilot or any other provider is re-enabled later, restore the
// `<Select>` and per-provider branches from git history (commit before
// this trim).

export function CreateAIKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createKey = useCreateAIKey();

  const [keyValue, setKeyValue] = useState("");
  const [keyName, setKeyName] = useState("Claude Code");
  const [cliCommand, setCliCommand] = useState("claude");
  const [configDir, setConfigDir] = useState("");

  const [formError, setFormError] = useState("");
  const [showGuide, setShowGuide] = useState(false);

  function reset() {
    setKeyValue("");
    setKeyName("Claude Code");
    setCliCommand("claude");
    setConfigDir("");
    setFormError("");
    setShowGuide(false);
    createKey.reset();
  }

  function handleClose(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  async function handleSave() {
    if (!keyName.trim()) return;
    if (!cliCommand.trim()) return;
    setFormError("");
    try {
      await createKey.mutateAsync({
        name: keyName.trim(),
        provider: "claude_cli",
        provider_type: "cli",
        cli_command: cliCommand.trim(),
        key_value: keyValue.trim() || undefined,
        config_dir: configDir.trim() || undefined,
      });
      handleClose(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  const saveDisabled =
    createKey.isPending || !keyName.trim() || !cliCommand.trim();

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Claude Code Key</DialogTitle>
          <DialogDescription>
            Add a Claude Code profile so tasks and chats can run against it.
            Each key points at its own <code className="rounded bg-muted px-1 py-0.5 text-xs">CLAUDE_CONFIG_DIR</code>,
            so you can wire several accounts in parallel.
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-3">
          {/* Collapsible guide */}
          <div className="min-w-0 rounded-lg border bg-muted/50 p-3 text-sm">
            <button
              type="button"
              onClick={() => setShowGuide(!showGuide)}
              className="flex w-full items-center justify-between font-medium text-foreground"
            >
              <span>How to get credentials</span>
              <span className="text-muted-foreground text-xs">
                {showGuide ? "Hide" : "Show guide"}
              </span>
            </button>
            {showGuide && (
              <div className="mt-3 space-y-3 text-muted-foreground">
                <div className="space-y-1.5">
                  <p className="font-medium text-foreground text-xs">1. Install Claude Code</p>
                  <pre className="max-w-full overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs">curl -fsSL https://claude.ai/install.sh | bash</pre>
                </div>
                <div className="space-y-1.5">
                  <p className="font-medium text-foreground text-xs">2. Log in with a dedicated config directory</p>
                  <pre className="max-w-full overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs">CLAUDE_CONFIG_DIR=~/.claude-work claude</pre>
                  <p className="text-xs">This creates a separate profile. Log in via <code className="bg-muted px-1 py-0.5 rounded">/login</code> when prompted.</p>
                </div>
                <div className="space-y-1.5">
                  <p className="font-medium text-foreground text-xs">3. Add the key here</p>
                  <p className="text-xs">Set the <strong>Config Directory</strong> below to the same path (e.g. <code className="bg-muted px-1 py-0.5 rounded">~/.claude-work</code>). Repeat for each account.</p>
                </div>
                <div className="rounded border border-blue-500/30 bg-blue-500/5 p-2 text-xs text-blue-700 dark:text-blue-400">
                  Each config directory stores its own OAuth credentials. You can add multiple keys with different directories to use several accounts in parallel.
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="cli-config-dir">Config Directory</Label>
            <Input
              id="cli-config-dir"
              placeholder="~/.claude  (default)"
              value={configDir}
              onChange={(e) => setConfigDir(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Path to a Claude Code config directory. Each directory holds separate credentials.
              Leave empty to use the default <code className="bg-muted px-1 py-0.5 rounded">~/.claude</code>.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="cli-key-name">Name</Label>
            <Input
              id="cli-key-name"
              placeholder="e.g. Claude Code"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
            />
          </div>

          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              Advanced options
            </summary>
            <div className="mt-2 space-y-3">
              <div className="space-y-2">
                <Label htmlFor="cli-credentials">OAuth Credentials (optional)</Label>
                <Textarea
                  id="cli-credentials"
                  placeholder='Paste contents of ~/.claude/.credentials.json'
                  value={keyValue}
                  onChange={(e) => setKeyValue(e.target.value)}
                  className="font-mono text-xs min-h-[80px]"
                />
                <p className="text-xs text-muted-foreground">
                  Only needed if distributing credentials to remote workers.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cli-command">CLI Command</Label>
                <Input
                  id="cli-command"
                  placeholder="claude"
                  value={cliCommand}
                  onChange={(e) => setCliCommand(e.target.value)}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Path or name of the claude binary (default: claude)
                </p>
              </div>
            </div>
          </details>

          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
        </div>

        <DialogFooter>
          <Button onClick={handleSave} disabled={saveDisabled}>
            {createKey.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
