import { Layers, Play, Bell, XCircle, DollarSign } from "lucide-react";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { StatCard } from "@/components/stat-card";
import { useKpiData } from "@/lib/use-kpi-data";

/**
 * Top-of-BoardView KPI bar for the mission-control experience
 * (milestone 09 / slice 04).
 *
 * The component is intentionally thin: all numbers come from
 * {@link useKpiData}, which stitches three already-existing hooks
 * (`useProjectStats`, `useAttention`, `useUsageSummary`) — no new
 * network calls are made here. React-query cache invalidation
 * triggered by unrelated task/status changes is the reason the bar
 * updates within ~2s of a status change.
 *
 * Layout is a fixed 5-card grid; the parent slice.md is explicit
 * that we must NOT grow past 5 cards. The order is also locked:
 *
 *   1. Slices done/total (with mini progress bar)
 *   2. Active tasks
 *   3. Pending approval (amber when > 0)
 *   4. Failed (24h) (red when > 0)
 *   5. Tokens / $ (24h)
 *
 * Corner cases delivered:
 *   - Empty project: every card shows 0 and the progress bar is empty.
 *   - Pending approval > 0: the card gets an amber ring/background so
 *     it reads as "attention-needed" without pulling focus away from
 *     failed/error conditions.
 *   - Failed > 0: the value is rendered in destructive-red.
 *   - Millions of tokens format as `1.2M` (no scientific notation).
 *   - Sub-cent cost renders as `<$0.01` (never `$0.00`).
 *   - Per-field `isLoading` is respected: an error in `useUsageSummary`
 *     only dims the Tokens card; an error in `useProjectStats` dims
 *     the four stats-backed cards but leaves Pending approval
 *     (attention-backed) intact.
 */

export interface MissionControlKpiBarProps {
  projectId: string;
}

/**
 * The en-dash sentinel used anywhere a stat value is `null` — i.e. the
 * backing data-hook does not (yet) support this scope. Centralized so the
 * UI and the unit tests share the exact same codepoint.
 */
export const KPI_NULL_PLACEHOLDER = "—";

/**
 * Format a raw token count. Millions go to `1.2M`, thousands to
 * `1.2K`, and anything smaller prints as-is. We deliberately do NOT
 * reuse `formatTokens` from `lib/format` because the contract here
 * is slightly stricter: "1.2M" must always be emitted for 1e6+, even
 * if `formatTokens` were to change its rounding rule later.
 *
 * `null` inputs surface the `—` sentinel, signalling "data unavailable"
 * (e.g. usage-by-workspace hook is not wired). That is distinct from a
 * known zero, which stays as `"0"`.
 */
export function formatKpiTokens(n: number | null): string {
  if (n === null) return KPI_NULL_PLACEHOLDER;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Format cents as USD. Non-zero sub-cent values collapse to the
 * sentinel `<$0.01` so the card never claims "$0.00" when a
 * non-trivial cost was spent. `null` → the `—` placeholder, same rule
 * as {@link formatKpiTokens}.
 */
export function formatKpiCost(cents: number | null): string {
  if (cents === null) return KPI_NULL_PLACEHOLDER;
  if (cents === 0) return "$0.00";
  if (cents < 1) return "<$0.01";
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Same shape as {@link StatCard} but with an optional amber/red
 * emphasis. We cannot reuse StatCard verbatim for the pending-
 * approval + failed cards because StatCard has no "tone" knob; wrap
 * it in a Card/CardHeader/CardContent clone with the same visual DNA
 * and only override the ring/value color. Keeping the JSX structure
 * in sync with StatCard matters for the existing visual baselines.
 */
function ToneStatCard({
  icon: Icon,
  label,
  value,
  subtitle,
  isLoading,
  tone,
  testId,
}: {
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  label: string;
  // `null` means "data unavailable" and collapses to `—`. Known-zero
  // numbers render as `0` and keep their neutral tone.
  value: number | string | null;
  subtitle?: string;
  isLoading: boolean;
  tone: "neutral" | "amber" | "destructive";
  testId?: string;
}) {
  const displayValue = value === null ? KPI_NULL_PLACEHOLDER : value;
  return (
    <Card
      data-testid={testId}
      data-tone={tone}
      className={cn(
        tone === "amber" &&
          "border-amber-500/60 bg-amber-500/5 ring-1 ring-amber-500/30",
        tone === "destructive" && "border-destructive/50",
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          <Icon
            className={cn(
              "mr-2 inline h-4 w-4",
              tone === "amber" && "text-amber-600",
              tone === "destructive" && "text-destructive",
            )}
          />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "text-2xl font-bold",
            tone === "amber" && "text-amber-600",
            tone === "destructive" && "text-destructive",
          )}
        >
          {isLoading ? <Skeleton className="h-8 w-16" /> : displayValue}
        </div>
        {subtitle && !isLoading && (
          <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Specialized Slices-done/total card. Uses the same visual DNA as
 * StatCard but adds a mini progress bar under the value — StatCard
 * has no slot for that, so we render the chrome inline rather than
 * threading a new prop through. The zero-slice project renders `0 /
 * 0` and a fully-empty progress bar (value = 0).
 */
function SlicesStatCard({
  slicesDone,
  slicesTotal,
  isLoading,
  label = "Slices",
}: {
  // Either side may be `null` when the backing data hook doesn't yet
  // support this scope (e.g. workspace view without a per-workspace
  // progress aggregate). Null collapses to `—` and zeroes the bar.
  slicesDone: number | null;
  slicesTotal: number | null;
  isLoading: boolean;
  label?: string;
}) {
  // Guard against both slicesTotal === 0 AND floating-point surprises
  // by clamping to [0, 100]. `slicesDone > slicesTotal` shouldn't
  // happen — but if the backend ever ships a stale view of the
  // counters, we'd rather show 100% than a bar that spills past the
  // track. A `null` on either side zeroes the bar — we explicitly do
  // NOT guess at a percentage when either numerator or denominator is
  // unknown.
  const percent =
    slicesDone !== null && slicesTotal !== null && slicesTotal > 0
      ? Math.max(0, Math.min(100, (slicesDone / slicesTotal) * 100))
      : 0;
  const valueLabel =
    slicesDone === null || slicesTotal === null
      ? KPI_NULL_PLACEHOLDER
      : `${slicesDone} / ${slicesTotal}`;
  return (
    <Card data-testid="kpi-slices">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          <Layers className="mr-2 inline h-4 w-4" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" data-testid="kpi-slices-value">
          {isLoading ? <Skeleton className="h-8 w-16" /> : valueLabel}
        </div>
        <div className="mt-2" data-testid="kpi-slices-progress">
          <Progress value={percent} />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Shape consumed by the pure (hook-free) {@link MissionControlKpiBarView}.
 *
 * Every numeric field is `number | null`:
 *   - a real `number` (including `0`) is rendered as-is;
 *   - `null` means "data unavailable for this scope" (e.g. workspace view
 *     without a per-workspace usage hook) and is rendered as `—`.
 *
 * `isLoading` is a per-field map; a `true` entry trumps the value and
 * shows a skeleton for that single card only.
 */
export interface MissionControlKpiBarViewProps {
  slicesDone: number | null;
  slicesTotal: number | null;
  activeTasks: number | null;
  pendingApproval: number | null;
  failed24h: number | null;
  tokens24h: number | null;
  costCents24h: number | null;
  /** Label for the first card. Defaults to `"Slices"`; the workspace
   * view passes `"Projects"` since the aggregate it shows is over
   * projects rather than slices. */
  slicesLabel?: string;
  isLoading?: {
    slicesDone?: boolean;
    slicesTotal?: boolean;
    activeTasks?: boolean;
    pendingApproval?: boolean;
    failed24h?: boolean;
    tokens24h?: boolean;
    costCents24h?: boolean;
  };
}

/**
 * Pure presentational variant. Accepts the five stat values directly —
 * no network calls, no hooks. Used by the workspace-detail view, whose
 * data shape doesn't map 1:1 onto {@link useKpiData}, and by the project
 * wrapper below for the real thing.
 *
 * Nullable contract: a `null` value renders as `—` (see
 * {@link KPI_NULL_PLACEHOLDER}). That is distinct from a `0`, which is a
 * real datum — an empty project still has `0 / 0` slices.
 */
export function MissionControlKpiBarView({
  slicesDone,
  slicesTotal,
  activeTasks,
  pendingApproval,
  failed24h,
  tokens24h,
  costCents24h,
  slicesLabel = "Slices",
  isLoading,
}: MissionControlKpiBarViewProps) {
  const tokenLabel = formatKpiTokens(tokens24h);
  const costLabel = formatKpiCost(costCents24h);

  // Tone promotion treats `null` as "no data" → neutral. We only flip to
  // amber/destructive on a strictly positive count.
  const pendingTone =
    pendingApproval !== null && pendingApproval > 0 ? "amber" : "neutral";
  const failedTone =
    failed24h !== null && failed24h > 0 ? "destructive" : "neutral";

  return (
    <div
      data-testid="mission-control-kpi-bar"
      className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5"
    >
      <SlicesStatCard
        slicesDone={slicesDone}
        slicesTotal={slicesTotal}
        isLoading={
          !!(isLoading?.slicesDone || isLoading?.slicesTotal)
        }
        label={slicesLabel}
      />

      <div data-testid="kpi-active-tasks">
        <StatCard
          icon={Play}
          label="Active tasks"
          value={activeTasks === null ? KPI_NULL_PLACEHOLDER : activeTasks}
          isLoading={!!isLoading?.activeTasks}
        />
      </div>

      <ToneStatCard
        testId="kpi-pending-approval"
        icon={Bell}
        label="Pending approval"
        value={pendingApproval}
        isLoading={!!isLoading?.pendingApproval}
        tone={pendingTone}
      />

      <ToneStatCard
        testId="kpi-failed-24h"
        icon={XCircle}
        label="Failed (24h)"
        value={failed24h}
        isLoading={!!isLoading?.failed24h}
        tone={failedTone}
      />

      <div data-testid="kpi-tokens-cost">
        <StatCard
          icon={DollarSign}
          label="Tokens / $ (24h)"
          value={tokenLabel}
          subtitle={costLabel}
          isLoading={
            !!(isLoading?.tokens24h || isLoading?.costCents24h)
          }
        />
      </div>
    </div>
  );
}

/**
 * Project-scoped wrapper. Keeps the original `{ projectId }` API — the
 * hook-stitched {@link useKpiData} always resolves to real numbers, so
 * this callsite never produces `null`. The nullable contract on
 * {@link MissionControlKpiBarView} exists for the workspace view, which
 * lacks some of the per-scope hooks.
 */
export function MissionControlKpiBar({ projectId }: MissionControlKpiBarProps) {
  const kpi = useKpiData(projectId);

  return (
    <MissionControlKpiBarView
      slicesDone={kpi.slicesDone}
      slicesTotal={kpi.slicesTotal}
      activeTasks={kpi.activeTasks}
      pendingApproval={kpi.pendingApproval}
      failed24h={kpi.failed24h}
      tokens24h={kpi.tokens24h}
      costCents24h={kpi.costCents24h}
      isLoading={kpi.isLoading}
    />
  );
}

export default MissionControlKpiBar;
