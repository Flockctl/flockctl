import * as React from "react";
import { Plus } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * AddWorkspaceCard — dashed-border placeholder tile that lives at the end
 * of the workspaces grid and opens the create-workspace dialog when
 * clicked. Mirrors `.flockctl/plan/ui-prototype.html` lines 399–404:
 *
 *   ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
 *   │                                   │
 *   │              ╭───╮                │
 *   │              │ + │                │
 *   │              ╰───╯                │
 *   │          Add workspace            │
 *   │                                   │
 *   └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
 *
 * Design notes
 * ------------
 *   - Presentational: the parent owns the dialog state and passes
 *     `onClick` to flip its `open` flag. Keeping the card free of
 *     dialog wiring means it composes cleanly with whatever dialog
 *     variant the page is using (CreateWorkspaceDialog today; a future
 *     NewWorkspaceDialog tomorrow).
 *   - The whole tile is a single `<button>` so keyboard focus and
 *     Enter/Space activation come for free; we don't need a custom
 *     `role` or key handler.
 *   - `min-h-[140px]` keeps the dashed tile the same vertical height
 *     as a populated workspace card so the trailing slot in the grid
 *     doesn't visually collapse.
 *   - Hover lifts the border + text to indigo so the affordance is
 *     unambiguous in both light and dark themes.
 */
export interface AddWorkspaceCardProps {
  /** Fires on click / Enter / Space — typically opens the create dialog. */
  onClick: () => void;
  /** Override the visible label. Defaults to "Add workspace". */
  label?: string;
  /** Extra classes merged onto the root button. */
  className?: string;
}

export function AddWorkspaceCard({
  onClick,
  label = "Add workspace",
  className,
}: AddWorkspaceCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="add-workspace-card"
      aria-label={label}
      className={cn(
        "rounded-xl border-2 border-dashed border-zinc-300 dark:border-zinc-700",
        "hover:border-indigo-400",
        "p-4 grid place-items-center",
        "text-zinc-500 hover:text-indigo-500",
        "transition min-h-[140px]",
        // Match the focus-visible ring used elsewhere in the app so
        // keyboard navigation is obvious without leaning on the
        // browser default outline (which can be invisible on dark mode).
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
        className,
      )}
    >
      <div className="text-center">
        <Plus
          className="mx-auto mb-2 h-5 w-5"
          aria-hidden="true"
          strokeWidth={2}
        />
        <div className="text-[12.5px]">{label}</div>
      </div>
    </button>
  );
}

export default AddWorkspaceCard;
