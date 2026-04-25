import { useViewMode, type ViewMode } from "@/lib/use-view-mode";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Segmented three-way toggle for the project-detail view mode.
 *
 * Reads + writes URL state directly through `useViewMode()` — no local
 * mirror, no `history.pushState`, no router-specific imperative calls.
 * React Router's `setSearchParams({ replace: true })` (inside the hook)
 * keeps the current pathname and does an in-place URL update, so the page
 * must NOT reload or navigate when the active button changes.
 *
 * Swimlane is the planned layout; it flips the `?view=` param and lets
 * downstream consumers (BoardView etc.) render the "Coming soon" stub.
 * The badge on the button is purely a visual hint to users.
 */

type ViewModeOption = {
  value: ViewMode;
  label: string;
  comingSoon?: boolean;
};

const OPTIONS: readonly ViewModeOption[] = [
  { value: "board", label: "Board" },
  { value: "tree", label: "Tree" },
  { value: "swimlane", label: "Swimlane", comingSoon: true },
] as const;

export interface ViewModeToggleProps {
  /**
   * Optional project scope forwarded to `useViewMode` so each project
   * remembers its last choice independently.
   */
  projectId?: string;
  className?: string;
}

export function ViewModeToggle({ projectId, className }: ViewModeToggleProps) {
  const [mode, setMode] = useViewMode(projectId);

  return (
    <div
      role="group"
      aria-label="View mode"
      data-slot="button-group"
      className={cn("inline-flex items-center gap-1", className)}
    >
      {OPTIONS.map((opt) => {
        const active = mode === opt.value;
        return (
          <Button
            key={opt.value}
            type="button"
            size="sm"
            variant={active ? "secondary" : "outline"}
            aria-pressed={active}
            data-view-mode={opt.value}
            data-active={active ? "true" : undefined}
            onClick={() => setMode(opt.value)}
          >
            <span>{opt.label}</span>
            {opt.comingSoon ? (
              <Badge
                variant="outline"
                className="ml-1 h-4 px-1.5 text-[10px] font-normal"
              >
                Coming soon
              </Badge>
            ) : null}
          </Button>
        );
      })}
    </div>
  );
}

export default ViewModeToggle;
