// Dialog that promotes a (selection of) chat messages into a new incident.
//
// Flow:
//   1. Opens in "extracting" state. Fires `extractIncidentFromChat` once with
//      the selected message ids — the backend runs the Haiku extractor and
//      returns pre-filled title/symptom/rootCause/resolution/tags.
//   2. Extractor failures (no keys, LLM timeout, parse error) return an empty
//      draft, which we happily render as a blank form — the user can still
//      save manually. Never a blocking error.
//   3. All fields stay editable while the extractor is running (fields update
//      in place when the draft arrives, unless the user has started typing).
//   4. Tags input offers typeahead suggestions sourced from
//      `fetchIncidentTags(projectId)` — distinct tag strings already used in
//      this project's incidents.
//   5. On save: POST /incidents with camelCase keys (apiFetch converts).
//
// The dialog is intentionally uncontrolled past mount — `open` drives the
// outer Dialog; the parent resets state by toggling the key/open cycle.

import { useState, useEffect, useRef, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, X } from "lucide-react";
import {
  extractIncidentFromChat,
  createIncident,
  fetchIncidentTags,
  type IncidentDraft,
  type IncidentResponse,
} from "@/lib/api";

export interface SaveAsIncidentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatId: string | null;
  // Numeric ids of selected chat messages. Empty = use full chat transcript.
  messageIds: number[];
  projectId: string | null;
  onCreated?: (incident: IncidentResponse) => void;
}

const EMPTY_DRAFT: IncidentDraft = {
  title: "",
  symptom: "",
  root_cause: "",
  resolution: "",
  tags: [],
};

export function SaveAsIncidentDialog({
  open,
  onOpenChange,
  chatId,
  messageIds,
  projectId,
  onCreated,
}: SaveAsIncidentDialogProps) {
  // Form state — seeded with EMPTY_DRAFT and patched in by the extractor
  // unless the user has already started typing into a field.
  const [title, setTitle] = useState("");
  const [symptom, setSymptom] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [resolution, setResolution] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");

  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  // Tracks whether the user has touched each field — once touched, the
  // late-arriving extractor draft must NOT clobber their typing.
  const touched = useRef({
    title: false,
    symptom: false,
    rootCause: false,
    resolution: false,
    tags: false,
  });

  // Reset all local state whenever the dialog opens — a new dialog session
  // should always start from a blank slate, not residue from a prior cancel.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setSymptom("");
    setRootCause("");
    setResolution("");
    setTags([]);
    setTagInput("");
    setSaveError(null);
    touched.current = {
      title: false,
      symptom: false,
      rootCause: false,
      resolution: false,
      tags: false,
    };
  }, [open]);

  // Kick off the extractor once per open. We snapshot chatId/messageIds into
  // the closure so changing the selection while the dialog is open doesn't
  // re-fire the extraction (it's a one-shot pre-fill).
  useEffect(() => {
    if (!open || !chatId) return;
    let cancelled = false;
    setExtracting(true);
    extractIncidentFromChat(chatId, { messageIds })
      .then((res) => {
        if (cancelled) return;
        const draft = res.draft ?? EMPTY_DRAFT;
        if (!touched.current.title) setTitle(draft.title ?? "");
        if (!touched.current.symptom) setSymptom(draft.symptom ?? "");
        if (!touched.current.rootCause) setRootCause(draft.root_cause ?? "");
        if (!touched.current.resolution) setResolution(draft.resolution ?? "");
        if (!touched.current.tags) setTags(draft.tags ?? []);
      })
      .catch(() => {
        // Backend already coerces extractor errors → empty draft (200), so a
        // network-level reject here is genuinely network/auth. Leave the form
        // blank and let the user fill it in manually.
      })
      .finally(() => {
        if (!cancelled) setExtracting(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chatId]);

  // Load typeahead tag list once per open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchIncidentTags(projectId ?? undefined)
      .then((res) => {
        if (!cancelled) setKnownTags(res.tags ?? []);
      })
      .catch(() => {
        if (!cancelled) setKnownTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  // Suggestions filter: case-insensitive contains match against the current
  // tag-input draft, excluding tags already picked. Capped at 8 to fit a
  // compact dropdown without scroll.
  const suggestions = useMemo(() => {
    const q = tagInput.trim().toLowerCase();
    if (!q) return [];
    return knownTags
      .filter((t) => !tags.includes(t) && t.toLowerCase().includes(q))
      .slice(0, 8);
  }, [tagInput, knownTags, tags]);

  function addTag(raw: string) {
    const t = raw.trim().toLowerCase();
    if (!t) return;
    if (tags.includes(t)) {
      setTagInput("");
      return;
    }
    touched.current.tags = true;
    setTags((prev) => [...prev, t]);
    setTagInput("");
  }

  function removeTag(t: string) {
    touched.current.tags = true;
    setTags((prev) => prev.filter((x) => x !== t));
  }

  async function handleSave() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setSaveError("Title is required.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const incident = await createIncident({
        title: trimmedTitle,
        symptom: symptom.trim() || null,
        rootCause: rootCause.trim() || null,
        resolution: resolution.trim() || null,
        tags: tags,
        projectId: projectId ? parseInt(projectId) : null,
        createdByChatId: chatId ? parseInt(chatId) : null,
      });
      onCreated?.(incident);
      onOpenChange(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save incident.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="save-as-incident-dialog">
        <DialogHeader>
          <DialogTitle>Save as incident</DialogTitle>
          <DialogDescription>
            {extracting
              ? "Extracting a draft from the selected messages — you can edit any field."
              : "Review the extracted fields, edit as needed, then save."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="incident-title" className="flex items-center gap-2">
              Title
              {extracting && (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" data-testid="incident-extract-spinner" />
              )}
            </Label>
            <Input
              id="incident-title"
              value={title}
              onChange={(e) => {
                touched.current.title = true;
                setTitle(e.target.value);
              }}
              placeholder="Short summary of the incident"
              data-testid="incident-title"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="incident-symptom">Symptom</Label>
            <Textarea
              id="incident-symptom"
              value={symptom}
              onChange={(e) => {
                touched.current.symptom = true;
                setSymptom(e.target.value);
              }}
              placeholder="What was observed?"
              rows={3}
              data-testid="incident-symptom"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="incident-root-cause">Root cause</Label>
            <Textarea
              id="incident-root-cause"
              value={rootCause}
              onChange={(e) => {
                touched.current.rootCause = true;
                setRootCause(e.target.value);
              }}
              placeholder="Underlying cause identified"
              rows={3}
              data-testid="incident-root-cause"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="incident-resolution">Resolution</Label>
            <Textarea
              id="incident-resolution"
              value={resolution}
              onChange={(e) => {
                touched.current.resolution = true;
                setResolution(e.target.value);
              }}
              placeholder="Fix applied or recommended"
              rows={3}
              data-testid="incident-resolution"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="incident-tags">Tags</Label>
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5">
              {tags.map((t) => (
                <Badge key={t} variant="secondary" className="h-6 gap-1 px-2">
                  {t}
                  <button
                    type="button"
                    aria-label={`Remove tag ${t}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => removeTag(t)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              <Input
                id="incident-tags"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    if (tagInput.trim()) addTag(tagInput);
                  } else if (e.key === "Backspace" && !tagInput && tags.length > 0) {
                    const last = tags[tags.length - 1];
                    if (last) removeTag(last);
                  }
                }}
                placeholder={tags.length === 0 ? "Add tags, press Enter" : ""}
                className="h-7 min-w-[8rem] flex-1 border-0 bg-transparent px-1 py-0 shadow-none focus-visible:ring-0"
                data-testid="incident-tag-input"
              />
            </div>
            {suggestions.length > 0 && (
              <div
                className="flex flex-wrap gap-1 pt-1"
                data-testid="incident-tag-suggestions"
              >
                {suggestions.map((s) => (
                  <button
                    type="button"
                    key={s}
                    onClick={() => addTag(s)}
                    className="rounded bg-muted px-2 py-0.5 text-xs hover:bg-accent"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          {saveError && (
            <p className="text-sm text-destructive" role="alert">
              {saveError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !title.trim()}
            data-testid="incident-save-button"
          >
            {saving ? "Saving..." : "Save incident"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
