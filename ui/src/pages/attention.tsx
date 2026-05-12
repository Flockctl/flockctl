import * as React from "react";
import { Inbox } from "lucide-react";

import { SectionHeader } from "@/components/design";
import { AttentionSection } from "./attention-components/AttentionSection";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAttentionInbox,
  type AttentionInboxItem,
} from "@/lib/hooks/use-attention-inbox";

/**
 * Attention page — redesigned working surface (slice
 * `24-ui-redesign-working-surfaces/04-attention`, T03).
 *
 * Page composition:
 *
 *   <SectionHeader title="Attention" subtitle="{n} items" />
 *   ── if any ──
 *     <AttentionSection priority="critical" />   (failed tasks)
 *     <AttentionSection priority="normal"   />   (agent questions, mission proposals)
 *   ── else ──
 *     <EmptyState>All caught up · 0 items waiting</EmptyState>
 *
 * Data
 * ----
 * The list is the merged feed produced by `useAttentionInbox()` — three
 * client-side sources (`useAgentQuestionsAll` + `useMissionProposalsAll` +
 * `useFailedTasks24h`) sorted by priority then `created_at` DESC. Each
 * source owns its own React Query cache; partial errors land in
 * `partialErrors[]` so a single broken source does not blank the page.
 *
 * Empty buckets render NOTHING — `<AttentionSection>` short-circuits to
 * `null` when `items.length === 0`. A page with only critical items
 * therefore shows just the Critical block + page header (no Normal stub).
 *
 * Dismiss
 * -------
 * The slice's read-only success criterion is "accept/dismiss hooks call
 * existing endpoints". For sources without a dedicated dismiss endpoint
 * (mission proposals: deferred per parent-slice audit findings; failed
 * tasks: dismissal is a UX-only "hide" with no server side effect today)
 * the page wires a no-op resolver — the row hides itself once the promise
 * resolves, matching the AttentionRow contract pinned by
 * `attention-row.test.tsx::dismiss happy path`. When the underlying
 * source endpoints land we replace the stub here without touching the
 * row/section components.
 */
export default function AttentionPage(): React.JSX.Element {
  const { items, isLoading, partialErrors } = useAttentionInbox();

  // Bucketing is cheap (one O(n) pass per priority). We memoize so the
  // section components are referentially stable when the merge result is
  // — saves a re-render on every parent state change unrelated to items.
  const critical = React.useMemo(
    () => items.filter((it) => it.priority === "critical"),
    [items],
  );
  const normal = React.useMemo(
    () => items.filter((it) => it.priority === "normal"),
    [items],
  );

  const total = items.length;
  const subtitle = isLoading
    ? "Loading…"
    : total === 0
      ? "Nothing waiting on you."
      : `${total} item${total === 1 ? "" : "s"}`;

  // Stable handler — the row stores it in a closure so a fresh reference
  // on every render would needlessly retrigger the row's optimistic-hide
  // useState transition cadence under React StrictMode.
  const handleDismiss = React.useCallback(
    async (_item: AttentionInboxItem): Promise<void> => {
      // No-op for now (see header comment). Returning a resolved promise
      // satisfies the AttentionRow contract: row hides itself once this
      // resolves, errors are surfaced inline if it rejects.
      return Promise.resolve();
    },
    [],
  );

  return (
    <div data-testid="attention-page" className="max-w-7xl">
      <SectionHeader
        title="Attention"
        subtitle={subtitle}
        data-testid="attention-page-header"
      />

      {partialErrors.length > 0 && (
        <p
          role="alert"
          data-testid="attention-partial-error"
          className="mb-4 text-sm text-destructive"
        >
          Some sources failed to load. The list shows what is available.
        </p>
      )}

      {isLoading && (
        <div className="space-y-3" data-testid="attention-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {!isLoading && total === 0 && (
        <EmptyState
          icon={Inbox}
          title="All caught up · 0 items waiting"
          description="Agent questions, mission proposals, and failed tasks will appear here."
          data-testid="attention-empty-state"
        />
      )}

      {!isLoading && total > 0 && (
        <>
          <AttentionSection
            priority="critical"
            items={critical}
            onDismiss={handleDismiss}
          />
          <AttentionSection
            priority="normal"
            items={normal}
            onDismiss={handleDismiss}
          />
        </>
      )}
    </div>
  );
}
