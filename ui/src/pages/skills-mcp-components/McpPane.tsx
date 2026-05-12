import * as React from "react";
import { Plus } from "lucide-react";

import { SectionHeader } from "@/components/design";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { McpServer } from "@/lib/types";

import {
  McpRow,
  type McpRowConnectionStatus,
} from "./McpRow";

/**
 * McpPane — right-hand pane on `/skills` (slice 25-01 T02). Renders
 * the prototype's MCP-servers list:
 *
 *     SectionHeader (size="section", subtitle=`{count}`,
 *                    action=<AddMcpButton/>)
 *     ────────────────────────────────────────────────
 *     McpRow…
 *     McpRow…
 *
 * Pure layout — does not own any data fetching. The owning page
 * (slice 25-01 T03 in `pages/skills-mcp.tsx`) passes `servers` and
 * the optional `statusByName` map (the daemon will fill it in once
 * connection telemetry lands; today every value is `undefined` and
 * no status pill renders).
 *
 * `onAdd` opens the existing M21 `McpServerDialog`; `onSelect` is
 * forwarded to `McpRow.onSelect` and used by the page to open the
 * same dialog in edit mode.
 */
export interface McpPaneProps {
  servers: McpServer[];
  /**
   * Map of server-name → live connection status. Servers not in
   * the map render without a status pill.
   */
  statusByName?: Record<string, McpRowConnectionStatus | undefined>;
  /** Selected server name (driven by route or local state). */
  selectedName?: string | null;
  /** Fires when the operator clicks the "+ Add MCP" header action. */
  onAdd?: () => void;
  /** Fires when an existing row is clicked — opens the dialog in edit mode. */
  onSelect?: (server: McpServer) => void;
  /** Title override (default: "MCP servers"). */
  title?: string;
  className?: string;
  "data-testid"?: string;
}

const EMPTY_LABEL = "No MCP servers configured at this level.";

export function McpPane({
  servers,
  statusByName,
  selectedName,
  onAdd,
  onSelect,
  title = "MCP servers",
  className,
  "data-testid": testId,
}: McpPaneProps): React.JSX.Element {
  const count = servers.length;

  return (
    <section
      data-testid={testId ?? "mcp-pane"}
      className={cn("flex flex-col min-h-0", className)}
    >
      <SectionHeader
        size="section"
        title={title}
        subtitle={String(count)}
        leadingSwatch="bg-indigo-500"
        action={
          onAdd ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="mcp-pane-add-button"
              onClick={onAdd}
              className="h-7 px-2 text-[11.5px]"
            >
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              Add MCP
            </Button>
          ) : undefined
        }
      />

      {servers.length === 0 ? (
        <p
          data-testid="mcp-pane-empty"
          className="text-[12px] text-muted-foreground py-4 text-center"
        >
          {EMPTY_LABEL}
        </p>
      ) : (
        <ul
          data-testid="mcp-pane-list"
          className="flex flex-col"
          role="list"
        >
          {servers.map((server) => {
            const key = `${server.level}:${server.name}`;
            return (
              <li key={key} role="listitem">
                <McpRow
                  server={server}
                  status={statusByName?.[server.name]}
                  selected={selectedName === server.name}
                  onSelect={onSelect}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default McpPane;
