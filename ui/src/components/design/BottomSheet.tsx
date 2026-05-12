import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * BottomSheet — slide-up modal surface.
 *
 * Wraps Radix Dialog so we get the focus trap, ESC-to-close, click-outside
 * dismissal, and aria wiring for free, then re-positions the content panel
 * to the bottom of the viewport, centered horizontally. Used as the
 * create-flow surface for workspaces and projects (see
 * `ui/CONTRIBUTING-DESIGN.md` "forms exception" — Radix-driven dialogs
 * are explicitly permitted on pages, the no-shadcn-Card rule does not
 * apply here).
 *
 * Why a bottom sheet (vs centered Dialog or right-edge drawer):
 *   - Doesn't fight the left-side navigation. A right-edge drawer
 *     overlaps the page's primary action zone; a centered modal hides
 *     half the list behind dim. The bottom sheet keeps the workspace /
 *     project grid visible above the fold while the form is open.
 *   - Single horizontal axis works well with the stage-pills strip
 *     (Identity → Source → Access → Review) which would awkwardly wrap
 *     in a narrow drawer.
 *
 * Animation matches the existing Dialog primitive's `data-open:` /
 * `data-closed:` variants powered by `tw-animate-css` (already imported
 * in `index.css`). Slide-from-bottom-4 + fade combine into the lift-up
 * affordance the prototype demonstrates.
 *
 * Composition: same shape as shadcn's Dialog wrapper — `BottomSheet` is
 * the controlled root, `BottomSheetContent` portals the panel,
 * `BottomSheetHeader` / `BottomSheetFooter` style the title and footer
 * bands. Consumers pick widths themselves; the default
 * `sm:max-w-[760px]` matches the design but can be overridden.
 */

function BottomSheet(
  props: React.ComponentProps<typeof DialogPrimitive.Root>,
): React.JSX.Element {
  return <DialogPrimitive.Root data-slot="bottom-sheet" {...props} />;
}

function BottomSheetTrigger(
  props: React.ComponentProps<typeof DialogPrimitive.Trigger>,
): React.JSX.Element {
  return (
    <DialogPrimitive.Trigger data-slot="bottom-sheet-trigger" {...props} />
  );
}

function BottomSheetClose(
  props: React.ComponentProps<typeof DialogPrimitive.Close>,
): React.JSX.Element {
  return <DialogPrimitive.Close data-slot="bottom-sheet-close" {...props} />;
}

function BottomSheetPortal(
  props: React.ComponentProps<typeof DialogPrimitive.Portal>,
): React.JSX.Element {
  return <DialogPrimitive.Portal data-slot="bottom-sheet-portal" {...props} />;
}

function BottomSheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>): React.JSX.Element {
  return (
    <DialogPrimitive.Overlay
      data-slot="bottom-sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/30 supports-backdrop-filter:backdrop-blur-xs duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

interface BottomSheetContentProps
  extends React.ComponentProps<typeof DialogPrimitive.Content> {
  /** Show the grab handle at the top edge. Default `true`. */
  showHandle?: boolean;
  /** Show the close X in the upper-right. Default `true`. */
  showCloseButton?: boolean;
}

function BottomSheetContent({
  className,
  children,
  showHandle = true,
  showCloseButton = true,
  ...props
}: BottomSheetContentProps): React.JSX.Element {
  return (
    <BottomSheetPortal>
      <BottomSheetOverlay />
      <DialogPrimitive.Content
        data-slot="bottom-sheet-content"
        className={cn(
          // Position: pinned to bottom, horizontally centered. The flex
          // column structure lets the body scroll while header / pills /
          // footer remain pinned top + bottom of the sheet itself.
          "fixed bottom-0 left-1/2 z-50 -translate-x-1/2",
          "flex w-full max-w-[calc(100%-1rem)] flex-col sm:max-w-[760px]",
          // 88vh keeps a sliver of the page visible at the very top so
          // the user can see they can dismiss by clicking outside; matches
          // the prototype's affordance.
          "max-h-[88vh]",
          // Surfaces: rounded top corners only (sheet feels anchored to
          // the bottom edge), border-on-3-sides (no bottom border since
          // it's flush with the viewport edge), shadow lifts the panel
          // off the page.
          "rounded-t-2xl border border-b-0 border-foreground/10 bg-popover text-popover-foreground",
          "shadow-[0_-32px_64px_-16px_rgba(0,0,0,0.25)]",
          // Animation: matches the existing Dialog primitive's tokens.
          "outline-none duration-150",
          "data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-4",
          "data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-to-bottom-4",
          className,
        )}
        {...props}
      >
        {showHandle && (
          <div
            className="flex shrink-0 justify-center pt-2 pb-1"
            aria-hidden="true"
            data-slot="bottom-sheet-handle"
          >
            <div className="h-1 w-9 rounded-full bg-muted-foreground/30" />
          </div>
        )}
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="bottom-sheet-close-button"
            className="absolute top-3 right-3 grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <XIcon className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </BottomSheetPortal>
  );
}

function BottomSheetHeader({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="bottom-sheet-header"
      className={cn("flex shrink-0 flex-col gap-1 px-6 pt-1 pb-3", className)}
      {...props}
    />
  );
}

function BottomSheetFooter({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="bottom-sheet-footer"
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t border-foreground/10 bg-muted/40 px-6 py-3 sm:flex-row sm:items-center sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function BottomSheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>): React.JSX.Element {
  return (
    <DialogPrimitive.Title
      data-slot="bottom-sheet-title"
      className={cn(
        "font-heading text-base leading-none font-semibold tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

function BottomSheetDescription({
  className,
  ...props
}: React.ComponentProps<
  typeof DialogPrimitive.Description
>): React.JSX.Element {
  return (
    <DialogPrimitive.Description
      data-slot="bottom-sheet-description"
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

/**
 * Stage-pills strip — the horizontal progress indicator that lives between
 * the header and the body in a BottomSheet. Each stage is a literal label
 * (e.g. "Identity") plus a state ("done" | "active" | "todo"). The
 * component renders a `→` between pills and applies the brand color to
 * "active" / "done" so the user can see where they are in the form
 * without it acting as navigation. (Single-scroll forms keep their
 * single scroll axis — these pills are purely visual progress.)
 */

export type StagePillState = "done" | "active" | "todo";

export interface StagePill {
  label: string;
  state: StagePillState;
  /** Optional badge text rendered after the label, e.g. "2 keys" or "auto". */
  hint?: string;
}

export interface BottomSheetStagesProps {
  stages: StagePill[];
  /** Optional `data-testid` for test selectors. */
  "data-testid"?: string;
}

function BottomSheetStages({
  stages,
  "data-testid": testId,
}: BottomSheetStagesProps): React.JSX.Element {
  return (
    <div
      data-slot="bottom-sheet-stages"
      data-testid={testId}
      className="flex shrink-0 items-center gap-2 overflow-x-auto border-y border-foreground/10 bg-muted/30 px-6 py-2"
    >
      {stages.map((s, idx) => {
        const isLast = idx === stages.length - 1;
        return (
          <React.Fragment key={s.label}>
            <span
              data-state={s.state}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
                s.state === "active" &&
                  "bg-primary text-primary-foreground shadow-sm",
                s.state === "done" && "bg-primary/15 text-primary",
                s.state === "todo" && "text-muted-foreground",
              )}
            >
              {s.state === "done" && (
                <span aria-hidden="true" className="text-[10px]">
                  ✓
                </span>
              )}
              {s.label}
              {s.hint ? (
                <span className="text-[10px] opacity-70">· {s.hint}</span>
              ) : null}
            </span>
            {!isLast && (
              <span
                aria-hidden="true"
                className="text-muted-foreground/60 text-xs"
              >
                →
              </span>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export {
  BottomSheet,
  BottomSheetTrigger,
  BottomSheetClose,
  BottomSheetPortal,
  BottomSheetOverlay,
  BottomSheetContent,
  BottomSheetHeader,
  BottomSheetFooter,
  BottomSheetTitle,
  BottomSheetDescription,
  BottomSheetStages,
};
