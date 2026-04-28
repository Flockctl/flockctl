import { Button } from "@/components/ui/button";
import { ToggleLeft, ToggleRight } from "lucide-react";

/**
 * Toggle switch button for enabling/disabling a skill or MCP server.
 *
 * Shows ToggleRight when enabled, ToggleLeft when disabled — i.e. the icon
 * reflects current state, not the action that will fire on click. Tests cling
 * to `title=` rather than the icon, so callers must keep titles distinct
 * between enabled/disabled states.
 */
export type DisableToggleProps = {
  /** Whether the item is currently disabled. */
  disabled: boolean;
  /** Tooltip text (also serves as accessibility label). */
  title: string;
  /** When true, the button itself is disabled (e.g. mutation in flight). */
  pending?: boolean;
  /** Extra classes for the inner icon, e.g. `text-purple-600` for project scope. */
  iconClassName?: string;
  /** Toggle handler. The wrapper applies `stopPropagation` for you. */
  onToggle: () => void;
};

export function DisableToggle({
  disabled,
  title,
  pending = false,
  iconClassName,
  onToggle,
}: DisableToggleProps) {
  const Icon = disabled ? ToggleLeft : ToggleRight;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      title={title}
      disabled={pending}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Icon className={`h-4 w-4${iconClassName ? ` ${iconClassName}` : ""}`} />
    </Button>
  );
}
