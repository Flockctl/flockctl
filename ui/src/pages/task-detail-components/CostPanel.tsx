/**
 * CostPanel — right-rail token + USD summary (M19/03).
 *
 * Pure presentational. Caller (`TaskDetailPage`) reads from
 * `useUsageSummary(...)` and forwards the relevant numbers via
 * props. Live updates work because React re-renders the panel
 * whenever the parent's hook surface yields a fresh number.
 */

import { formatCents, formatTokensWithNull } from "@/lib/format";

export interface CostPanelProps {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  cacheReadTokens?: number | null;
  /** USD cents — keeps the wire format identical across components. */
  costUsdCents?: number | null;
}

export function CostPanel({
  promptTokens,
  completionTokens,
  totalTokens,
  cacheReadTokens,
  costUsdCents,
}: CostPanelProps) {
  return (
    <div data-testid="task-detail-cost-panel" className="rounded-lg border bg-card p-3 text-sm">
      <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        Cost
      </h3>
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">Total spend</span>
          {/* `precise: true` mirrors the prior local formatter — sub-dollar
              spend gets 4 decimals so a $0.0042 turn doesn't round to $0.00. */}
          <span className="font-mono text-base font-semibold">
            {formatCents(costUsdCents, { precise: true })}
          </span>
        </div>
        <div className="space-y-1">
          <Row label="Prompt" value={formatTokensWithNull(promptTokens)} />
          <Row label="Completion" value={formatTokensWithNull(completionTokens)} />
          {cacheReadTokens != null && cacheReadTokens > 0 && (
            <Row label="Cache savings" value={formatTokensWithNull(cacheReadTokens)} accent="text-emerald-600 dark:text-emerald-400" />
          )}
          <Row label="Total" value={formatTokensWithNull(totalTokens)} bold />
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  accent,
  bold,
}: {
  label: string;
  value: string;
  accent?: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${bold ? "font-semibold text-foreground" : ""} ${accent ?? ""}`}>
        {value}
      </span>
    </div>
  );
}

export default CostPanel;
