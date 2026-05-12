import * as React from "react";
import { Link } from "react-router-dom";
import { AlertCircle, AlertTriangle, MessageSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  AttentionInboxItem,
  AttentionInboxSource,
} from "@/lib/hooks/use-attention-inbox";

/**
 * AttentionRow — single inbox row in the redesigned (M24/04) attention
 * surface.
 *
 * Layout matches `.flockctl/plan/ui-prototype.html` lines 957–999: a flat
 * row (no card wrapper — sections own the divider) with
 *
 *   [ source-coloured icon avatar ] [ title              ] [ Open ↗ Dismiss ]
 *                                   [ 1-line context     ] [   2m           ]
 *
 * The row renders bare; `AttentionSection` provides the surrounding
 * `<FlatCard>` and divider treatment so a section can host many rows
 * without each row paying for its own border.
 *
 * Source → tone mapping (table-driven)
 * ------------------------------------
 *   failed_task       → rose    AlertCircle      (priority: critical)
 *   agent_question    → emerald MessageSquare    (priority: normal)
 *   mission_proposal  → amber   AlertTriangle    (priority: normal)
 *
 * Adding a new source means appending one entry to {@link SOURCE_VARIANTS}
 * — no changes to the row rendering itself. The mapping is total: every
 * `AttentionInboxSource` value must have a variant or TS errors at build.
 *
 * Actions: Open + Dismiss
 * -----------------------
 *   - **Open** is a `<Link>` to `item.href`. Always rendered. The row
 *     itself is NOT click-to-open — we keep the surface "buttons in a
 *     list" so a click on Dismiss never accidentally navigates.
 *   - **Dismiss** is an `onClick` that calls the parent's `onDismiss`
 *     handler. The row keeps mount on failure (parent decides whether to
 *     hide; we surface the error inline as a toast-like banner so the
 *     user sees *something happened* even if the parent's toast region
 *     is offscreen).
 *
 * Failure behaviour pinned by `attention-row.test.tsx::dismiss mutation
 * failure: row stays + error toast`. The row never optimistically hides
 * itself — it waits for the promise from `onDismiss` to resolve before
 * setting `hidden=true`. If the promise rejects the row stays mounted
 * and the inline error pill renders the rejection message.
 *
 * Truncation
 * ----------
 * Title and context use Tailwind `truncate` (`overflow-hidden
 * whitespace-nowrap text-ellipsis`). Pinned by
 * `attention-row.test.tsx::long title 200 chars truncates` — a 200-char
 * title is rendered verbatim in the DOM (no JS truncation, full text is
 * retained for screen readers / copy-paste) but visually clipped by CSS.
 */

interface SourceVariant {
  /** Tailwind background class for the avatar (15% tint, matches prototype). */
  bgClass: string;
  /** Tailwind text class painted onto the icon. */
  iconClass: string;
  /** Lucide icon for the avatar. */
  Icon: React.ComponentType<{ className?: string }>;
  /** Stable label for `data-icon` / aria. */
  label: string;
}

const SOURCE_VARIANTS: Record<AttentionInboxSource, SourceVariant> = {
  failed_task: {
    bgClass: "bg-rose-500/15",
    iconClass: "text-rose-500",
    Icon: AlertCircle,
    label: "failed",
  },
  agent_question: {
    bgClass: "bg-emerald-500/15",
    iconClass: "text-emerald-500",
    Icon: MessageSquare,
    label: "question",
  },
  mission_proposal: {
    bgClass: "bg-amber-500/15",
    iconClass: "text-amber-500",
    Icon: AlertTriangle,
    label: "proposal",
  },
};

export interface AttentionRowProps {
  /** Merged inbox item (from `useAttentionInbox`). */
  item: AttentionInboxItem;
  /**
   * Called when the user clicks Dismiss. Must return a Promise — the row
   * waits for it to resolve before hiding itself. A rejection keeps the
   * row mounted and surfaces the rejection message in an inline error
   * banner.
   */
  onDismiss: (item: AttentionInboxItem) => Promise<void>;
  /**
   * Optional `Date.now()` override so unit tests can pin the relative-time
   * formatter against `vi.setSystemTime`. Production callers should never
   * need this — `Date.now()` is the default.
   */
  now?: number;
}

export function AttentionRow({
  item,
  onDismiss,
  now,
}: AttentionRowProps): React.JSX.Element | null {
  const variant = SOURCE_VARIANTS[item.source];
  const { Icon } = variant;

  const [busy, setBusy] = React.useState(false);
  const [hidden, setHidden] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Optimistic hide is opt-in — the row only collapses once the dismiss
  // promise resolves. This keeps the inbox honest about server state and
  // prevents a row from "disappearing then reappearing" if the request
  // fails after a network blip.
  if (hidden) return null;

  async function handleDismiss() {
    setBusy(true);
    setError(null);
    try {
      await onDismiss(item);
      setHidden(true);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to dismiss item";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      data-testid={`attention-row-${item.key}`}
      data-source={item.source}
      data-priority={item.priority}
      className="flex items-start gap-3 px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
    >
      <span
        data-testid={`attention-icon-${item.key}`}
        data-icon={variant.label}
        aria-hidden="true"
        className={cn(
          "h-9 w-9 shrink-0 rounded-lg grid place-items-center",
          variant.bgClass,
        )}
      >
        <Icon className={cn("h-4 w-4", variant.iconClass)} />
      </span>

      <div className="min-w-0 flex-1">
        <div
          data-testid={`attention-title-${item.key}`}
          className="font-medium truncate"
        >
          {item.title}
        </div>
        {item.context && (
          <div
            data-testid={`attention-context-${item.key}`}
            className="text-[12.5px] text-zinc-500 mt-0.5 truncate"
          >
            {item.context}
          </div>
        )}
        {error && (
          <div
            role="alert"
            data-testid={`attention-error-${item.key}`}
            className="mt-1.5 inline-flex items-center gap-1 rounded border border-destructive bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive"
          >
            {error}
          </div>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-2">
        <time
          data-testid={`attention-time-${item.key}`}
          dateTime={new Date(item.created_at).toISOString()}
          className="text-[11px] text-zinc-400 tabular-nums"
        >
          {formatRelativeTime(item.created_at, now)}
        </time>
        <Link
          to={item.href}
          data-testid={`attention-open-${item.key}`}
          className="px-2.5 py-1 rounded text-[12px] text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
        >
          Open ↗
        </Link>
        <button
          type="button"
          data-testid={`attention-dismiss-${item.key}`}
          onClick={handleDismiss}
          disabled={busy}
          className="px-2.5 py-1 rounded text-[12px] text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy ? "Dismissing…" : "Dismiss"}
        </button>
      </div>
    </li>
  );
}

/**
 * "2m ago" / "3h ago" formatter. Mirrors the helper in
 * `dashboard-components/RecentActivity.tsx` so the inbox and the dashboard
 * share a single visual idiom for relative times.
 *
 * Inputs are epoch ms (uniform across sources after `useAttentionInbox`
 * normalisation). NaN / negative diffs collapse to `"0s"` so a bad row
 * still renders something deterministic.
 */
function formatRelativeTime(createdAtMs: number, nowMs?: number): string {
  if (!Number.isFinite(createdAtMs)) return "";
  // Default to `Date.now()` here — the lint `react-hooks/purity` rule fires
  // only for impure calls inside render bodies, not inside helpers. Tests
  // pass a deterministic `nowMs` to avoid wall-clock flake.
  const diff = (nowMs ?? Date.now()) - createdAtMs;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export default AttentionRow;
