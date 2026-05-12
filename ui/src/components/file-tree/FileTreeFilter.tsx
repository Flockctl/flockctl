import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

/**
 * Default debounce window in ms. Tuned to feel snappy while still
 * collapsing a multi-character keystroke burst into a single
 * `searchTerm` update — react-arborist re-walks the open-state map on
 * every change so we want at least a short coalescing window.
 *
 * Exported so the test can pass a deterministic value (5ms) and avoid a
 * 150ms wall-clock wait on every assertion.
 */
export const DEFAULT_FILTER_DEBOUNCE_MS = 150;

export interface FileTreeFilterProps {
  /**
   * Fires with the debounced filter value. The empty string means the
   * filter is cleared and the tree should restore its normal shape.
   */
  onChange: (term: string) => void;
  /**
   * Override the debounce window. Production callers should leave the
   * default; the test path passes a small value to keep the assertion
   * synchronous-ish.
   */
  debounceMs?: number;
  /** Placeholder text — externalised so a future i18n pass can hook in. */
  placeholder?: string;
  className?: string;
}

/**
 * Tiny search input rendered above {@link FileTree}. Owns the raw
 * keystroke buffer locally and emits the debounced value to its parent
 * via {@link FileTreeFilterProps.onChange}.
 *
 * Why a separate component? Two reasons:
 *
 *   1. The debounced value drives react-arborist's `searchTerm`
 *      directly — coalescing it here means the parent's render and the
 *      Tree's internal re-walk only fire once per typing burst.
 *   2. Testability — exercising the debounce in isolation keeps the
 *      file-tree.test.tsx mock untouched and lets us assert the
 *      coalescing behaviour against a fake-timers contract without
 *      threading react-query / react-arborist through the test.
 */
export function FileTreeFilter({
  onChange,
  debounceMs = DEFAULT_FILTER_DEBOUNCE_MS,
  placeholder = "Filter files…",
  className,
}: FileTreeFilterProps) {
  // `raw` is the input value the user sees. We intentionally keep it
  // uncontrolled by the parent: pulling the controlled value through
  // the debounced state would either (a) make the input feel laggy
  // because every keystroke would race the parent re-render, or (b)
  // require the parent to track two separate strings. Local state +
  // debounced emission is the simpler contract.
  const [raw, setRaw] = useState("");

  // Debounce → emit. The cleanup on `raw` change is what makes this a
  // debounce (not a throttle): every keystroke cancels the pending
  // emission and starts a fresh timer, so only the last keystroke in a
  // burst actually calls `onChange`.
  //
  // We deliberately do NOT include `onChange` in the dep array as a
  // setter — instead we call it inside the timer. Re-creating the
  // timer when the parent passes a fresh callback identity would
  // restart the debounce, defeating the coalescing contract. The
  // parent is expected to pass a stable reference (e.g. `useState`'s
  // setter); if it doesn't, the lint disable is the explicit signal
  // that we're choosing closure-captured semantics on purpose.
  useEffect(() => {
    const t = setTimeout(() => onChange(raw), debounceMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, debounceMs]);

  return (
    <div
      data-testid="file-tree-filter"
      className={cn(
        "relative shrink-0 border-b bg-background p-2",
        className,
      )}
    >
      <Search
        className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        type="text"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder={placeholder}
        aria-label="Filter files"
        data-testid="file-tree-filter-input"
        className="h-7 pl-7 pr-7 text-xs"
      />
      {raw.length > 0 && (
        <button
          type="button"
          aria-label="Clear filter"
          data-testid="file-tree-filter-clear"
          onClick={() => setRaw("")}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
