// /incidents — list view (M25 / 04 / T02 page assembly).
//
// Composes the M22+ flat-primitive widgets prior tasks built in isolation
// for incidents (slice 04 of the library-surfaces milestone):
//
//   ┌──────────────────────────────────────────────────────────────────┐
//   │ <SectionHeader title="Incidents" subtitle="N incidents" />       │
//   │ <IncidentsTable rows … onSelect=navigate(/incidents/:id)         │
//   │                  onDelete=confirm-dialog />                       │
//   └──────────────────────────────────────────────────────────────────┘
//
// Adapter
// -------
// The wire-level `IncidentResponse` (see src/lib/api/incidents.ts) does
// not currently carry severity / source / opened_at / resolved_at — those
// columns are part of the row's narrower visual contract. We map at the
// page boundary so the row component stays decoupled from the API:
//
//   severity   ← derived from tags. If the incident carries one of the
//                tags `critical|high|medium|low`, that wins; otherwise
//                we default to `medium`. This keeps the column populated
//                without inventing a new server contract.
//   source     ← `chat` when `created_by_chat_id` is set, else null
//                (renders an em-dash). Today every incident is created
//                from a chat transcript, so most rows light up.
//   opened_at  ← `created_at`.
//   resolved_at← surfaces `updated_at` when the incident carries a
//                `resolved` tag (closed via the edit dialog), else null
//                (open incident → em-dash in the column).
//
// Mutations: the kebab → delete flow is wired here so the table component
// stays presentational. After a successful delete the react-query cache
// refresh re-fetches the list — no manual navigation needed.

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle } from "lucide-react";

import {
  useIncidents,
  useDeleteIncident,
} from "@/lib/hooks";
import type { IncidentResponse } from "@/lib/api/incidents";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/EmptyState";
import { SectionHeader } from "@/components/design";

import { IncidentsTable } from "@/pages/incidents-components/IncidentsTable";
import type {
  IncidentRowIncident,
  IncidentSeverity,
  IncidentSource,
} from "@/pages/incidents-components/IncidentRow";

const PAGE_SIZE = 50;

const SEVERITY_TAGS: ReadonlySet<IncidentSeverity> = new Set([
  "critical",
  "high",
  "medium",
  "low",
]);

/**
 * Pick a severity from the incident's tag list. Returns the first
 * recognised severity tag (case-insensitive); defaults to `"medium"` so
 * the column is never empty.
 */
function deriveSeverity(tags: ReadonlyArray<string> | null): IncidentSeverity {
  if (!tags || tags.length === 0) return "medium";
  for (const raw of tags) {
    const t = raw.toLowerCase();
    if (SEVERITY_TAGS.has(t as IncidentSeverity)) {
      return t as IncidentSeverity;
    }
  }
  return "medium";
}

/**
 * Treat a `resolved` tag as the closed-incident marker (incident edit
 * dialog promotes it). Returns the `updated_at` timestamp when present so
 * the column renders the relative-time the operator marked it closed.
 */
function deriveResolvedAt(incident: IncidentResponse): string | null {
  if (!incident.tags) return null;
  const isResolved = incident.tags.some((t) => t.toLowerCase() === "resolved");
  return isResolved ? incident.updated_at : null;
}

/**
 * Adapter from the wire row to the row's narrower prop shape. Centralised
 * here so the row component stays presentation-only.
 */
function toRow(incident: IncidentResponse): IncidentRowIncident {
  const source: IncidentSource | null = incident.created_by_chat_id
    ? "chat"
    : null;
  return {
    id: String(incident.id),
    title: incident.title,
    severity: deriveSeverity(incident.tags),
    source,
    opened_at: incident.created_at,
    resolved_at: deriveResolvedAt(incident),
  };
}

/**
 * `/incidents` landing page. Renders the page header + paginated table —
 * mutations and the delete-confirm dialog are wired here so the table
 * component stays presentational.
 */
export default function IncidentsPage() {
  const navigate = useNavigate();
  // URL-backed pagination (audit-round-3 fix). The previous
  // `useState(1)` shape reset to page 1 on every reload and dropped
  // the deep-link contract that `/tasks` and `/schedules` already
  // honour. Reading from `useSearchParams` lets refresh / back-button
  // / bookmarks all preserve the active page.
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const setPage = (next: number | ((prev: number) => number)) => {
    const nextPage = typeof next === "function" ? next(page) : next;
    setSearchParams((prev) => {
      const sp = new URLSearchParams(prev);
      if (nextPage === 1) sp.delete("page");
      else sp.set("page", String(nextPage));
      return sp;
    });
  };
  const { data, isLoading, error } = useIncidents(page, PAGE_SIZE);
  const deleteMutation = useDeleteIncident();
  const deleteConfirm = useConfirmDialog();

  const rows = useMemo<IncidentRowIncident[]>(
    () => (data?.items ?? []).map(toRow),
    [data?.items],
  );

  const total = data?.total ?? 0;
  const showingFrom = total === 0 ? 0 : Math.min((page - 1) * PAGE_SIZE + 1, total);
  const showingTo = Math.min(page * PAGE_SIZE, total);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const subtitle =
    isLoading || error
      ? undefined
      : `${total} ${total === 1 ? "incident" : "incidents"}`;

  return (
    <div data-testid="incidents-page" className="max-w-7xl">
      <SectionHeader title="Incidents" subtitle={subtitle} />

      {isLoading && (
        <div className="space-y-2" data-testid="incidents-loading">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {error && (
        <p className="text-destructive" data-testid="incidents-error" role="alert">
          Failed to load incidents: {(error as Error).message}
        </p>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <EmptyState
          icon={AlertTriangle}
          title="No incidents yet"
          description="When you save a post-mortem from a chat, it lands here so the next debugging session can find it."
          data-testid="incidents-empty-state"
        />
      )}

      {!isLoading && !error && rows.length > 0 && (
        <>
          <IncidentsTable
            rows={rows}
            onSelect={(id) => navigate(`/incidents/${id}`)}
            onDelete={(id) => deleteConfirm.requestConfirm(id)}
          />

          {/* Pagination */}
          <div className="mt-4 flex items-center justify-between">
            <p
              className="text-sm text-muted-foreground"
              data-testid="incidents-pagination-summary"
            >
              Showing {showingFrom}–{showingTo} of {total}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                data-testid="incidents-page-prev"
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                data-testid="incidents-page-next"
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete incident?"
        description="This permanently removes the incident record. This action cannot be undone."
        confirmLabel="Delete"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            deleteMutation.mutate(deleteConfirm.targetId, {
              onSuccess: () => deleteConfirm.reset(),
            });
          }
        }}
      />
    </div>
  );
}
