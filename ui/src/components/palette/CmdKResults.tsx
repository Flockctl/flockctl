import { useEffect, useRef, type ReactElement } from "react";
import type { CmdkRow } from "@/components/palette/cmdk-data";

/**
 * Renders the grouped, highlightable result list for `<CmdK />`.
 * Pure presentational — keyboard handling lives on the parent's
 * `<input>`.
 *
 * Group headers are emitted whenever the `kind` (or, for entity
 * rows, the `group`) changes between siblings. The grouping
 * matches the order the data arrives in (`NAV_ROWS` + entities
 * by category) so the headers stay visually anchored regardless
 * of the ranking.
 *
 * The highlighted row scrolls into view on every change to keep
 * keyboard navigation working past the visible window.
 */

export function CmdKResults({
  rows,
  highlight,
  onActivate,
  onHover,
}: {
  rows: CmdkRow[];
  highlight: number;
  onActivate: (row: CmdkRow) => void;
  onHover: (idx: number) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-cmdk-idx='${highlight}']`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  if (rows.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-sm text-muted-foreground" data-testid="cmdk-empty">
        No matches.
      </div>
    );
  }

  // Walk the list and emit a group header whenever the boundary
  // changes. Keep the indexing flat — `data-cmdk-idx` mirrors the
  // input's row index so keyboard nav works without separate
  // bookkeeping for headers.
  const items: ReactElement[] = [];
  let lastGroup = "";
  rows.forEach((row, idx) => {
    const groupLabel = row.kind === "nav" ? "Go to" : row.group;
    if (groupLabel !== lastGroup) {
      items.push(
        <div
          key={`hdr:${groupLabel}`}
          className="px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {groupLabel}
        </div>,
      );
      lastGroup = groupLabel;
    }
    const Icon = row.icon;
    const active = idx === highlight;
    items.push(
      <button
        key={row.id}
        type="button"
        data-cmdk-idx={idx}
        onClick={() => onActivate(row)}
        onMouseMove={() => onHover(idx)}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
          active
            ? "bg-accent text-accent-foreground"
            : "hover:bg-accent/40"
        }`}
        role="option"
        aria-selected={active}
      >
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        {row.hint && (
          <span className="shrink-0 truncate text-xs text-muted-foreground">{row.hint}</span>
        )}
      </button>,
    );
  });

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Command palette results"
      className="max-h-[420px] overflow-y-auto py-1"
      data-testid="cmdk-results"
    >
      {items}
    </div>
  );
}

export default CmdKResults;
