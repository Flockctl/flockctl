import { NavLink, useLocation } from "react-router-dom";
import { Plus } from "lucide-react";
import { LiveDot } from "@/components/design";
import { cn } from "@/lib/utils";
import { recentStore, useRecentList, type RecentKind } from "@/lib/recent-store";

/**
 * RecentList — top section of the new shell's sidebar.
 *
 * Renders the prototype's RECENT group (`.flockctl/plan/ui-prototype.html`
 * lines 96–121) byte-for-byte:
 *
 *   - Section header `RECENT` in `text-zinc-400` `tracking-wider` uppercase
 *     with a trailing `+` icon button (placeholder — pin management lives
 *     inside each row).
 *   - Project / workspace rows: workspace-coloured `h-2 w-2 rounded-sm`
 *     square + name + ⭐ for pinned + `<LiveDot state="live" size="xs"/>`
 *     when the row is the currently-active route.
 *   - Other-kind rows (chat, task, mission, …) render a small leading
 *     icon with the entity's tone color (e.g. emerald chat bubble) and
 *     a trailing muted-text kind label (`chat`, `task`, …) so the list
 *     stays scannable when mixed.
 *
 * Sources items from the `recentStore` (vanilla pub/sub backed by
 * `localStorage["flockctl.recent"]`). The list is hidden when
 * empty — the BROWSE group below picks up the real-estate so a fresh
 * user never sees an empty placeholder.
 */

type WorkspaceColor = "indigo" | "pink" | "amber" | "emerald" | "sky";

const COLOR_CLASSES: Record<WorkspaceColor, string> = {
  indigo: "bg-indigo-400",
  pink: "bg-pink-400",
  amber: "bg-amber-400",
  emerald: "bg-emerald-400",
  sky: "bg-sky-400",
};

/**
 * Pick a stable workspace-tinted square color from the recent item id.
 * The prototype shows several rows in indigo and one with a dashed
 * unassigned border — we hash the id into one of the available tones
 * so re-tracking the same entity always yields the same swatch.
 */
function pickColor(id: string): WorkspaceColor {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  const order: WorkspaceColor[] = ["indigo", "pink", "amber", "emerald", "sky"];
  return order[h % order.length] ?? "indigo";
}

const KIND_LABEL: Partial<Record<RecentKind, string>> = {
  chat: "chat",
  task: "task",
  mission: "mission",
  incident: "incident",
  schedule: "schedule",
  template: "template",
};

/**
 * Tiny leading icon for non-project recent rows. Matches the prototype's
 * stroke-2 / 11px chat-bubble glyph so all kinds share the same visual
 * weight as the workspace-coloured square used for project rows.
 */
function KindGlyph({ kind }: { kind: RecentKind }) {
  if (kind === "chat") {
    return (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        className="shrink-0 text-emerald-500"
        aria-hidden="true"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    );
  }
  if (kind === "task") {
    return (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        className="shrink-0 text-sky-500"
        aria-hidden="true"
      >
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    );
  }
  // Fallback — small tinted dot for unknown kinds.
  return <span className="h-2 w-2 rounded-sm bg-zinc-400 shrink-0" aria-hidden="true" />;
}

export function RecentList() {
  const items = useRecentList();
  const location = useLocation();
  if (items.length === 0) return null;

  return (
    <>
      <div
        data-shell-slot="recent-list-header"
        className="px-3 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center justify-between"
      >
        <span>Recent</span>
        <button
          type="button"
          className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
          title="Manage pinned"
          aria-label="Manage pinned"
        >
          <Plus className="h-2.5 w-2.5" strokeWidth={2.4} />
        </button>
      </div>
      <div data-shell-slot="recent-list" className="px-2 pb-2 space-y-px">
        {items.map(item => {
          const isActive = location.pathname === item.href;
          const isProjectish = item.kind === "project" || item.kind === "workspace";
          return (
            <NavLink
              key={`${item.kind}:${item.id}`}
              to={item.href}
              title={item.label}
              className={({ isActive: navActive }) =>
                cn(
                  "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] hover:bg-zinc-100 dark:hover:bg-zinc-800 group",
                  navActive
                    ? "font-medium text-zinc-900 dark:text-zinc-100"
                    : "text-zinc-600 dark:text-zinc-400",
                )
              }
            >
              {isProjectish ? (
                <span
                  className={cn(
                    "h-2 w-2 rounded-sm shrink-0",
                    item.pinned
                      ? COLOR_CLASSES[pickColor(item.id)]
                      : "border border-dashed border-zinc-400",
                  )}
                  aria-hidden="true"
                />
              ) : (
                <KindGlyph kind={item.kind} />
              )}
              <span
                className={cn(
                  "truncate",
                  isActive && isProjectish && "font-medium",
                )}
              >
                {item.label}
              </span>
              {item.pinned && (
                // Audit-round-8 a11y: `role="button"` needs keyboard
                // support — Enter/Space activates; `tabIndex={0}` so
                // it's reachable via Tab.
                <span
                  className="text-[10px] text-amber-500 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Unpin ${item.label}`}
                  onClick={evt => {
                    evt.preventDefault();
                    evt.stopPropagation();
                    recentStore.unpin(item.id, item.kind);
                  }}
                  onKeyDown={evt => {
                    if (evt.key === "Enter" || evt.key === " ") {
                      evt.preventDefault();
                      evt.stopPropagation();
                      recentStore.unpin(item.id, item.kind);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  title="Unpin"
                >
                  ★
                </span>
              )}
              {!isProjectish && KIND_LABEL[item.kind] && (
                <span className="text-[10px] text-zinc-400 ml-auto">
                  {KIND_LABEL[item.kind]}
                </span>
              )}
              {isActive && isProjectish && (
                <LiveDot
                  state="live"
                  size="xs"
                  className="ml-auto"
                  aria-label="active"
                />
              )}
            </NavLink>
          );
        })}
      </div>
    </>
  );
}

export default RecentList;
