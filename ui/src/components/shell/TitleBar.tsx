import { Link, NavLink } from "react-router-dom";
import { ChevronDown, Settings2 } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { useServerContext } from "@/contexts/server-context";
import { Breadcrumb } from "@/components/shell/Breadcrumb";
import { Logo } from "@/components/shell/Logo";
import { LiveDot } from "@/components/design";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuCheck,
} from "@/components/ui/dropdown-menu";
import type { ServerConnection } from "@/lib/types";

/**
 * TitleBar — top chrome of the new shell, refreshed under M22 tokens to
 * match `.flockctl/plan/ui-prototype.html` lines 60–89 byte-for-byte
 * (modulo dynamic data).
 *
 * Behaviours preserved from M17:
 *   - Theme cycle: light ↔ dark via `useTheme()` (persisted key
 *     `flockctl-theme`). The prototype only ships sun/moon — `system`
 *     is dropped from the cycle here to mirror the prototype's two-icon
 *     toggle (sun visible in dark mode, moon visible in light mode).
 *   - Connection state: derived from `useServerContext().connectionStatus`,
 *     surfaced via `<LiveDot state={connected ? 'live' : 'error'}/>`.
 *     The full `<ConnectionBanner/>` still mounts inside `<NewShell/>`
 *     for non-connected states; the dot is the always-visible signal.
 *   - Logo links to `/dashboard`.
 *   - Dynamic breadcrumb via `<Breadcrumb/>` (route handles in slice 03).
 *   - ⌘K trigger button — disabled placeholder until the palette is
 *     wired in (`onCmdK` prop). Kbd hint flips between `⌘K` (mac) and
 *     `Ctrl K` elsewhere.
 *
 * Note: the prototype's right-edge user avatar was removed — Flockctl
 * is single-tenant local-first, so an identity affordance carries no
 * information for the operator. Settings live in the sidebar footer.
 */

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);

/**
 * Derive the daemon address shown next to the LiveDot. Prototype shows
 * `localhost:52077` for the bundled local daemon; for remote servers we
 * fall back to the SSH host. Formatting stays in `.mono` so it lines up
 * with the rest of the chrome's monospaced runs.
 */
function useDaemonAddress(): string {
  const { activeServer } = useServerContext();
  if (activeServer.is_local) return "localhost:52077";
  return activeServer.ssh?.host ?? activeServer.name;
}

/** Subtitle for a row in the server dropdown — mirrors `<ServerSwitcher/>`. */
function subtitleFor(server: ServerConnection): string {
  if (server.is_local) return "This machine";
  return server.ssh?.host ?? "SSH tunnel";
}

export function TitleBar({ onCmdK }: { onCmdK?: () => void } = {}) {
  const { theme, setTheme } = useTheme();
  const { connectionStatus, servers, activeServer, switchServer } =
    useServerContext();
  const address = useDaemonAddress();
  const connected = connectionStatus === "connected";
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <header
      data-slot="title-bar"
      className="h-9 shrink-0 border-b divider-y bg-white dark:bg-zinc-900 flex items-center px-3 gap-3"
    >
      <Link
        to="/dashboard"
        className="flex items-center gap-2"
        aria-label="Flockctl home"
      >
        <Logo size={16} />
        <span className="font-semibold">flockctl</span>
      </Link>

      <div
        aria-hidden="true"
        className="text-zinc-400 dark:text-zinc-700"
      >
        ·
      </div>

      <div
        data-slot="breadcrumb-slot"
        className="flex items-center gap-1.5 text-[12.5px]"
      >
        <Breadcrumb />
      </div>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onCmdK}
        disabled={!onCmdK}
        title={
          onCmdK
            ? "Open command palette"
            : "Command palette — coming soon"
        }
        aria-label="Command palette"
        className="flex items-center gap-2 px-3 py-1 -my-0.5 rounded border border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 transition text-zinc-500 text-[12px] w-72 disabled:cursor-not-allowed"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <span className="flex-1 text-left">
          Jump to project, chat, file…
        </span>
        <kbd className="mono text-[10px] bg-zinc-100 dark:bg-zinc-800 px-1.5 rounded">
          {isMac ? "⌘K" : "Ctrl K"}
        </kbd>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-slot="server-switcher"
            aria-label="Switch server"
            title="Switch server"
            className="flex items-center gap-1.5 px-1.5 py-0.5 -my-0.5 rounded text-[12px] text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 aria-expanded:bg-zinc-100 dark:aria-expanded:bg-zinc-800"
          >
            <LiveDot state={connected ? "live" : "error"} size="xs" />
            <span className="mono">{address}</span>
            <ChevronDown className="h-3 w-3 text-zinc-400" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
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
                  {subtitleFor(server)}
                </span>
              </div>
              {server.id === activeServer.id && (
                <DropdownMenuCheck className="mt-1" />
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <NavLink to="/settings?tab=server" className="flex items-center gap-2">
              <Settings2 className="h-3.5 w-3.5" />
              Manage Servers…
            </NavLink>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        onClick={() => setTheme(nextTheme)}
        className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500"
        title="Toggle theme (T)"
        aria-label={`Theme: ${theme}`}
      >
        {/* Sun — visible in dark mode (click → light). */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="hidden dark:block"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
        {/* Moon — visible in light mode (click → dark). */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="block dark:hidden"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </button>
    </header>
  );
}

export default TitleBar;
