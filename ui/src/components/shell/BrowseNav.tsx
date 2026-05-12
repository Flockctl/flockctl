import * as React from "react";
import { NavLink } from "react-router-dom";
import { LiveDot, StatusPill } from "@/components/design";
import { cn } from "@/lib/utils";
import { useAttention } from "@/lib/hooks/attention";
import { useChatListLiveState } from "@/lib/hooks/chat-list-live";
import { useTasks } from "@/lib/hooks/tasks";

/**
 * BrowseNav — primary navigation column inside the new shell's sidebar.
 *
 * Mirrors the prototype's BROWSE + LIBRARY groups
 * (`.flockctl/plan/ui-prototype.html` lines 125–192) byte-for-byte:
 * each row uses a 15×15 stroke-1.8 inline SVG carved from the prototype
 * and a `gap-2.5 px-2.5 py-1.5 rounded-md text-[13px]` button shell.
 *
 * Live indicators (the slice's parity contract):
 *   - `Chats`     →  `<StatusPill tone="success" size="sm">{n} live</StatusPill>`
 *                    when one or more chats have an open agent session.
 *   - `Tasks`     →  `<LiveDot state="live" size="xs"/>` when at least one
 *                    task is in `running` status.
 *   - `Attention` →  amber-500 rounded-full count badge when the inbox
 *                    has > 0 items needing user action.
 *
 * Hooks are imported at module scope but their work is fully gated:
 *  - `useAttention` is the live attention WS subscription used elsewhere.
 *  - `useChatListLiveState` was originally Chats-page-local; mounting it
 *    here keeps the sidebar live without adding a new endpoint.
 *  - `useTasks` is a paginated list query — sidebar fetches the first
 *    page and inspects `status` rather than introducing a new hook.
 */

type BrowseRow = {
  to: string;
  label: string;
  icon: React.ReactNode;
  /**
   * Optional badge slot — resolved at render time against the live
   * hooks above. Each kind maps to one specific affordance (no more,
   * no less; the prototype is deliberately spare here).
   */
  badge?: "chats-live" | "tasks-running" | "attention";
};

type BrowseSection = {
  id: string;
  label: string;
  rows: BrowseRow[];
};

/**
 * The exact 15×15 stroke-1.8 SVGs from the prototype. Pulled into
 * pure-JSX constants so the markup stays one row deep at the call
 * site below.
 */
const ICON_PROPS = {
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
} as const;

const ICON = {
  dashboard: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  ),
  workspaces: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M3 7l9-4 9 4-9 4-9-4z" />
      <path d="M3 12l9 4 9-4" />
      <path d="M3 17l9 4 9-4" />
    </svg>
  ),
  projects: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 21V9" />
    </svg>
  ),
  chats: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  tasks: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  missions: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  ),
  schedules: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  ),
  attention: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  templates: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  skills: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M13 2L3 14h7l-1 8 10-12h-7z" />
    </svg>
  ),
  analytics: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M3 3v18h18" />
      <path d="M7 14l3-3 4 4 5-6" />
    </svg>
  ),
  incidents: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <circle cx="12" cy="16" r=".5" fill="currentColor" />
    </svg>
  ),
} as const;

const SECTIONS: BrowseSection[] = [
  {
    id: "browse",
    label: "Browse",
    rows: [
      { to: "/dashboard", label: "Dashboard", icon: ICON.dashboard },
      { to: "/workspaces", label: "Workspaces", icon: ICON.workspaces },
      { to: "/projects", label: "Projects", icon: ICON.projects },
      { to: "/chats", label: "Chats", icon: ICON.chats, badge: "chats-live" },
      { to: "/tasks", label: "Tasks", icon: ICON.tasks, badge: "tasks-running" },
      // "Missions" sidebar row is intentionally hidden until the standalone
      // /missions list page + GET /missions endpoint land. Today missions are
      // surfaced inside the project-detail Plan tab; restoring the row before
      // the list page exists hands the user a 404. Tracked in TODO.md under
      // "Missions list page (/missions)".
      { to: "/schedules", label: "Schedules", icon: ICON.schedules },
      { to: "/attention", label: "Attention", icon: ICON.attention, badge: "attention" },
    ],
  },
  {
    id: "library",
    label: "Library",
    rows: [
      { to: "/templates", label: "Templates", icon: ICON.templates },
      { to: "/skills-mcp", label: "Skills & MCP", icon: ICON.skills },
      { to: "/analytics", label: "Analytics", icon: ICON.analytics },
      { to: "/incidents", label: "Incidents", icon: ICON.incidents },
    ],
  },
];

/**
 * `useTasksAnyRunning` — true iff the first page of tasks contains at
 * least one running task. Derived inline from `useTasks` to avoid
 * adding a new endpoint per the slice spec.
 */
function useTasksAnyRunning(): boolean {
  const { data } = useTasks(0, 50, undefined, {
    // The sidebar only needs the running flag; failures shouldn't
    // surface as red rows or refetch storms.
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (!data?.items) return false;
  return data.items.some(t => t.status === "running");
}

/**
 * `useChatsLiveCount` — number of chats with an active agent session.
 * Derived from the existing `useChatListLiveState` running map (already
 * WS-driven; no extra fetch).
 */
function useChatsLiveCount(): number {
  const { running } = useChatListLiveState(true);
  return Object.keys(running).length;
}

export function BrowseNav() {
  const { total: attentionTotal } = useAttention();
  const chatsLive = useChatsLiveCount();
  const anyTaskRunning = useTasksAnyRunning();

  return (
    <nav
      data-shell-slot="browse-nav"
      className="flex flex-col"
      aria-label="Primary navigation"
    >
      {SECTIONS.map((section, idx) => (
        <React.Fragment key={section.id}>
          {idx > 0 && (
            <div className="my-2 border-t divider-y" aria-hidden="true" />
          )}
          <div className="px-3 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400">
            {section.label}
          </div>
          <div className="px-2 pb-2 space-y-px">
            {section.rows.map(row => (
              <BrowseLink
                key={row.to}
                row={row}
                attentionTotal={attentionTotal}
                chatsLive={chatsLive}
                anyTaskRunning={anyTaskRunning}
              />
            ))}
          </div>
        </React.Fragment>
      ))}
    </nav>
  );
}

function BrowseLink({
  row,
  attentionTotal,
  chatsLive,
  anyTaskRunning,
}: {
  row: BrowseRow;
  attentionTotal: number;
  chatsLive: number;
  anyTaskRunning: boolean;
}) {
  const showLabelGrow =
    row.badge === "chats-live" || row.badge === "attention";
  return (
    <NavLink
      to={row.to}
      data-nav={row.label.toLowerCase().replace(/\s+&?\s*/g, "-")}
      className={({ isActive }) =>
        cn(
          "nav-item w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] hover:bg-zinc-100 dark:hover:bg-zinc-800",
          isActive
            ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
            : "text-zinc-700 dark:text-zinc-300",
        )
      }
    >
      {row.icon}
      <span className={showLabelGrow ? "flex-1 text-left" : undefined}>
        {row.label}
      </span>
      {row.badge === "chats-live" && chatsLive > 0 && (
        <StatusPill
          tone="success"
          size="sm"
          className="mono normal-case tracking-normal"
          aria-label={`${chatsLive} live chat${chatsLive === 1 ? "" : "s"}`}
        >
          {chatsLive} live
        </StatusPill>
      )}
      {row.badge === "tasks-running" && anyTaskRunning && (
        <LiveDot
          state="live"
          size="xs"
          className="ml-auto"
          aria-label="task running"
        />
      )}
      {row.badge === "attention" && attentionTotal > 0 && (
        <span
          className="text-[10px] bg-amber-500 text-white font-semibold rounded-full px-1.5"
          aria-label={`${attentionTotal} item${attentionTotal === 1 ? "" : "s"} needing attention`}
        >
          {attentionTotal > 99 ? "99+" : attentionTotal}
        </span>
      )}
    </NavLink>
  );
}

export default BrowseNav;
