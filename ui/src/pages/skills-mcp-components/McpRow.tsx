import * as React from "react";

import { LiveDot, StatusPill } from "@/components/design";
import type { StatusPillTone } from "@/components/design";
import { cn } from "@/lib/utils";
import type { McpServer } from "@/lib/types";

/**
 * McpRow — single row in the redesigned MCP servers pane on
 * `/skills` (slice 25-01 T02). Purely presentational; the owning
 * pane wires data, onClick (which routes to the existing M21
 * `McpServerDialog`), and the connection status.
 *
 * Layout matches `.flockctl/plan/ui-prototype.html` MCP pane:
 *
 *     ┌──────────────────────────────────────────────────────────────┐
 *     │ name [LEVEL] [TRANSPORT]   $ npx -y @scope/foo  [STATUS]      │
 *     └──────────────────────────────────────────────────────────────┘
 *
 *   - **name**: server.name in `font-medium`.
 *   - **level pill**: scope (`global` / `workspace` / `project`)
 *     rendered as a small neutral StatusPill so the row reads
 *     consistently alongside SkillRow.
 *   - **transport pill**: `info`-tone StatusPill. Defaults to
 *     `"stdio"` since every MCP server flockctl currently
 *     reconciles is stdio (the daemon spawns the configured
 *     command). Caller may override via the `transport` prop if a
 *     future MCP type ships.
 *   - **URL mono**: the command + args, mono-spaced and truncated.
 *     Mirrors the `<code class="mono">…</code>` in `McpTab`.
 *   - **status pill** (right column, optional):
 *     - `"connected"`  → success (emerald) StatusPill `connected`
 *     - `"connecting"` → warning (amber) StatusPill `connecting`
 *                        with a pulsing `<LiveDot state="live" />`
 *     - `"failed"`     → danger (red) StatusPill `failed`
 *     - `undefined`    → no pill (status unknown / not wired yet)
 *
 * Click — fires `onSelect(server)`. Rendered as a real `<button>`
 * for keyboard activation + free a11y. The slice contract says the
 * row click opens the existing M21 dialog (handled by the parent).
 */

export type McpRowConnectionStatus = "connected" | "connecting" | "failed";

export interface McpRowProps {
  server: McpServer;
  /** Optional connection status; omitting hides the right-side pill. */
  status?: McpRowConnectionStatus;
  /**
   * Transport label for the info pill. Defaults to `"stdio"` —
   * every MCP server flockctl ships today is stdio. Override only
   * when adding a non-stdio transport (e.g. http, sse).
   */
  transport?: string;
  /** Whether this row is the currently focused/selected server. */
  selected?: boolean;
  /** Fires when the row is clicked or activated by keyboard. */
  onSelect?: (server: McpServer) => void;
  className?: string;
  "data-testid"?: string;
}

const ROW_BASE_CLASSES =
  "w-full text-left px-3 py-2 flex items-center gap-3 cursor-pointer transition-colors";
const ROW_HOVER_CLASSES = "hover:bg-zinc-50 dark:hover:bg-zinc-800/40";
const ROW_DIVIDER_CLASSES =
  "border-b border-zinc-100 dark:border-zinc-800/60";
const ROW_SELECTED_CLASSES = "bg-zinc-100 dark:bg-zinc-800/60";

const LEVEL_TONE: Record<McpServer["level"], StatusPillTone> = {
  global: "info",
  workspace: "success",
  project: "neutral",
};

const STATUS_TONE: Record<McpRowConnectionStatus, StatusPillTone> = {
  connected: "success",
  connecting: "warning",
  failed: "danger",
};

function buildCommandLine(server: McpServer): string {
  const args = server.config.args;
  if (!args || args.length === 0) return server.config.command;
  return `${server.config.command} ${args.join(" ")}`;
}

export function McpRow({
  server,
  status,
  transport = "stdio",
  selected,
  onSelect,
  className,
  "data-testid": testId,
}: McpRowProps): React.JSX.Element {
  const handleClick = React.useCallback(() => {
    onSelect?.(server);
  }, [server, onSelect]);

  const cmdLine = buildCommandLine(server);

  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid={testId ?? "mcp-row"}
      data-server-name={server.name}
      data-selected={selected ? "true" : "false"}
      data-status={status ?? "unknown"}
      aria-current={selected ? "true" : undefined}
      className={cn(
        ROW_BASE_CLASSES,
        ROW_HOVER_CLASSES,
        ROW_DIVIDER_CLASSES,
        selected && ROW_SELECTED_CLASSES,
        className,
      )}
    >
      {/* Left column: name + level pill + transport pill. */}
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span
            data-testid="mcp-row-name"
            className="font-medium text-[13px] truncate text-zinc-900 dark:text-zinc-100"
          >
            {server.name}
          </span>
          <StatusPill
            tone={LEVEL_TONE[server.level]}
            size="sm"
            data-testid="mcp-row-level-pill"
            className="shrink-0"
          >
            {server.level}
          </StatusPill>
          <StatusPill
            tone="info"
            size="sm"
            data-testid="mcp-row-transport-pill"
            className="shrink-0 normal-case tracking-normal font-medium"
          >
            {transport}
          </StatusPill>
        </div>
        <code
          data-testid="mcp-row-url"
          className="text-[11px] text-zinc-500 font-mono truncate block"
        >
          {cmdLine}
        </code>
      </div>

      {/* Right column: connection status. */}
      {status && (
        <div className="flex items-center gap-1.5 shrink-0">
          {status === "connecting" && (
            <LiveDot
              state="live"
              size="xs"
              pulse
              data-testid="mcp-row-connecting-dot"
            />
          )}
          <StatusPill
            tone={STATUS_TONE[status]}
            size="sm"
            data-testid="mcp-row-status-pill"
          >
            {status}
          </StatusPill>
        </div>
      )}
    </button>
  );
}

export default McpRow;
