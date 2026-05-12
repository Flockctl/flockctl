import { useId } from "react";
import { Undo2 } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { GitStatusEntry } from "@/lib/types";

/**
 * One row in {@link SourceControlPanel}'s changed-file list.
 *
 * Layout (left → right):
 *   ☑  M  src/auth.ts                        src/
 *   |  |  └─ filename (truncate, monospace)  └─ dir hint (muted)
 *   |  └─ status badge (M/A/?/D/…)
 *   └─ checkbox
 *
 * The status badge follows git's own porcelain vocabulary so an operator
 * who reads `git status --short` reads this row identically. We collapse
 * the XY pair to its single most-meaningful character via {@link statusGlyph}
 * so the badge stays one column wide; the full XY is exposed via
 * `aria-label` and `title` on the badge for screen-reader / hover use.
 *
 * The component is intentionally dumb — it exposes `checked` and
 * `onToggle`, never owning selection state. The owning panel keeps
 * selection in a single `Set<string>` so checkbox toggles fan out from
 * one source of truth.
 *
 * Test-id contract:
 *   - `scm-row-{path}`            — `<li>` root.
 *   - `scm-row-checkbox-{path}`   — Checkbox.
 *   - `scm-row-status-{path}`     — single-glyph status badge.
 *   - `scm-row-name-{path}`       — filename Label (clickable surface).
 *   - `scm-row-discard-{path}`    — per-row Discard icon (only when
 *                                   `onDiscard` is wired). Always
 *                                   rendered in the DOM so e2e can
 *                                   target it without hovering; the
 *                                   visual treatment fades in on
 *                                   row-hover / focus-within (group
 *                                   utilities) so the panel stays
 *                                   visually quiet at rest.
 */
export interface ChangedFileRowProps {
  entry: GitStatusEntry;
  checked: boolean;
  onToggle: (path: string) => void;
  /** Compact mode strips the dir hint — used in dense lists. */
  compact?: boolean;
  /**
   * Optional handler for the per-row Discard icon. When omitted the icon
   * is not rendered at all — the parent opts in by passing a handler.
   * The handler receives the row's path; the parent is responsible for
   * popping the {@link DiscardConfirm} dialog and firing the mutation.
   */
  onDiscard?: (path: string) => void;
  /**
   * Disables the discard icon (e.g. during an in-flight mutation). The
   * icon stays in the DOM so layout doesn't jump on success — same
   * pattern the Commit submit button uses.
   */
  discardDisabled?: boolean;
  /**
   * Optional handler for opening the row's diff in the main editor area.
   * When provided, a click on the row body (anywhere except the checkbox
   * or the discard icon) calls `onOpenDiff(path)` instead of toggling
   * the checkbox — matching VSCode's SCM panel behaviour where the row
   * is the diff-open trigger and the checkbox is a deliberate
   * stage-selection action. Toggling stays available via the checkbox
   * itself or by clicking the row label/name explicitly. When omitted,
   * the row behaves exactly like before (whole-row click toggles).
   */
  onOpenDiff?: (path: string) => void;
}

export function ChangedFileRow({
  entry,
  checked,
  onToggle,
  compact = false,
  onDiscard,
  discardDisabled = false,
  onOpenDiff,
}: ChangedFileRowProps) {
  // useId per-row keeps htmlFor → id wiring stable across re-renders even
  // when the same component instance is recycled by react-virtual.
  const reactId = useId();
  const checkboxId = `scm-cb-${reactId}`;
  const xy = formatXY(entry);
  const glyph = statusGlyph(entry);
  const { name, dir } = splitPath(entry.path);

  return (
    <li
      data-testid={`scm-row-${entry.path}`}
      className="group flex items-center gap-2 px-3 py-1 hover:bg-accent/40 cursor-pointer"
      onClick={(e) => {
        // The whole row is clickable, but Radix's checkbox swallows its
        // own click event. We only forward outer-row clicks (i.e. on the
        // label/dir text) to the toggle handler. The per-row discard
        // icon also opts out so a click on it doesn't double-fire as a
        // checkbox toggle.
        if (
          e.target instanceof HTMLElement &&
          (e.target.closest("[data-slot=checkbox]") ||
            e.target.closest("[data-row-action]"))
        ) {
          return;
        }
        // When a diff-open handler is wired, the row click opens the
        // diff (VSCode parity). The checkbox remains the explicit way
        // to toggle staging — that's intentional: clicking the row to
        // see the change is the dominant flow, and folding it into the
        // checkbox would surprise operators.
        if (onOpenDiff) {
          onOpenDiff(entry.path);
          return;
        }
        onToggle(entry.path);
      }}
    >
      <Checkbox
        id={checkboxId}
        data-testid={`scm-row-checkbox-${entry.path}`}
        checked={checked}
        onCheckedChange={() => onToggle(entry.path)}
        aria-label={`Stage ${entry.path}`}
      />
      <span
        data-testid={`scm-row-status-${entry.path}`}
        className={cn(
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[11px] font-semibold",
          statusBadgeClass(glyph),
        )}
        aria-label={`Status: ${xy}`}
        title={xy}
      >
        {glyph}
      </span>
      <Label
        // When `onOpenDiff` is wired, the Label must NOT auto-toggle the
        // checkbox via its native `for=` linkage — the row's click
        // handler routes to onOpenDiff instead. Dropping `htmlFor` here
        // is the bright line; the `<li>` onClick handler still fires and
        // we route from there.
        {...(onOpenDiff ? {} : { htmlFor: checkboxId })}
        data-testid={`scm-row-name-${entry.path}`}
        className="flex-1 cursor-pointer truncate font-mono text-xs"
        title={entry.path}
      >
        {name}
      </Label>
      {!compact && dir && (
        <span
          className="ml-auto truncate font-mono text-[10px] text-muted-foreground"
          title={dir}
        >
          {dir}
        </span>
      )}
      {onDiscard && (
        <button
          type="button"
          data-row-action="discard"
          data-testid={`scm-row-discard-${entry.path}`}
          aria-label={`Discard changes to ${entry.path}`}
          title="Discard changes"
          disabled={discardDisabled}
          onClick={(e) => {
            // Stop the parent <li>'s click handler from also toggling
            // the checkbox — `data-row-action` already escapes the
            // forwarder, but stopPropagation is the second line of
            // defence in case the outer handler ever swaps strategies.
            e.stopPropagation();
            onDiscard(entry.path);
          }}
          className={cn(
            // Hidden at rest, fades in when the row is hovered or any
            // descendant has focus. The keyboard path stays usable
            // because focus-within keeps the icon clickable even
            // without a mouse hover.
            "ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity",
            "hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "group-hover:opacity-100",
            discardDisabled && "cursor-not-allowed opacity-30",
          )}
        >
          <Undo2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </li>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Render the porcelain XY pair as the two-character string git itself uses,
 * normalising any whitespace to literal spaces so the badge has stable width.
 */
function formatXY(entry: GitStatusEntry): string {
  const i = entry.index || " ";
  const w = entry.worktree || " ";
  return `${i}${w}`.replace(/\s/g, " ");
}

/**
 * Pick the single-character glyph to render in the badge from the porcelain
 * XY pair. Priority is: untracked (`?`) → deleted (`D`) → added (`A`) →
 * modified (`M`) → renamed (`R`) → fall back to whatever the worktree code
 * says, then index. The point isn't to losslessly encode XY — it's to give
 * the operator a single recognisable letter at a glance.
 */
function statusGlyph(entry: GitStatusEntry): string {
  const i = entry.index?.trim() || "";
  const w = entry.worktree?.trim() || "";
  if (i === "?" || w === "?") return "?";
  if (i === "D" || w === "D") return "D";
  if (i === "A" || w === "A") return "A";
  if (i === "R" || w === "R") return "R";
  if (i === "M" || w === "M") return "M";
  return w || i || " ";
}

/**
 * Split `src/services/auth.ts` into `{ name: "auth.ts", dir: "src/services/" }`
 * for the trailing dir hint. A path with no slash returns an empty `dir`.
 */
function splitPath(path: string): { name: string; dir: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { name: path, dir: "" };
  return { name: path.slice(idx + 1), dir: path.slice(0, idx + 1) };
}

/**
 * Per-glyph background colour. We deliberately keep the palette muted —
 * the row is visually quiet by default; status colour is just a hint.
 */
function statusBadgeClass(glyph: string): string {
  switch (glyph) {
    case "M":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "A":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "D":
      return "bg-rose-500/15 text-rose-700 dark:text-rose-300";
    case "?":
      return "bg-sky-500/15 text-sky-700 dark:text-sky-300";
    case "R":
      return "bg-violet-500/15 text-violet-700 dark:text-violet-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}
