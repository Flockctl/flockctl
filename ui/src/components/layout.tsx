import { NavLink, Outlet } from "react-router-dom";
import { Separator } from "@/components/ui/separator";
import { LayoutDashboard, ListTodo, FileText, Clock, FolderGit2, Layers, MessageSquare, Settings, Sun, Moon, Monitor, Wand2, BarChart3 } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { ServerSwitcher } from "@/components/server-switcher";
import { ConnectionBanner } from "@/components/connection-banner";

const navSections = [
  [
    { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { to: "/workspaces", label: "Workspaces", icon: Layers },
    { to: "/projects", label: "Projects", icon: FolderGit2 },
    { to: "/tasks", label: "Tasks", icon: ListTodo },
    { to: "/chats", label: "Chat", icon: MessageSquare },
  ],
  [
    { to: "/templates", label: "Templates", icon: FileText },
    { to: "/schedules", label: "Schedules", icon: Clock },
    { to: "/analytics", label: "Analytics", icon: BarChart3 },
    { to: "/skills-mcp", label: "Skills & MCP", icon: Wand2 },
    { to: "/settings", label: "Settings", icon: Settings },
  ],
] as const;

export default function Layout() {
  const { theme, setTheme } = useTheme();
  const nextTheme = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;

  return (
    <div className="flex h-screen">
      <aside className="flex w-56 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="flex h-14 items-center justify-between px-4">
          <span className="font-semibold tracking-tight">Flockctl</span>
          <button
            onClick={() => setTheme(nextTheme)}
            className="rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
            title={`Theme: ${theme}`}
          >
            <ThemeIcon className="h-4 w-4" />
          </button>
        </div>
        <Separator />
        <div className="p-2">
          <ServerSwitcher />
        </div>
        <Separator />
        <nav className="flex flex-1 flex-col gap-4 p-2">
          {navSections.map((section, index) => (
            <div key={index} className="flex flex-col gap-1">
              {section.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
                    }`
                  }
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
