import { useMeta, useUpdateMetaDefaults } from "@/lib/hooks";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// --- Defaults Panel ---

const NONE_VALUE = "__none__";

export function DefaultsPanel() {
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
