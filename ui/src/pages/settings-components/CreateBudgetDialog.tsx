import { useState } from "react";
import { useCreateBudget } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// --- Create Budget Dialog ---

export function CreateBudgetDialog({
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
