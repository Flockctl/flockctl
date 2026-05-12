import * as React from "react";

import { FlatCard, SectionHeader } from "@/components/design";
import { AttentionRow } from "./AttentionRow";
import type {
  AttentionInboxItem,
  AttentionInboxPriority,
} from "@/lib/hooks/use-attention-inbox";

/**
 * AttentionSection — one priority-bucketed slab of inbox rows.
 *
 * Visual contract (M24/04 slice spec):
 *   - `<SectionHeader size="section">` renders a leading colour swatch
 *     (rose for critical, indigo for normal — same tone family used in the
 *     prototype + `RecentActivity`), the bucket title, an item-count
 *     subtitle, and a hairline that fills the remaining row.
 *   - The rows themselves are wrapped in a `<FlatCard>` so the bucket
 *     reads as a single elevated surface. Rows are `<li>` elements in a
 *     plain `<ul>` to keep the DOM semantically a list.
 *
 * No empty-handling here: when `items.length === 0` we render nothing.
 * The page (`attention.tsx`) decides what to do with empty buckets — most
 * of the time that's "skip the section entirely"; the prototype never
 * shows an empty Critical / Normal block above content.
 */

const PRIORITY_VARIANTS: Record<
  AttentionInboxPriority,
  { title: string; swatch: string }
> = {
  critical: { title: "Critical", swatch: "bg-rose-500" },
  normal: { title: "Normal", swatch: "bg-indigo-500" },
};

export interface AttentionSectionProps {
  /** Bucket — drives the heading text and the leading swatch colour. */
  priority: AttentionInboxPriority;
  /**
   * Pre-filtered list of items belonging to this bucket. Caller is
   * responsible for the priority filter so the merge invariants stay in
   * the hook (`useAttentionInbox`), not duplicated here.
   */
  items: AttentionInboxItem[];
  /** Forwarded to each row — see `AttentionRow.onDismiss`. */
  onDismiss: (item: AttentionInboxItem) => Promise<void>;
  /** Test hook for relative-time formatting; forwarded to each row. */
  now?: number;
}

export function AttentionSection({
  priority,
  items,
  onDismiss,
  now,
}: AttentionSectionProps): React.JSX.Element | null {
  if (items.length === 0) return null;

  const variant = PRIORITY_VARIANTS[priority];
  const subtitle = `${items.length} item${items.length === 1 ? "" : "s"}`;

  return (
    <section
      data-testid={`attention-section-${priority}`}
      data-priority={priority}
      className="mb-4"
    >
      <SectionHeader
        size="section"
        title={variant.title}
        subtitle={subtitle}
        leadingSwatch={variant.swatch}
        data-testid={`attention-section-header-${priority}`}
      />
      <FlatCard>
        <ul
          data-testid={`attention-section-list-${priority}`}
          className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800"
        >
          {items.map((item) => (
            <AttentionRow
              key={item.key}
              item={item}
              onDismiss={onDismiss}
              now={now}
            />
          ))}
        </ul>
      </FlatCard>
    </section>
  );
}

export default AttentionSection;
