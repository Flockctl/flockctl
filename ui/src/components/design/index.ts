/**
 * Design primitives barrel.
 *
 * Single import path for the flat-surface design primitives that replace
 * shadcn `<Card>` & friends on page surfaces. Pages should import from
 * `@/components/design` (this barrel) — never from individual files.
 *
 * Import contract for pages (enforced by `ui/eslint.config.js` +
 * `src/__tests__/lint/no-shadcn-card-on-page.test.ts`):
 *
 *   ✅  import { FlatCard } from "@/components/design";
 *   ❌  import { Card }     from "@/components/ui/card";   // pages only
 *
 * shadcn primitives remain available inside `ui/src/components/**` for
 * dialogs, forms, and Radix-driven interactions — see
 * `ui/CONTRIBUTING-DESIGN.md` for the full when-to-use-which guide.
 */

export { KpiTile } from "./KpiTile";
export type {
  KpiTileProps,
  KpiTileTone,
  KpiTileTrend,
  KpiTileProgress,
} from "./KpiTile";

export { FlatCard } from "./FlatCard";
export type { FlatCardProps } from "./FlatCard";

export { StatusPill } from "./StatusPill";
export type {
  StatusPillProps,
  StatusPillTone,
  StatusPillSize,
} from "./StatusPill";

export { SegmentToggle } from "./SegmentToggle";
export type {
  SegmentToggleProps,
  SegmentToggleOption,
  SegmentToggleSize,
} from "./SegmentToggle";

export { SectionHeader } from "./SectionHeader";
export type { SectionHeaderProps } from "./SectionHeader";

export { LiveDot } from "./LiveDot";
export type { LiveDotProps, LiveDotState, LiveDotSize } from "./LiveDot";

export { Sparkbar } from "./Sparkbar";
export type { SparkbarProps, SparkbarTone } from "./Sparkbar";

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
} from "./BottomSheet";
export type { StagePill, StagePillState, BottomSheetStagesProps } from "./BottomSheet";
