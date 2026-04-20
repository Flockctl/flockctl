import { useState } from "react";
import {
  useAIKeys,
  useCreateAIKey,
  useUpdateAIKey,
  useDeleteAIKey,
  useBudgets,
  useCreateBudget,
  useDeleteBudget,
  useMeta,
  useUpdateMetaDefaults,
} from "@/lib/hooks";
import type {
  AIProviderKeyResponse,
} from "@/lib/types";
import type { BudgetSummaryItem } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Plus,
  Zap,
  DollarSign,
  Trash2,
  Server,
  Sliders,
} from "lucide-react";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import { ServerConnectionsList } from "@/components/server-connections";
import { SecretsPanel } from "@/components/secrets-panel";

// --- Create AI Key Dialog ---

function CreateAIKeyDialog({
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
    if (!cliCommand.trim() || !keyName.trim()) return;
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

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Claude Code Key</DialogTitle>
          <DialogDescription>
            Add OAuth credentials to distribute to workers automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
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
            <div className="mt-2 space-y-4">
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
          <Button
            onClick={handleSave}
            disabled={!cliCommand.trim() || !keyName.trim() || createKey.isPending}
          >
            {createKey.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- AI Key Table ---

function AIKeyTable({
  keys,
  isLoading,
  error,
}: {
  keys: AIProviderKeyResponse[] | undefined;
  isLoading: boolean;
  error: Error | null;
}) {
  const updateKey = useUpdateAIKey();
  const deleteKey = useDeleteAIKey();
  const deleteConfirm = useConfirmDialog();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Failed to load keys: {error.message}
      </p>
    );
  }

  if (!keys || keys.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No Claude Code keys configured yet.</p>
    );
  }

  return (
    <>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Config Dir</TableHead>
          <TableHead>Credentials</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-[140px]">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.map((key: AIProviderKeyResponse) => (
          <TableRow key={key.id}>
            <TableCell className="text-sm">
              {editingId === key.id ? (
                <Input
                  autoFocus
                  className="h-7 text-sm"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={() => {
                    if (editName.trim() && editName.trim() !== (key.name ?? key.label ?? "")) {
                      updateKey.mutate({ keyId: key.id, data: { label: editName.trim() } });
                    }
                    setEditingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="cursor-pointer rounded px-1 -mx-1 hover:bg-muted transition-colors text-left"
                  onClick={() => { setEditingId(key.id); setEditName(key.name ?? key.label ?? ""); }}
                  title="Click to rename"
                >
                  {key.name ?? key.label ?? <span className="text-muted-foreground italic">unnamed</span>}
                </button>
              )}
            </TableCell>
            <TableCell>
              {key.config_dir ? (
                <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{key.config_dir}</code>
              ) : (
                <span className="text-xs text-muted-foreground">default</span>
              )}
            </TableCell>
            <TableCell>
              <Badge variant="outline" className="gap-1">
                <Zap className="h-3 w-3" />
                {key.key_suffix ? "OAuth" : "Local auth"}
              </Badge>
            </TableCell>
            <TableCell>
              {key.is_active ? (
                <Badge className="bg-green-600 text-white dark:bg-green-700">Active</Badge>
              ) : (
                <Badge variant="destructive">Inactive</Badge>
              )}
            </TableCell>
            <TableCell>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={updateKey.isPending}
                  onClick={() =>
                    updateKey.mutate({ keyId: key.id, data: { is_active: !key.is_active } })
                  }
                >
                  {key.is_active ? "Disable" : "Enable"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                  disabled={deleteKey.isPending}
                  onClick={() => deleteConfirm.requestConfirm(key.id)}
                >
                  Delete
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Claude Code Key"
        description="This will permanently delete this key. Workers using it will no longer receive credentials for authentication. This action cannot be undone."
        isPending={deleteKey.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            deleteKey.mutate(deleteConfirm.targetId, {
              onSuccess: () => deleteConfirm.reset(),
            });
          }
        }}
      />
    </>
  );
}

// --- Defaults Panel ---

const NONE_VALUE = "__none__";

function DefaultsPanel() {
  const { data: meta, isLoading } = useMeta();
  const updateDefaults = useUpdateMetaDefaults();

  if (isLoading || !meta) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  const models = meta.models ?? [];
  const activeKeys = (meta.keys ?? []).filter((k) => k.is_active);
  const currentModel = meta.defaults?.model ?? "";
  const currentKeyId = meta.defaults?.key_id ?? null;

  return (
    <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="default-model">Default AI Model</Label>
        <Select
          value={currentModel}
          onValueChange={(v) => updateDefaults.mutate({ default_model: v })}
        >
          <SelectTrigger id="default-model">
            <SelectValue placeholder="Pick a model" />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Used when a chat doesn&apos;t override and the project has no <code className="bg-muted px-1 py-0.5 rounded">model</code> set.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="default-key">Default Provider Key</Label>
        <Select
          value={currentKeyId ? String(currentKeyId) : NONE_VALUE}
          onValueChange={(v) =>
            updateDefaults.mutate({
              default_key_id: v === NONE_VALUE ? null : Number(v),
            })
          }
        >
          <SelectTrigger id="default-key">
            <SelectValue placeholder="No default" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>No default</SelectItem>
            {activeKeys.map((k) => (
              <SelectItem key={k.id} value={String(k.id)}>{k.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Used when a chat doesn&apos;t pick a key explicitly. Inactive keys are skipped at runtime.
        </p>
      </div>

      {updateDefaults.error && (
        <p className="text-sm text-destructive sm:col-span-2">
          Failed to save: {updateDefaults.error.message}
        </p>
      )}
    </div>
  );
}

// --- Settings Page ---

export default function SettingsPage() {
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [createBudgetOpen, setCreateBudgetOpen] = useState(false);

  const { data: aiKeys, isLoading: aiKeysLoading, error: aiKeysError } = useAIKeys();

  return (
    <div>
      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="mt-1 text-muted-foreground">
        Manage AI provider keys and budget limits.
      </p>

      {/* Global Defaults */}
      <div className="mt-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Sliders className="h-5 w-5" />
          Defaults
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Default model and provider key used when a chat or project doesn&apos;t specify one.
          Stored in <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.flockctlrc</code>.
        </p>
        <div className="mt-4">
          <DefaultsPanel />
        </div>
      </div>

      {/* Server Connections */}
      <div className="mt-8">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Server className="h-5 w-5" />
          Server Connections
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect to remote Flockctl instances. Tokens are stored on the backend in{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.flockctlrc</code>{" "}
          (chmod 600) — never in the browser.
        </p>
        <div className="mt-4">
          <ServerConnectionsList />
        </div>
      </div>

      {/* AI Provider Keys */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold">AI Provider Keys</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage API keys for AI providers. Keys are used for task execution and chat.
        </p>

        <div className="mt-4 space-y-4">
          <Button onClick={() => setCreateKeyOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            Add Key
          </Button>

          <AIKeyTable keys={aiKeys} isLoading={aiKeysLoading} error={aiKeysError} />

          <CreateAIKeyDialog
            open={createKeyOpen}
            onOpenChange={setCreateKeyOpen}
          />
        </div>
      </div>

      {/* Global Secrets */}
      <div className="mt-8">
        <SecretsPanel scope="global" />
      </div>

      {/* Budget Limits */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <DollarSign className="h-5 w-5" />
          Budget Limits
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Set spending limits to control AI costs. Limits can pause execution or show warnings.
        </p>

        <div className="mt-4 space-y-4">
          <Button onClick={() => setCreateBudgetOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            Add Budget Limit
          </Button>

          <BudgetTable />

          <CreateBudgetDialog
            open={createBudgetOpen}
            onOpenChange={setCreateBudgetOpen}
          />
        </div>
      </div>
    </div>
  );
}

// --- Budget Table ---

function BudgetTable() {
  const { data: budgets, isLoading, error } = useBudgets();
  const deleteBudget = useDeleteBudget();
  const deleteConfirm = useConfirmDialog();

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-destructive">Failed to load budgets: {error.message}</p>;
  }

  if (!budgets || budgets.length === 0) {
    return <p className="text-sm text-muted-foreground">No budget limits configured.</p>;
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Scope</TableHead>
            <TableHead>Period</TableHead>
            <TableHead>Limit</TableHead>
            <TableHead>Spent</TableHead>
            <TableHead>Usage</TableHead>
            <TableHead>Action</TableHead>
            <TableHead className="w-[100px]">Controls</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {budgets.map((b: BudgetSummaryItem) => (
            <TableRow key={b.id}>
              <TableCell className="text-sm">
                <Badge variant="outline">{b.scope}</Badge>
                {b.scope_id && <span className="ml-1 text-xs text-muted-foreground">#{b.scope_id}</span>}
              </TableCell>
              <TableCell className="text-sm">{b.period}</TableCell>
              <TableCell className="text-sm font-mono">${b.limit_usd.toFixed(2)}</TableCell>
              <TableCell className="text-sm font-mono">${b.spent_usd.toFixed(2)}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <div className="h-2 w-20 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        b.percent_used >= 100
                          ? "bg-red-500"
                          : b.percent_used >= 80
                            ? "bg-amber-500"
                            : "bg-green-500"
                      }`}
                      style={{ width: `${Math.min(b.percent_used, 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground">{b.percent_used.toFixed(0)}%</span>
                </div>
              </TableCell>
              <TableCell>
                <Badge variant={b.action === "pause" ? "destructive" : "secondary"}>
                  {b.action}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                    disabled={deleteBudget.isPending}
                    onClick={() => deleteConfirm.requestConfirm(String(b.id))}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Budget Limit"
        description="This will permanently remove this budget limit. This action cannot be undone."
        isPending={deleteBudget.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            deleteBudget.mutate(Number(deleteConfirm.targetId), {
              onSuccess: () => deleteConfirm.reset(),
            });
          }
        }}
      />
    </>
  );
}

// --- Create Budget Dialog ---

function CreateBudgetDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateBudget();
  const [scope, setScope] = useState("global");
  const [scopeId, setScopeId] = useState("");
  const [period, setPeriod] = useState("monthly");
  const [limitUsd, setLimitUsd] = useState("");
  const [action, setAction] = useState("warn");
  const [formError, setFormError] = useState("");

  function reset() {
    setScope("global");
    setScopeId("");
    setPeriod("monthly");
    setLimitUsd("");
    setAction("warn");
    setFormError("");
    create.reset();
  }

  function handleClose(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  async function handleSave() {
    const limit = parseFloat(limitUsd);
    if (isNaN(limit) || limit <= 0) {
      setFormError("Limit must be a positive number");
      return;
    }
    setFormError("");
    try {
      await create.mutateAsync({
        scope,
        scope_id: scope !== "global" && scopeId ? Number(scopeId) : null,
        period,
        limit_usd: limit,
        action,
      });
      handleClose(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create budget");
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Budget Limit</DialogTitle>
          <DialogDescription>
            Set a spending limit for a scope and period.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Scope</Label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Global</SelectItem>
                <SelectItem value="workspace">Workspace</SelectItem>
                <SelectItem value="project">Project</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {scope !== "global" && (
            <div className="space-y-2">
              <Label>{scope === "workspace" ? "Workspace ID" : "Project ID"}</Label>
              <Input
                type="number"
                placeholder="ID"
                value={scopeId}
                onChange={(e) => setScopeId(e.target.value)}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label>Period</Label>
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Limit (USD)</Label>
            <Input
              type="number"
              step="0.01"
              min="0.01"
              placeholder="10.00"
              value={limitUsd}
              onChange={(e) => setLimitUsd(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Action when exceeded</Label>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="warn">Warn (continue execution)</SelectItem>
                <SelectItem value="pause">Pause (block execution)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {formError && <p className="text-sm text-destructive">{formError}</p>}
        </div>

        <DialogFooter>
          <Button onClick={handleSave} disabled={create.isPending}>
            {create.isPending ? "Saving..." : "Create Limit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
