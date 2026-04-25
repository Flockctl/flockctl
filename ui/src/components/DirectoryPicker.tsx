import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFsBrowse } from "@/lib/hooks";
import { ChevronRight, Folder, FolderSymlink, FileIcon } from "lucide-react";

interface DirectoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Starting directory. Anything outside `$HOME` will be rejected by the
   * server and the picker falls back to showing the error, letting the user
   * navigate from there. Pass `undefined` to start at `$HOME`.
   */
  initialPath?: string;
  /** Called with the absolute directory path when the user clicks "Select". */
  onSelect: (path: string) => void;
}

/**
 * Modal directory picker wrapping `GET /fs/browse`. Self-contained: it does
 * not know or care about its callers — parents pass `initialPath` + `onSelect`
 * and receive a single absolute path back.
 *
 * Navigation model:
 *  - Single click / Up/Down arrows: highlight an entry. "Select" then returns
 *    the absolute path of that highlighted entry.
 *  - Double click / Enter: descend into the highlighted directory (files are
 *    non-actionable). Use this to browse deeper before selecting something
 *    inside.
 *  - Backspace: go up one level; ignored at `$HOME` (where `parent === null`).
 *  - Esc: closes the dialog (Radix Dialog default).
 *  - Typing in the filter input narrows the list client-side — useful when
 *    the server reports `truncated: true` (more than 500 entries).
 *
 * When nothing is highlighted (fresh open, empty directory), "Select" returns
 * the directory currently being viewed. The footer always shows the exact
 * absolute path that will be handed back so the user sees before clicking.
 */
export function DirectoryPicker({
  open,
  onOpenChange,
  initialPath,
  onSelect,
}: DirectoryPickerProps) {
  const [currentPath, setCurrentPath] = useState<string | undefined>(
    initialPath,
  );
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  // -1 means "no explicit highlight yet" — in that case Select returns the
  // current directory. As soon as the user clicks or arrows, idx becomes >= 0
  // and Select returns the highlighted entry's absolute path instead. This
  // split is what prevents the common misread where a user clicks an entry
  // in the list and expects Select to pick *that* entry, not its parent.
  const [highlightIdx, setHighlightIdx] = useState(-1);

  // Reset transient UI state every time the dialog opens so closing +
  // re-opening feels like a fresh session (filter + highlight shouldn't
  // leak across sessions). `initialPath` is re-applied here too.
  useEffect(() => {
    if (open) {
      setCurrentPath(initialPath);
      setFilter("");
      setHighlightIdx(-1);
    }
  }, [open, initialPath]);

  const { data, isLoading, error } = useFsBrowse(currentPath, showHidden, {
    enabled: open,
  });

  // Server-reported path is canonical (symlinks resolved) — always prefer it
  // over the raw user input so the breadcrumb shows what was actually opened.
  const resolvedPath = data?.path ?? currentPath ?? "";

  // Directories-only: this is a directory picker. Files are hidden to keep
  // the highlight cursor meaningful (Enter only makes sense on a directory).
  const directoryEntries = useMemo(
    () => (data?.entries ?? []).filter((e) => e.is_directory),
    [data?.entries],
  );

  const fileEntries = useMemo(
    () => (data?.entries ?? []).filter((e) => !e.is_directory),
    [data?.entries],
  );

  const visibleEntries = useMemo(() => {
    if (!filter.trim()) return directoryEntries;
    const needle = filter.trim().toLowerCase();
    return directoryEntries.filter((e) =>
      e.name.toLowerCase().includes(needle),
    );
  }, [directoryEntries, filter]);

  // Keep the highlight in-bounds whenever the visible list shrinks (filter
  // typed, new directory opened, etc.). -1 (no highlight) is preserved as-is.
  useEffect(() => {
    if (visibleEntries.length === 0) {
      if (highlightIdx !== -1) setHighlightIdx(-1);
      return;
    }
    if (highlightIdx >= visibleEntries.length) {
      setHighlightIdx(visibleEntries.length - 1);
    }
  }, [visibleEntries.length, highlightIdx]);

  // Join a directory path + child name into an absolute path. `path.join` is
  // a node API (unavailable in the browser) and `URL` mangles Windows-style
  // paths — simple string concat with separator dedup is the right tool for
  // the POSIX paths Flockctl supports.
  const joinPath = useCallback((base: string, name: string) => {
    return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
  }, []);

  const navigateInto = useCallback((name: string) => {
    setCurrentPath((prev) => {
      const base = prev ?? resolvedPath;
      if (!base) return name;
      return joinPath(base, name);
    });
    setFilter("");
    // Entering a new directory is a fresh context — drop the highlight so
    // the user re-expresses intent inside the new list.
    setHighlightIdx(-1);
  }, [resolvedPath, joinPath]);

  const goUp = useCallback(() => {
    if (!data?.parent) return; // At $HOME.
    setCurrentPath(data.parent);
    setFilter("");
    setHighlightIdx(-1);
  }, [data?.parent]);

  // Global (dialog-wide) keyboard handler. Attached to the content root
  // rather than the entry list so Up/Down/Backspace still work while the
  // focus sits in the filter input — that's the whole point of a picker
  // that behaves like a file dialog.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        if (visibleEntries.length === 0) return;
        e.preventDefault();
        // From the "no highlight" sentinel (-1), ArrowDown lands on the first
        // entry. After that it's a clamped step through the visible list.
        setHighlightIdx((i) => Math.min(i + 1, visibleEntries.length - 1));
      } else if (e.key === "ArrowUp") {
        if (visibleEntries.length === 0) return;
        e.preventDefault();
        // Clamp at 0 (not -1) — once the user started navigating we keep a
        // visible highlight rather than springing back to "no selection".
        setHighlightIdx((i) => (i <= 0 ? 0 : i - 1));
      } else if (e.key === "Enter") {
        if (highlightIdx < 0) return;
        const entry = visibleEntries[highlightIdx];
        if (entry && entry.is_directory) {
          e.preventDefault();
          navigateInto(entry.name);
        }
      } else if (e.key === "Backspace") {
        // Don't swallow backspaces inside the filter input — users need to
        // be able to edit the filter string. Only trigger "go up" when the
        // input is empty.
        const target = e.target as HTMLElement;
        const isInput =
          target.tagName === "INPUT" || target.tagName === "TEXTAREA";
        if (isInput && (target as HTMLInputElement).value !== "") return;
        e.preventDefault();
        goUp();
      }
    },
    [visibleEntries, highlightIdx, navigateInto, goUp],
  );

  // Breadcrumb: splits the resolved path into clickable segments. Each
  // segment carries the absolute path it represents so clicking jumps
  // straight there without a chain of `..` traversals.
  const breadcrumbSegments = useMemo(() => {
    if (!resolvedPath) return [];
    // Keep leading `/` for POSIX paths (everything Flockctl supports) while
    // also handling the rare case of a path that already lost its leading
    // slash — the server always returns absolute paths, but defensive code
    // is cheap.
    const parts = resolvedPath.split("/").filter(Boolean);
    const out: Array<{ label: string; path: string }> = [];
    let acc = "";
    for (const p of parts) {
      acc = `${acc}/${p}`;
      out.push({ label: p, path: acc });
    }
    return out;
  }, [resolvedPath]);

  // Auto-scroll the highlighted entry into view. The entry list lives inside
  // a ScrollArea so we grab the viewport via the DOM — the primitive doesn't
  // expose a programmatic scroll API.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-entry-idx="${highlightIdx}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIdx]);

  const errorMessage =
    error instanceof Error ? error.message : error ? String(error) : null;

  // When the server truncates (> MAX_ENTRIES), the filter input is the only
  // way to see later entries. The hint nudges users toward it.
  const truncatedCount =
    data?.truncated && data.entries.length > 0
      ? `${data.entries.length} of many entries — type to filter`
      : null;

  // The absolute path Select will return. With a highlighted entry we point
  // at that child; otherwise we fall back to the current directory (the old
  // default). This is also shown verbatim in the footer so there is never
  // any "wait which one did it just pick" moment.
  const highlightedEntry =
    highlightIdx >= 0 && highlightIdx < visibleEntries.length
      ? visibleEntries[highlightIdx]
      : null;
  const pickedPath = highlightedEntry
    ? joinPath(resolvedPath, highlightedEntry.name)
    : resolvedPath;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl sm:max-w-xl"
        onKeyDown={handleKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Select a directory</DialogTitle>
        </DialogHeader>

        {/* Breadcrumb */}
        <div
          className="flex flex-wrap items-center gap-1 rounded-md border bg-muted/40 px-2 py-1.5 text-xs"
          data-testid="directory-picker-breadcrumb"
        >
          <button
            type="button"
            className="rounded px-1 py-0.5 font-medium hover:bg-accent"
            onClick={() => setCurrentPath(undefined)}
            title="Home"
          >
            ~
          </button>
          {breadcrumbSegments.map((seg, i) => (
            <div key={seg.path} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <button
                type="button"
                className="rounded px-1 py-0.5 hover:bg-accent"
                onClick={() => setCurrentPath(seg.path)}
                disabled={i === breadcrumbSegments.length - 1}
              >
                {seg.label}
              </button>
            </div>
          ))}
        </div>

        {/* Filter + hidden-files toggle */}
        <div className="flex items-center gap-2">
          <Input
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setHighlightIdx(0);
            }}
            placeholder="Filter…"
            aria-label="Filter entries"
            data-testid="directory-picker-filter"
          />
          <label className="flex shrink-0 items-center gap-1.5 text-xs">
            <Checkbox
              checked={showHidden}
              onCheckedChange={(v) => setShowHidden(v === true)}
              aria-label="Show hidden files"
            />
            Hidden
          </label>
        </div>

        {truncatedCount && (
          <p className="text-xs text-muted-foreground">{truncatedCount}</p>
        )}

        {/* Entry list */}
        <ScrollArea
          className="h-72 rounded-md border"
          data-testid="directory-picker-entries"
        >
          <div ref={listRef}>
            {isLoading && (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            )}
            {errorMessage && (
              <p className="p-4 text-sm text-destructive">{errorMessage}</p>
            )}
            {!isLoading && !errorMessage && visibleEntries.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">
                {filter
                  ? "No directories match the filter."
                  : "No subdirectories."}
              </p>
            )}
            {visibleEntries.map((entry, idx) => {
              const Icon = entry.is_symlink ? FolderSymlink : Folder;
              return (
                <button
                  key={entry.name}
                  type="button"
                  data-entry-idx={idx}
                  data-highlighted={idx === highlightIdx ? "true" : "false"}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                    idx === highlightIdx
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50"
                  }`}
                  onClick={() => setHighlightIdx(idx)}
                  onDoubleClick={() => navigateInto(entry.name)}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                  {entry.is_hidden && (
                    <span className="ml-auto text-[10px] uppercase text-muted-foreground">
                      hidden
                    </span>
                  )}
                </button>
              );
            })}
            {/* File entries rendered separately, greyed + non-interactive —
                they're shown for context (what's in the dir) but can't be
                picked. Only appears when the filter is empty. */}
            {!filter && fileEntries.length > 0 && (
              <div className="border-t">
                {fileEntries.slice(0, 20).map((entry) => (
                  <div
                    key={`file-${entry.name}`}
                    className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground"
                  >
                    <FileIcon className="h-3 w-3 shrink-0" />
                    <span className="truncate">{entry.name}</span>
                  </div>
                ))}
                {fileEntries.length > 20 && (
                  <div className="px-3 py-1 text-[10px] text-muted-foreground">
                    + {fileEntries.length - 20} more files
                  </div>
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Preview of what Select will return. Always rendered so the user
            has a single, stable place to look — no "is it the folder I'm in
            or the one I clicked on" guessing. */}
        {pickedPath && (
          <div
            className="rounded-md border bg-muted/40 px-2 py-1.5 text-xs"
            data-testid="directory-picker-picked"
          >
            <span className="text-muted-foreground">Will select: </span>
            <span className="font-mono break-all">{pickedPath}</span>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!pickedPath || !!errorMessage}
            onClick={() => {
              if (pickedPath) {
                onSelect(pickedPath);
                onOpenChange(false);
              }
            }}
          >
            Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
