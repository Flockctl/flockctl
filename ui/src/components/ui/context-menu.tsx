import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * shadcn-style wrappers around Radix's `ContextMenu`. Mirrors the
 * dropdown-menu primitive line-for-line so the two share visual
 * vocabulary — the only behavioural difference is the trigger surface
 * (right-click on an arbitrary element vs. a click on a button).
 *
 * Why a separate primitive rather than reusing dropdown-menu?
 *   - Radix forbids it: the two have different focus / keyboard
 *     contracts (Esc / arrow / typeahead are wired against distinct
 *     state machines internally).
 *   - The data attributes that drive open / closed animations
 *     (`data-open` / `data-closed`) are emitted by the matching
 *     primitive, so swapping them at the consumer level would break
 *     the entrance / exit transitions.
 *
 * The wrappers expose the same surface area we use elsewhere — Trigger,
 * Content, Item, Separator, Label — plus `data-slot` attributes the
 * rest of the codebase keys off for snapshot / e2e selectors.
 */

function ContextMenu({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
  );
}

function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          // The min-width / radius / shadow / animation triplet matches
          // dropdown-menu so a context menu that lands next to a kebab
          // dropdown reads as the same component.
          "z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm outline-none transition-colors data-highlighted:bg-muted data-highlighted:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        inset && "pl-8",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      className={cn(
        "px-2 py-1.5 text-xs font-medium text-muted-foreground",
        inset && "pl-8",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuShortcut({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
  ContextMenuShortcut,
};
