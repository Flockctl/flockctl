import * as React from "react";
import { cn } from "@/lib/utils";

export type SegmentToggleSize = "sm" | "md";

export interface SegmentToggleOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentToggleProps<T extends string> {
  /** Ordered list of options. Must have at least one entry. */
  options: SegmentToggleOption<T>[];
  /** Controlled value. If provided, the component does not own its state. */
  value?: T;
  /**
   * Initial value for uncontrolled mode. Ignored when `value` is provided.
   * Falls back to `options[0].value` if neither is supplied.
   */
  defaultValue?: T;
  /** Fired whenever the user activates a different option. */
  onChange?: (value: T) => void;
  /** Visual density. Default `md`. */
  size?: SegmentToggleSize;
  /** Optional accessible label for the radio group. */
  "aria-label"?: string;
  /** Extra classes merged onto the wrapper. */
  className?: string;
  /** Test hook. */
  "data-testid"?: string;
}

const WRAPPER_BASE =
  "inline-flex bg-zinc-100 dark:bg-zinc-800 rounded p-0.5";

const WRAPPER_SIZE: Record<SegmentToggleSize, string> = {
  md: "text-[12px]",
  sm: "text-[11px]",
};

const BUTTON_SIZE: Record<SegmentToggleSize, string> = {
  md: "px-2.5 py-1",
  sm: "px-2 py-0.5",
};

const BUTTON_BASE =
  "rounded outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 transition-colors";

const ACTIVE_CLASSES = "bg-white dark:bg-zinc-900 shadow-sm font-medium";

const INACTIVE_CLASSES =
  "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100";

/**
 * SegmentToggle — flat segmented control primitive (M22 design primitives).
 *
 * Generic over a string union `T` so callers can drive it with their own
 * literal types and get an `onChange(value: T)` payload typed end-to-end.
 *
 * Modes:
 *   - **Controlled** — pass `value` + `onChange`. The component never
 *     mutates its own state; the parent decides what's selected.
 *   - **Uncontrolled** — omit `value`; pass `defaultValue` (or rely on
 *     the first option) and an optional `onChange` listener for
 *     side-effects.
 *
 * Keyboard contract (matches slice 22-02 T03):
 *   - **ArrowLeft / ArrowRight** — cycle the focused option, wrapping at
 *     either end. Cycling does NOT activate; it only moves focus
 *     (roving tabindex pattern).
 *   - **Home / End** — jump to the first / last option.
 *   - **Enter / Space** — activate the focused option (call `onChange`
 *     and update internal state in uncontrolled mode).
 *
 * Accessibility:
 *   - Wrapper is `role="radiogroup"` with the optional `aria-label`.
 *   - Each option is a `<button role="radio">` with `aria-checked`
 *     reflecting selected state. The earlier draft also exposed
 *     `aria-pressed`, but `aria-pressed` is invalid on `role="radio"`
 *     (axe `aria-allowed-attr`, critical) — radios use `aria-checked`
 *     exclusively. Toggle-button semantics belong to a separate primitive.
 *   - Only the selected option has `tabIndex=0`; the rest are `-1`.
 *     Tab in/out lands on the active segment, arrows move within.
 */
export function SegmentToggle<T extends string>({
  options,
  value,
  defaultValue,
  onChange,
  size = "md",
  className,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: SegmentToggleProps<T>) {
  if (options.length === 0) {
    // Render nothing rather than an empty floating chip. A zero-option
    // toggle is almost certainly a caller bug; return null so it
    // disappears from the layout cleanly.
    return null;
  }

  const isControlled = value !== undefined;
  const firstOption = options[0]!;
  const [internalValue, setInternalValue] = React.useState<T>(
    () => (defaultValue ?? firstOption.value) as T,
  );
  const selected = (isControlled ? (value as T) : internalValue);

  // Track which option currently has focus, separately from selection.
  // Focus follows arrow keys; selection follows Enter/Space (or click).
  const [focusedIndex, setFocusedIndex] = React.useState<number>(() => {
    const idx = options.findIndex((o) => o.value === selected);
    return idx >= 0 ? idx : 0;
  });

  const buttonRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const commit = React.useCallback(
    (next: T) => {
      if (!isControlled) setInternalValue(next);
      if (next !== selected) onChange?.(next);
    },
    [isControlled, onChange, selected],
  );

  const moveFocus = React.useCallback(
    (nextIndex: number) => {
      setFocusedIndex(nextIndex);
      buttonRefs.current[nextIndex]?.focus();
    },
    [],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const last = options.length - 1;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown": {
        e.preventDefault();
        moveFocus(idx === last ? 0 : idx + 1);
        return;
      }
      case "ArrowLeft":
      case "ArrowUp": {
        e.preventDefault();
        moveFocus(idx === 0 ? last : idx - 1);
        return;
      }
      case "Home": {
        e.preventDefault();
        moveFocus(0);
        return;
      }
      case "End": {
        e.preventDefault();
        moveFocus(last);
        return;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        const opt = options[idx];
        if (opt) commit(opt.value);
        return;
      }
      default:
        return;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-testid={testId ?? "segment-toggle"}
      data-size={size}
      className={cn(WRAPPER_BASE, WRAPPER_SIZE[size], className)}
    >
      {options.map((opt, idx) => {
        const isActive = opt.value === selected;
        return (
          <button
            key={opt.value}
            ref={(node) => {
              buttonRefs.current[idx] = node;
            }}
            type="button"
            role="radio"
            aria-checked={isActive}
            data-value={opt.value}
            data-active={isActive ? "true" : "false"}
            tabIndex={
              isActive || (selected === undefined && idx === focusedIndex)
                ? 0
                : -1
            }
            onClick={() => {
              setFocusedIndex(idx);
              commit(opt.value);
            }}
            onFocus={() => setFocusedIndex(idx)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            className={cn(
              BUTTON_BASE,
              BUTTON_SIZE[size],
              isActive ? ACTIVE_CLASSES : INACTIVE_CLASSES,
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentToggle;
