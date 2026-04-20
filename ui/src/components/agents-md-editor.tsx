import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Save, ChevronDown, ChevronRight } from "lucide-react";

export interface AgentsMdEditorProps {
  title?: string;
  description?: string;
  source: string | undefined;
  effective: string | undefined;
  isLoading?: boolean;
  isSaving?: boolean;
  onSave: (content: string) => Promise<void> | void;
}

/**
 * Editor for AGENTS.md (canonical) with a collapsible read-only preview of
 * the merged "effective" file that agents actually read. Source lives in
 * <root>/.flockctl/AGENTS.md; effective is the materialized <root>/AGENTS.md.
 */
export function AgentsMdEditor({
  title = "Agent documentation",
  description = "Editable .flockctl/AGENTS.md. CLAUDE.md is auto-symlinked to the merged AGENTS.md at the directory root.",
  source,
  effective,
  isLoading,
  isSaving,
  onSave,
}: AgentsMdEditorProps) {
  const [draft, setDraft] = useState("");
  const [showEffective, setShowEffective] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(source ?? "");
  }, [source]);

  const dirty = draft !== (source ?? "");

  async function handleSave() {
    setError(null);
    try {
      await onSave(draft);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{title}</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">{description}</p>
          </div>
          <div className="flex items-center gap-2">
            {savedFlash && (
              <Badge variant="outline" className="border-green-500 text-green-600">
                Saved
              </Badge>
            )}
            {dirty && !savedFlash && (
              <Badge variant="outline" className="border-amber-500 text-amber-600">
                Unsaved
              </Badge>
            )}
            <Button
              onClick={handleSave}
              disabled={isSaving || !dirty}
              size="sm"
            >
              <Save className="mr-1.5 h-4 w-4" />
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={14}
            placeholder="# Project conventions, agent rules, context…"
            className="font-mono text-sm"
            spellCheck={false}
          />
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <button
          type="button"
          onClick={() => setShowEffective((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {showEffective ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          Effective AGENTS.md (what agents read)
          {dirty && (
            <span className="ml-1 text-amber-600">
              — preview is stale until you save
            </span>
          )}
        </button>
        {showEffective && (
          <pre className="text-xs font-mono bg-muted/50 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap max-h-80 overflow-y-auto">
            {effective?.trim() ? effective : <span className="text-muted-foreground italic">(empty)</span>}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}
