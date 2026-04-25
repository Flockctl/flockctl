import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  LayoutDashboard,
  ListTodo,
  FileText,
  Clock,
  FolderGit2,
  Layers,
  MessageSquare,
  Settings,
  Sun,
  Moon,
  Monitor,
  Wand2,
  BarChart3,
  Inbox,
  ChevronRight,
  Menu,
  X,
} from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { ServerSwitcher } from "@/components/server-switcher";
import { SidebarFooter } from "@/components/sidebar-footer";
import { ConnectionBanner } from "@/components/connection-banner";
import { useAttention } from "@/lib/hooks";
import {
  toggleGroupCollapsed,
  useGroupCollapsed,
} from "@/lib/sidebar-collapse-store";

type BadgeKey = "attention";

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  badgeKey?: BadgeKey;
};

type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/attention", label: "Inbox", icon: Inbox, badgeKey: "attention" },
      { to: "/analytics", label: "Analytics", icon: BarChart3 },
    ],
  },
  {
    id: "work",
    label: "Work",
    items: [
      { to: "/workspaces", label: "Workspaces", icon: Layers },
      { to: "/projects", label: "Projects", icon: FolderGit2 },
      { to: "/tasks", label: "Tasks", icon: ListTodo },
      { to: "/chats", label: "Chat", icon: MessageSquare },
    ],
  },
  {
    id: "automate",
    label: "Automate",
    items: [
      { to: "/templates", label: "Templates", icon: FileText },
      { to: "/schedules", label: "Schedules", icon: Clock },
    ],
  },
  {
    id: "system",
    label: "System",
    items: [
      { to: "/skills-mcp", label: "Skills & MCP", icon: Wand2 },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

type NavGroupSectionProps = {
  group: NavGroup;
  badgeCounts: Record<BadgeKey, number>;
};

function NavGroupSection({ group, badgeCounts }: NavGroupSectionProps) {
  const collapsed = useGroupCollapsed(group.id);
  const contentId = `nav-group-${group.id}`;

  // Rollup = sum of badge counts from items inside the group, so users can see
  // attention-worthy work sitting in a collapsed section without opening it.
  const rollup = group.items.reduce((sum, item) => {
    return sum + (item.badgeKey ? badgeCounts[item.badgeKey] ?? 0 : 0);
  }, 0);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => toggleGroupCollapsed(group.id)}
        aria-expanded={!collapsed}
        aria-controls={contentId}
        className="group/header flex items-center gap-1.5 rounded-md px-2 pt-3 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-sidebar-foreground/50 transition-colors hover:text-sidebar-foreground/80"
      >
        <ChevronRight
          aria-hidden="true"
          className={`h-3 w-3 shrink-0 transition-transform duration-150 ${
            collapsed ? "" : "rotate-90"
          }`}
        />
        <span className="flex-1 text-left">{group.label}</span>
        {rollup > 0 && (
          <span
            aria-label={`${rollup} item${rollup === 1 ? "" : "s"} in ${group.label}`}
            className="rounded-full bg-sidebar-accent/60 px-1.5 text-[10px] font-medium leading-4 text-sidebar-foreground/70"
          >
            {rollup}
          </span>
        )}
      </button>
      <div
        id={contentId}
        role="region"
        aria-hidden={collapsed}
        className="grid transition-[grid-template-rows] duration-150 ease-out"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col gap-1 pt-1">
            {group.items.map(({ to, label, icon: Icon, badgeKey }) => {
              const count = badgeKey ? badgeCounts[badgeKey] : 0;
              const showBadge = count > 0;
              return (
                <NavLink
                  key={to}
                  to={to}
                  tabIndex={collapsed ? -1 : 0}
                  className={({ isActive }) =>
                    `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
                    }`
                  }
                >
                  <Icon className="h-4 w-4" />
                  <span className="flex-1">{label}</span>
                  {showBadge && (
                    <Badge
                      variant="destructive"
                      aria-label={`${count} item${count === 1 ? "" : "s"} needing attention`}
                    >
                      {count}
                    </Badge>
                  )}
                </NavLink>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Layout() {
  const { theme, setTheme } = useTheme();
  const nextTheme = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const { total: attentionTotal } = useAttention();
  const badgeCounts: Record<BadgeKey, number> = {
    attention: attentionTotal,
  };

  // Mobile drawer state. On screens < md the sidebar is hidden by default and
  // rendered as a slide-in overlay when `mobileNavOpen` is true. On md+ the
  // sidebar is always visible (static column) and this state is ignored.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();

  // Auto-close the mobile drawer whenever the route changes so a tap on a
  // nav item closes the drawer without the user having to hit the X.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  // Lock body scroll while the mobile drawer is open — prevents the page
  // behind the overlay from scrolling when the user scrolls within the nav.
  useEffect(() => {
    if (!mobileNavOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileNavOpen]);

  // The sidebar is identical between desktop and mobile — it's just the
  // wrapping element that changes (static `aside` vs fixed-position drawer).
  // Keeping the body in a render fn avoids duplicating the nav markup.
  const renderSidebarBody = () => (
    <>
      <div className="flex h-14 items-center justify-between px-4">
        <span className="font-semibold tracking-tight">Flockctl</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTheme(nextTheme)}
            className="rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
            title={`Theme: ${theme}`}
          >
            <ThemeIcon className="h-4 w-4" />
          </button>
          {/* Close button only shows inside the mobile drawer — on desktop
              the sidebar is always visible so there's nothing to close. */}
          <button
            onClick={() => setMobileNavOpen(false)}
            className="rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground md:hidden"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <Separator />
      <div className="p-2">
        <ServerSwitcher />
      </div>
      <Separator />
      <nav className="flex flex-1 flex-col overflow-y-auto px-2 pb-2">
        {navGroups.map((group) => (
          <NavGroupSection
            key={group.id}
            group={group}
            badgeCounts={badgeCounts}
          />
        ))}
      </nav>
      <Separator />
      <SidebarFooter />
    </>
  );

  return (
    <div className="flex h-screen min-h-0">
      {/* Desktop sidebar — static column, hidden below md. */}
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
        {renderSidebarBody()}
      </aside>

      {/* Mobile drawer — fixed overlay, only mounted below md while open.
          Mounting conditionally (rather than keeping it in the DOM with a
          transform) avoids duplicating the nav tree in the accessibility
          tree when the user is on a desktop viewport. */}
      {mobileNavOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col border-r bg-sidebar text-sidebar-foreground shadow-xl md:hidden">
            {renderSidebarBody()}
          </aside>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        {/* Mobile top bar — hamburger + brand label. Hidden on md+ where
            the full sidebar provides navigation. */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 md:hidden">
          <button
            onClick={() => setMobileNavOpen(true)}
            className="rounded-md p-2 text-foreground/80 transition-colors hover:bg-accent"
            aria-label="Open navigation"
            aria-expanded={mobileNavOpen}
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-semibold tracking-tight">Flockctl</span>
          {attentionTotal > 0 && (
            <Badge variant="destructive" className="ml-1" aria-label={`${attentionTotal} items needing attention`}>
              {attentionTotal}
            </Badge>
          )}
        </div>
        <main className="flex-1 overflow-auto p-3 sm:p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
