import { RecentList } from "@/components/shell/RecentList";
import { BrowseNav } from "@/components/shell/BrowseNav";
import { SidebarFooter } from "@/components/shell/SidebarFooter";

/**
 * Sidebar — left chrome of the new shell, refreshed under the
 * design tokens shipped in slices 00–02 of M22.
 *
 * Layout (top to bottom — matches `.flockctl/plan/ui-prototype.html`
 * lines 94–209 byte-for-byte):
 *
 *   - `<RecentList />`      RECENT group with workspace-coloured
 *                           project rows + ★ pin marker + LiveDot for
 *                           the currently-active project. Hidden when
 *                           the recent store is empty.
 *   - `<BrowseNav />`       BROWSE + LIBRARY groups.
 *                           Special live indicators:
 *                             • Chats     — `{n} live` StatusPill
 *                             • Tasks     — LiveDot when any running
 *                             • Attention — amber count badge
 *   - `<SidebarFooter />`   Settings link + a muted daemon version
 *                           line. The legacy user-avatar pill was
 *                           dropped — Flockctl is single-tenant
 *                           local-first, so identity carries no info.
 *
 * The top-level container matches the prototype: `w-56 shrink-0`,
 * `border-r divider-y`, `bg-white dark:bg-zinc-900`, `flex flex-col`,
 * `py-2 overflow-y-auto`. The `divider-y` token is the cross-mode
 * border colour utility shipped in slice 01.
 *
 * Server switcher + connection status now live in the TitleBar
 * (slice 00); they are intentionally absent from the sidebar.
 */
export function Sidebar() {
  return (
    <aside
      data-slot="sidebar"
      className="flex h-full w-56 shrink-0 flex-col overflow-y-auto border-r divider-y bg-white py-2 dark:bg-zinc-900"
    >
      <RecentList />
      <BrowseNav />
      {/*
        Spacer pushes the footer to the bottom edge — mirroring the
        prototype's `<div class="flex-1"></div>` between Library and
        Footer.
      */}
      <div className="flex-1" />
      <SidebarFooter />
    </aside>
  );
}

export default Sidebar;
