import { NavLink } from "react-router-dom";
import { Server, ChevronDown, Settings2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuCheck,
} from "@/components/ui/dropdown-menu";
import { useServerContext } from "@/contexts/server-context";
import { cn } from "@/lib/utils";

function StatusDot({ status }: { status: "connected" | "checking" | "error" }) {
  const color =
    status === "connected"
      ? "bg-green-500"
      : status === "checking"
        ? "bg-amber-500 animate-pulse"
        : "bg-red-500";
  return (
    <span
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", color)}
      aria-label={status}
    />
  );
}

export function ServerSwitcher() {
  const { servers, activeServer, switchServer, connectionStatus } = useServerContext();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md border border-transparent px-3 py-2 text-left text-sm transition-colors hover:border-sidebar-border hover:bg-sidebar-accent/50 aria-expanded:border-sidebar-border aria-expanded:bg-sidebar-accent/50"
          aria-label="Switch server"
        >
          <Server className="h-4 w-4 text-sidebar-foreground/70" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs font-medium">{activeServer.name}</span>
            <span className="truncate text-[10px] text-muted-foreground">
              {activeServer.is_local ? "This machine" : activeServer.url}
            </span>
          </div>
          <StatusDot status={connectionStatus} />
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Servers</DropdownMenuLabel>
        {servers.map((server) => (
          <DropdownMenuItem
            key={server.id}
            onClick={() => switchServer(server.id)}
            className="flex items-start gap-2"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{server.name}</span>
              <span className="truncate text-[11px] text-muted-foreground">
                {server.is_local ? "This machine" : server.url}
              </span>
            </div>
            {server.id === activeServer.id && <DropdownMenuCheck className="mt-1" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <NavLink to="/settings" className="flex items-center gap-2">
            <Settings2 className="h-3.5 w-3.5" />
            Manage Servers…
          </NavLink>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
