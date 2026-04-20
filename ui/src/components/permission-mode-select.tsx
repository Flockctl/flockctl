import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PermissionMode } from "@/lib/types";

export interface PermissionModeOption {
  value: PermissionMode;
  label: string;
  description: string;
}

export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    value: "auto",
    label: "Auto",
    description:
      "Approve read-only and in-scope edits; ask for everything else",
  },
  {
    value: "default",
    label: "Ask before every tool",
    description: "Prompt for approval on every tool call",
  },
  {
    value: "acceptEdits",
    label: "Edit automatically",
    description: "Auto-approve Edit/Write; other tools still prompt",
  },
  {
    value: "plan",
    label: "Plan only",
    description: "Read-only exploration; no file or shell writes",
  },
  {
    value: "bypassPermissions",
    label: "Bypass permissions",
    description: "Approve everything without asking (use with care)",
  },
];

export const INHERIT_VALUE = "__inherit__";

interface Props {
  /** Current value (`null`/undefined → inherit from parent). */
  value: PermissionMode | null | undefined;
  /** Called with `null` when user picks "inherit". */
  onChange: (value: PermissionMode | null) => void;
  /** Optional label shown next to the inherit option, e.g. "inherit from project". */
  inheritLabel?: string;
  /** Disable interaction. */
  disabled?: boolean;
  /** Compact trigger for inline forms. */
  compact?: boolean;
  /** Omit the inherit option (for task-create forms where no parent value yet). */
  allowInherit?: boolean;
}

export function PermissionModeSelect({
  value,
  onChange,
  inheritLabel = "inherit",
  disabled,
  compact,
  allowInherit = true,
}: Props) {
  const current = value ?? INHERIT_VALUE;
  const triggerLabel = value
    ? PERMISSION_MODE_OPTIONS.find((o) => o.value === value)?.label ?? value
    : "Inherit";
  return (
    <Select
      value={current}
      onValueChange={(v) => onChange(v === INHERIT_VALUE ? null : (v as PermissionMode))}
      disabled={disabled}
    >
      <SelectTrigger className={compact ? "h-8 w-full text-xs" : "w-full"}>
        <SelectValue placeholder="Pick a mode">{triggerLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {allowInherit && (
          <SelectItem value={INHERIT_VALUE}>
            <div className="flex flex-col">
              <span className="font-medium">Inherit</span>
              <span className="text-xs text-muted-foreground">
                {inheritLabel}
              </span>
            </div>
          </SelectItem>
        )}
        {PERMISSION_MODE_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            <div className="flex flex-col">
              <span className="font-medium">{opt.label}</span>
              <span className="text-xs text-muted-foreground">
                {opt.description}
              </span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
