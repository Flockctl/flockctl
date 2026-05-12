import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useProjects, useWorkspaces, useChats, useTasks } from "@/lib/hooks";
import { cmdkStore, useCmdkState } from "@/components/palette/cmdk-store";
import {
  NAV_ROWS,
  entitiesToRows,
  rankRows,
  type CmdkRow,
} from "@/components/palette/cmdk-data";
import { CmdKResults } from "@/components/palette/CmdKResults";

/**
 * CmdK — the new shell's command palette overlay.
 *
 * Mounted globally by `<NewShell />`. Open/close lives in
 * `cmdkStore` so any keyboard listener or button anywhere in the
 * app can summon it without prop drilling.
 *
 * Data comes from the React Query caches the rest of the app
 * already populates — projects, workspaces, chats, tasks. We
 * `staleTime`-piggyback by relying on the caller's existing
 * fetches; opening the palette does NOT trigger a fresh refetch
 * cycle.
 *
 * Keyboard contract:
 *   - ⌘K / Ctrl+K (handled in NewShell) toggles the overlay.
 *   - Escape closes (handled by Radix Dialog).
 *   - ↑ / ↓ moves the highlight.
 *   - Enter activates the highlighted row.
 *   - Click activates a row.
 *
 * Activation always closes the palette before navigating. We
 * deliberately don't pre-warm route hover state — the navigation
 * itself triggers the appropriate React Query fetches.
 */

export function CmdK() {
  const { open, query } = useCmdkState();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [highlight, setHighlight] = useState(0);

  // Pull the cached lists. Each `useXxx` is `enabled` by default so
  // these queries fire as soon as the palette mounts; subsequent
  // opens reuse the React Query cache (the queries themselves stay
  // mounted while the palette is open OR closed — they're cheap and
  // small lists).
  const projects = useProjects().data;
  const workspaces = useWorkspaces().data;
  const chats = useChats().data;
  // useTasks returns a paginated envelope `{ items, total, offset, limit }`
  // — flatten to the items array so the palette stays homogeneous with
  // the other lists.
  const tasksPage = useTasks().data;
  const tasks = tasksPage?.items;

  const allRows = useMemo<CmdkRow[]>(() => {
    return [...NAV_ROWS, ...entitiesToRows({ projects, workspaces, chats, tasks })];
  }, [projects, workspaces, chats, tasks]);

  const rows = useMemo(() => rankRows(allRows, query), [allRows, query]);

  // Reset highlight whenever the result set or open state changes.
  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  // Focus the input on every open. Radix sometimes tries to set focus
  // on the close button (its default "first focusable") which would
  // make typing-to-search inert.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const activate = (row: CmdkRow) => {
    cmdkStore.close();
    navigate(row.to);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight(h => Math.min(rows.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(h => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[highlight];
      if (row) activate(row);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o: boolean) => {
        if (o) cmdkStore.open();
        else cmdkStore.close();
      }}
    >
      <DialogContent
        className="top-24 w-[640px] max-w-[92vw] translate-y-0 gap-0 overflow-hidden p-0"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => cmdkStore.setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a route, project, chat, or task…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Command palette search"
            data-testid="cmdk-input"
          />
          <kbd className="hidden rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
            ESC
          </kbd>
        </div>
        <CmdKResults rows={rows} highlight={highlight} onActivate={activate} onHover={setHighlight} />
        <div className="flex items-center gap-3 border-t bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>↑↓ to navigate</span>
          <span>↵ to select</span>
          <span>esc to close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default CmdK;
