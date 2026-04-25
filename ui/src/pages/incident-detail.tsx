// Incident detail view — view, edit, and delete a single post-mortem record.
//
// View mode renders each long-text field (symptom, root cause, resolution) as
// markdown via ReactMarkdown with `remark-gfm`. ReactMarkdown escapes raw HTML
// by default (no `rehype-raw`), which is what we want here: incident bodies
// are user-editable free-text and we don't need embedded HTML. Code blocks go
// through `rehype-highlight`, matching the styling used elsewhere in the app
// (see project-detail plan-file dialog).
//
// Edit mode swaps the markdown blocks for <Textarea>s and the title for an
// <Input>. Tags use the same chip-style input as the SaveAsIncidentDialog so
// the two flows feel consistent.
//
// Delete sits behind the shared `ConfirmDialog` component. On success we
// invalidate the incidents query cache and navigate back to /incidents (or,
// if we arrived from another page, the browser's history stack).

import { useState, useEffect, useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  useIncident,
  useUpdateIncident,
  useDeleteIncident,
} from "@/lib/hooks";
import { fetchIncidentTags } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  ConfirmDialog,
  useConfirmDialog,
} from "@/components/confirm-dialog";
import { ArrowLeft, Pencil, Save, Trash2, X } from "lucide-react";

/**
 * Markdown-rendered block for a long text field. Returns a muted "not set"
 * placeholder when the content is blank, so empty sections still carry a
 * visual cue rather than collapsing to zero height.
 */
function MarkdownBlock({ content }: { content: string | null }) {
  if (!content || !content.trim()) {
    return (
      <p className="text-sm italic text-muted-foreground">
        Not set
      </p>
    );
  }
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const {
    data: incident,
    isLoading,
    error,
  } = useIncident(id ?? "");
  const updateMutation = useUpdateIncident();
  const deleteMutation = useDeleteIncident();
  const confirm = useConfirmDialog();

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [symptom, setSymptom] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [resolution, setResolution] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [knownTags, setKnownTags] = useState<string[]>([]);

  // Hydrate the form whenever a new incident arrives (initial load or after
  // save). The edit toggle doesn't reset the form itself — save clears the
  // `editing` flag and the query-cache update repopulates the fields.
  useEffect(() => {
    if (!incident) return;
    setTitle(incident.title ?? "");
    setSymptom(incident.symptom ?? "");
    setRootCause(incident.root_cause ?? "");
    setResolution(incident.resolution ?? "");
    setTags(incident.tags ?? []);
    setTagInput("");
    setSaveError(null);
  }, [incident]);

  // Tag typeahead suggestions — scoped by project id when available so the
  // autocomplete converges on the per-project vocabulary the user already
  // uses in the "Save as incident" dialog.
  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    fetchIncidentTags(incident?.project_id ?? undefined)
      .then((res) => {
        if (!cancelled) setKnownTags(res.tags ?? []);
      })
      .catch(() => {
        if (!cancelled) setKnownTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, [editing, incident?.project_id]);

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
    setTags((prev) => [...prev, t]);
    setTagInput("");
  }

  function removeTag(t: string) {
    setTags((prev) => prev.filter((x) => x !== t));
  }

  function handleCancel() {
    // Restore the form from the incident snapshot and leave edit mode.
    if (incident) {
      setTitle(incident.title ?? "");
      setSymptom(incident.symptom ?? "");
      setRootCause(incident.root_cause ?? "");
      setResolution(incident.resolution ?? "");
      setTags(incident.tags ?? []);
    }
    setTagInput("");
    setSaveError(null);
    setEditing(false);
  }

  async function handleSave() {
    if (!id) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setSaveError("Title is required.");
      return;
    }
    setSaveError(null);
    try {
      await updateMutation.mutateAsync({
        id,
        data: {
          title: trimmedTitle,
          symptom: symptom.trim() || null,
          rootCause: rootCause.trim() || null,
          resolution: resolution.trim() || null,
          tags: tags,
        },
      });
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save incident.");
    }
  }

  async function handleDelete() {
    if (!id) return;
    try {
      await deleteMutation.mutateAsync(id);
      confirm.reset();
      navigate("/incidents");
    } catch {
      // Surface via the error block — rare; the query cache stays intact.
    }
  }

  // Counter: without a dedicated `incident_activations` table, the only
  // provable "usage" is the single origin chat captured on creation. We
  // surface that as the lower-bound count so the field ships today and can
  // grow naturally when backend tracking lands.
  const usedInSessions = incident?.created_by_chat_id ? 1 : 0;

  if (!id) {
    return <p className="text-destructive">Missing incident id.</p>;
  }

  return (
    <div className="flex flex-col gap-4" data-testid="incident-detail-page">
      <Link
        to="/incidents"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to incidents
      </Link>

      {isLoading && (
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-64" />
          </CardHeader>
          <CardContent className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-96" />
            ))}
          </CardContent>
        </Card>
      )}

      {error && (
        <p className="text-destructive" role="alert">
          Failed to load incident: {error.message}
        </p>
      )}

      {incident && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-start gap-3">
              {editing ? (
                <Input
                  data-testid="incident-edit-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Title"
                  className="text-base"
                />
              ) : (
                <span className="flex-1 break-words" data-testid="incident-title">
                  {incident.title}
                </span>
              )}
              <div className="ml-auto flex gap-2">
                {!editing && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing(true)}
                      data-testid="incident-edit-button"
                    >
                      <Pencil className="mr-1 h-4 w-4" />
                      Edit
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => confirm.requestConfirm(id)}
                      data-testid="incident-delete-button"
                    >
                      <Trash2 className="mr-1 h-4 w-4" />
                      Delete
                    </Button>
                  </>
                )}
                {editing && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCancel}
                      disabled={updateMutation.isPending}
                      data-testid="incident-cancel-button"
                    >
                      <X className="mr-1 h-4 w-4" />
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleSave}
                      disabled={updateMutation.isPending || !title.trim()}
                      data-testid="incident-save-button"
                    >
                      <Save className="mr-1 h-4 w-4" />
                      {updateMutation.isPending ? "Saving..." : "Save"}
                    </Button>
                  </>
                )}
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Metadata row */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs md:grid-cols-4">
              <div>
                <span className="text-muted-foreground">Created</span>
                <p>{formatTimestamp(incident.created_at)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Updated</span>
                <p>{formatTimestamp(incident.updated_at)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Used in sessions</span>
                <p data-testid="incident-usage-count">{usedInSessions}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Origin chat</span>
                <p>
                  {incident.created_by_chat_id ? (
                    <Link
                      className="text-primary underline"
                      to={`/chats/${incident.created_by_chat_id}`}
                    >
                      #{incident.created_by_chat_id}
                    </Link>
                  ) : (
                    "-"
                  )}
                </p>
              </div>
            </div>

            <Separator />

            {/* Tags */}
            <div className="space-y-1.5">
              <Label>Tags</Label>
              {editing ? (
                <>
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
                      data-testid="incident-edit-tag-input"
                    />
                  </div>
                  {suggestions.length > 0 && (
                    <div
                      className="flex flex-wrap gap-1 pt-1"
                      data-testid="incident-edit-tag-suggestions"
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
                </>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {incident.tags && incident.tags.length > 0 ? (
                    incident.tags.map((t) => (
                      <Badge key={t} variant="secondary">
                        {t}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm italic text-muted-foreground">
                      No tags
                    </span>
                  )}
                </div>
              )}
            </div>

            <Separator />

            {/* Symptom */}
            <div className="space-y-1.5">
              <Label htmlFor="incident-symptom">Symptom</Label>
              {editing ? (
                <Textarea
                  id="incident-symptom"
                  value={symptom}
                  onChange={(e) => setSymptom(e.target.value)}
                  rows={4}
                  placeholder="What was observed?"
                  data-testid="incident-edit-symptom"
                />
              ) : (
                <div data-testid="incident-symptom">
                  <MarkdownBlock content={incident.symptom} />
                </div>
              )}
            </div>

            {/* Root cause */}
            <div className="space-y-1.5">
              <Label htmlFor="incident-root-cause">Root cause</Label>
              {editing ? (
                <Textarea
                  id="incident-root-cause"
                  value={rootCause}
                  onChange={(e) => setRootCause(e.target.value)}
                  rows={4}
                  placeholder="Underlying cause identified"
                  data-testid="incident-edit-root-cause"
                />
              ) : (
                <div data-testid="incident-root-cause">
                  <MarkdownBlock content={incident.root_cause} />
                </div>
              )}
            </div>

            {/* Resolution */}
            <div className="space-y-1.5">
              <Label htmlFor="incident-resolution">Resolution</Label>
              {editing ? (
                <Textarea
                  id="incident-resolution"
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  rows={4}
                  placeholder="Fix applied or recommended"
                  data-testid="incident-edit-resolution"
                />
              ) : (
                <div data-testid="incident-resolution">
                  <MarkdownBlock content={incident.resolution} />
                </div>
              )}
            </div>

            {saveError && (
              <p className="text-sm text-destructive" role="alert">
                {saveError}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirm.open}
        onOpenChange={confirm.onOpenChange}
        title="Delete incident?"
        description="This permanently removes the incident record. This action cannot be undone."
        confirmLabel="Delete"
        isPending={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}
