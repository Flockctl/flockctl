import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  GitCommit,
  MessageSquare,
} from "lucide-react";

import { FlatCard } from "@/components/design";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * RecentActivity — dashboard timeline feed (slice 23-01 T02).
 *
 * Layout matches `.flockctl/plan/ui-prototype.html` lines 269–299: a
 * `<FlatCard>` with a "Recent activity" header + "See all →" button,
 * followed by up to 5 rows. Each row is a `<button>` with a tone-coloured
 * 28×28 round icon avatar, a title, a secondary metadata line, and a
 * right-aligned relative timestamp.
 *
 * Why presentational
 * ------------------
 * No `useRecentActivity()` hook exists in the codebase (T00 audit confirmed
 * this — see slice.md). The dashboard page derives the feed client-side by
 * concatenating recent tasks + chats + mission events + commits and sorting
 * them by timestamp. Keeping this component pure (`items` in, JSX out)
 * means the dashboard owns the data fan-out and this surface stays trivially
 * testable.
 *
 * Type → icon mapping (table-driven)
 * ----------------------------------
 *   task_completed  → emerald check
 *   proposal_filed  → amber  warn
 *   chat_replied    → indigo chat
 *   commit_pushed   → purple git
 *   schedule_ran    → zinc   clock
 *
 * Adding a new type means appending one entry to {@link TYPE_VARIANTS} —
 * no changes to the row rendering itself.
 */

export type RecentActivityType =
  | "task_completed"
  | "proposal_filed"
  | "chat_replied"
  | "commit_pushed"
  | "schedule_ran";

export interface RecentActivityItem {
  /** Stable key — prefer the source entity's id (e.g. `task-42`, `chat-7`). */
  id: string;
  /** Discriminator that drives icon + tone. */
  type: RecentActivityType;
  /** Primary line — usually the entity name or a verb summary. */
  title: string;
  /** Secondary line — small metadata like project · author or model · tokens. */
  detail?: string;
  /** ISO-8601 timestamp; rendered as a relative time on the right. */
  timestamp: string;
  /**
   * Optional override for row click. Defaults to a no-op when omitted —
   * the slice docs describe the future per-type drill-in but the dashboard
   * does not yet have a routing convention for every type. Keeping the
   * navigation up to the parent avoids forcing one prematurely.
   */
  href?: string;
}

interface TypeVariant {
  /** Tailwind background class for the avatar circle (10% tint). */
  bgClass: string;
  /** Tailwind text class that paints the SVG icon. */
  iconClass: string;
  /** Lucide icon component. */
  Icon: React.ComponentType<{ className?: string }>;
  /** Stable label for the icon's aria-label / data-icon attribute. */
  label: string;
}

const TYPE_VARIANTS: Record<RecentActivityType, TypeVariant> = {
  task_completed: {
    bgClass: "bg-emerald-500/10",
    iconClass: "text-emerald-600 dark:text-emerald-400",
    Icon: CheckCircle2,
    label: "check",
  },
  proposal_filed: {
    bgClass: "bg-amber-500/10",
    iconClass: "text-amber-600 dark:text-amber-400",
    Icon: AlertTriangle,
    label: "warn",
  },
  chat_replied: {
    bgClass: "bg-indigo-500/10",
    iconClass: "text-indigo-600 dark:text-indigo-400",
    Icon: MessageSquare,
    label: "chat",
  },
  commit_pushed: {
    bgClass: "bg-purple-500/10",
    iconClass: "text-purple-600 dark:text-purple-400",
    Icon: GitCommit,
    label: "git",
  },
  schedule_ran: {
    bgClass: "bg-zinc-500/10",
    iconClass: "text-zinc-600 dark:text-zinc-400",
    Icon: Clock,
    label: "clock",
  },
};

/** Hard cap on rows rendered. Anything past index 4 is dropped. */
const MAX_ROWS = 5;

export interface RecentActivityProps {
  /**
   * Activity items, newest first. The component slices to {@link MAX_ROWS}
   * — callers don't have to pre-trim. Pass an empty array to render the
   * empty-state placeholder.
   */
  items: RecentActivityItem[];
  /**
   * Destination for the "See all →" button. Defaults to `/attention`
   * because the dedicated timeline page lives in M25; until then,
   * `/attention` is the closest existing inbox surface.
   */
  seeAllHref?: string;
  /** Optional additional classes to merge onto the card surface. */
  className?: string;
}

export function RecentActivity({
  items,
  seeAllHref = "/attention",
  className,
}: RecentActivityProps): React.JSX.Element {
  const navigate = useNavigate();
  const visible = items.slice(0, MAX_ROWS);

  return (
    <FlatCard className={cn("flex flex-col", className)}>
      <div
        data-testid="recent-activity-header"
        className="flex items-center justify-between px-3 py-2"
      >
        <h3 className="text-sm font-semibold">Recent activity</h3>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="px-0 h-auto text-[12.5px]"
          data-testid="recent-activity-see-all"
          onClick={() => navigate(seeAllHref)}
        >
          See all →
        </Button>
      </div>

      {visible.length === 0 ? (
        <div
          data-testid="recent-activity-empty"
          className="px-3 py-4 text-center text-[12px] text-muted-foreground"
        >
          No recent activity
        </div>
      ) : (
        <ul data-testid="recent-activity-list" className="flex flex-col">
          {visible.map((item) => (
            <RecentActivityRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </FlatCard>
  );
}

function RecentActivityRow({
  item,
}: {
  item: RecentActivityItem;
}): React.JSX.Element {
  const navigate = useNavigate();
  const variant = TYPE_VARIANTS[item.type];
  const { Icon } = variant;

  const handleClick = () => {
    if (item.href) navigate(item.href);
  };

  return (
    <li>
      <button
        type="button"
        data-testid={`recent-activity-row-${item.id}`}
        data-type={item.type}
        onClick={handleClick}
        className="w-full px-3 py-2 flex items-start gap-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 cursor-pointer text-left"
      >
        <span
          data-testid={`recent-activity-icon-${item.id}`}
          data-icon={variant.label}
          className={cn(
            "h-7 w-7 shrink-0 rounded-full flex items-center justify-center",
            variant.bgClass,
          )}
        >
          <Icon className={cn("h-[14px] w-[14px]", variant.iconClass)} />
        </span>

        <span className="min-w-0 flex-1">
          <span
            data-testid={`recent-activity-title-${item.id}`}
            className="block text-sm font-medium truncate"
          >
            {item.title}
          </span>
          {item.detail && (
            <span
              data-testid={`recent-activity-detail-${item.id}`}
              className="block text-xs text-muted-foreground truncate"
            >
              {item.detail}
            </span>
          )}
        </span>

        <span
          data-testid={`recent-activity-time-${item.id}`}
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
        >
          {formatRelativeTime(item.timestamp)}
        </span>
      </button>
    </li>
  );
}

/**
 * Mirrors the helper in `attention-row.tsx` — kept inline so this surface
 * has no cross-module coupling to the attention feature. If a third caller
 * appears, lift this into `@/lib/format`.
 */
function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default RecentActivity;
