import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useGeneratePlan,
  useMeta,
  useProjectAllowedKeys,
  useProjectConfig,
} from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Sparkles, Loader2 } from "lucide-react";
import {
  filterKeysByAllowList,
  filterModelsForKey,
} from "@/lib/provider-agents";

// --- Generate Plan Dialog ---

// Sentinel for "let the daemon pick a key by priority/inheritance" — Radix
// Select disallows empty string values, so we round-trip through this token
// and map it to `null` at submit time.
const AUTO_KEY = "__auto__";
// Same trick for model: "use project default / inherited".
const AUTO_MODEL = "__default__";

export function GeneratePlanDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"quick" | "deep">("quick");
  const [keyId, setKeyId] = useState<string>(AUTO_KEY);
  const [model, setModel] = useState<string>(AUTO_MODEL);
  const [formError, setFormError] = useState("");
  const navigate = useNavigate();

  const generatePlan = useGeneratePlan(projectId);

  // `/meta` gives us the active key catalogue + full model list. Both are
  // then narrowed to what the project actually permits via the resolver
  // endpoint and the per-key agent mapping. See filterKeysByAllowList /
  // filterModelsForKey in lib/provider-agents.
  const { data: meta } = useMeta();
  const { data: allowed } = useProjectAllowedKeys(projectId);
  const { data: projectConfig } = useProjectConfig(projectId);

  const activeKeys = useMemo(
    () => (meta?.keys ?? []).filter((k) => k.is_active),
    [meta?.keys],
  );
  const allowedKeys = useMemo(
    () => filterKeysByAllowList(activeKeys, allowed?.allowedKeyIds ?? null),
    [activeKeys, allowed?.allowedKeyIds],
  );

  const allModels = meta?.models ?? [];
  // When an explicit key is chosen, constrain the model list to that key's
  // agent (Claude Code key → Claude models only, Copilot key → GPT models).
  // "Auto" keeps the full catalogue because the daemon will pick the key.
  const selectedKeyId = keyId && keyId !== AUTO_KEY ? keyId : null;
  const modelsForKey = useMemo(
    () => filterModelsForKey(allModels, activeKeys, selectedKeyId),
    [allModels, activeKeys, selectedKeyId],
  );

  function resetForm() {
    setPrompt("");
    setMode("quick");
    setKeyId(AUTO_KEY);
    setModel(AUTO_MODEL);
    setFormError("");
  }

  // If the selected key disappears from the allow-list (e.g. the user just
  // tightened the project's whitelist in another tab), snap back to auto so
  // the form never submits an impossible pairing.
  useEffect(() => {
    if (
      keyId !== AUTO_KEY &&
      allowedKeys.length > 0 &&
      !allowedKeys.some((k) => String(k.id) === keyId)
    ) {
      setKeyId(AUTO_KEY);
    }
  }, [allowedKeys, keyId]);

  // If the chosen model is no longer valid under the current key, fall back
  // to the project's planningModel > default model > auto so the dropdown
  // never shows a stale label.
  useEffect(() => {
    if (model === AUTO_MODEL) return;
    if (modelsForKey.length === 0) return;
    if (modelsForKey.some((m) => m.id === model)) return;
    const preferred =
      typeof projectConfig?.planningModel === "string"
        ? projectConfig.planningModel
        : typeof projectConfig?.model === "string"
          ? projectConfig.model
          : null;
    const next =
      preferred && modelsForKey.some((m) => m.id === preferred)
        ? preferred
        : (modelsForKey[0]?.id ?? AUTO_MODEL);
    setModel(next);
  }, [model, modelsForKey, projectConfig]);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    const trimmed = prompt.trim();
    if (!trimmed) {
      setFormError("Describe what you want to build.");
      return;
    }

    try {
      const parsedKeyId =
        keyId && keyId !== AUTO_KEY ? parseInt(keyId, 10) : null;
      const res = await generatePlan.mutateAsync({
        prompt: trimmed,
        mode,
        aiProviderKeyId: parsedKeyId,
        model: model && model !== AUTO_MODEL ? model : null,
      });
      setOpen(false);
      navigate(`/tasks/${res.task_id}`);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to generate plan",
      );
    }
  }

  const allowLabel =
    allowed?.source === "project"
      ? "project whitelist"
      : allowed?.source === "workspace"
        ? "workspace whitelist"
        : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetForm();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Sparkles className="mr-1 h-4 w-4" />
          Generate Plan
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Generate Plan with AI</DialogTitle>
          <DialogDescription>
            Describe your project goals and AI will create milestones, slices,
            and tasks automatically.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleGenerate} className="space-y-5 pt-2">
          <div className="space-y-2">
            <Label htmlFor="gp-prompt" className="text-sm font-medium">
              What do you want to build? *
            </Label>
            <Textarea
              id="gp-prompt"
              placeholder="Describe your project, features, technical requirements..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              className="resize-y"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gp-mode" className="text-sm font-medium">
              Planning Mode
            </Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "quick" | "deep")}>
              <SelectTrigger id="gp-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="quick">Quick — concise plan</SelectItem>
                <SelectItem value="deep">Deep — thorough with risk, deps, verification</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="gp-key" className="text-sm font-medium">
                AI Key
              </Label>
              <Select value={keyId} onValueChange={setKeyId}>
                <SelectTrigger id="gp-key" className="w-full">
                  <SelectValue placeholder="Auto (by priority)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_KEY}>Auto (by priority)</SelectItem>
                  {allowedKeys.map((k) => (
                    <SelectItem key={k.id} value={String(k.id)}>
                      {k.name ?? `Key #${k.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {allowLabel && (
                <p className="text-xs text-muted-foreground">
                  Filtered by {allowLabel}.
                </p>
              )}
              {allowedKeys.length === 0 && (
                <p className="text-xs text-destructive">
                  No keys are permitted for this project. Update the allow-list
                  in project or workspace settings.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="gp-model" className="text-sm font-medium">
                Model
              </Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id="gp-model" className="w-full">
                  <SelectValue placeholder="Default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_MODEL}>Default</SelectItem>
                  {modelsForKey.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          <DialogFooter>
            <Button
              type="submit"
              disabled={generatePlan.isPending || allowedKeys.length === 0}
            >
              {generatePlan.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Sparkles className="mr-1 h-4 w-4" />
                  Generate
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
