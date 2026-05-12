import * as React from "react";

import { cn } from "@/lib/utils";
import {
  KpiTile,
  StatusPill,
  LiveDot,
  type LiveDotState,
} from "@/components/design";
import { formatUsdGuarded } from "@/lib/format";
import { formatInOutHint } from "./formatInOutHint";

/**
 * DashboardKpiTiles — the dashboard's top-of-page summary strip.
 *
 * Layout
 * ------
 * 5 tiles in a single row at `lg+`, collapsing to 2-up at `sm` and a
 * single column on the smallest viewports. The five tiles, left → right:
 *
 *   1. Active tasks   — plain count, optional `+N today` neutral trend.
 *   2. Cost · 24h     — mono $X.XX, budget hint, indigo progress bar.
 *   3. Tokens         — mono total, `in/out R:1` hint, Sparkbar trail.
 *   4. Open chats     — count + 5 small live/idle dots in a bottom slot.
 *   5. Missions       — count + amber `{n} proposals` pill when > 0,
 *                       gradient progress bar.
 *
 * Bottom-slot extension
 * ---------------------
 * The Open chats tile needs a row of 5 small dots under the value. Rather
 * than retrofit a `bottomSlot` prop onto the shared `<KpiTile>` (which
 * would expand its surface area for a single caller), we render a sibling
 * `OpenChatsTile` here that mirrors KpiTile's flat-surface wrapper
 * verbatim. If a future tile ever needs the same slot we'll promote
 * `bottomSlot` into KpiTile in M22/02 (T05) — the slice brief explicitly
 * leaves that door open.
 *
 * The Missions tile is also a sibling component: KpiTile's `trend` prop
 * only carries `positive | negative | neutral` tones, but the brief asks
 * for an amber "{n} proposals" pill that's neither (it's an attention
 * marker, not a delta). A custom tile keeps the colour semantics honest
 * without bending StatusPill's tone vocabulary.
 *
 * Numeric formatting
 * ------------------
 * Cost is formatted as `$X.XX` (always 2 decimals, never compact — the
 * reader needs to see cents). Tokens lean on KpiTile's compact
 * `Intl.NumberFormat` formatter for the count. The `in/out` hint uses
 * the raw ratio of `tokensIn / tokensOut` rounded to the nearest tenth
 * with a `:1` suffix; if `tokensOut` is 0 we render `in only` instead of
 * dividing by zero.
 */

export interface DashboardKpiTilesProps {
  /** Number of currently-running tasks. */
  activeTasks: number | undefined;
  /** Optional neutral trend ("+3 today") for the Active tasks tile. */
  activeTasksTrend?: string;

  /** Cost in USD over the trailing window (default: 24h). */
  costUsd: number | undefined;
  /** Optional budget cap for the indigo progress bar. */
  costBudgetUsd?: number;

  /** Total tokens for the same window. */
  tokensTotal: number | undefined;
  /** Input tokens — used to compute the `in/out R:1` hint. */
  tokensIn?: number;
  /** Output tokens — used to compute the `in/out R:1` hint. */
  tokensOut?: number;
  /** Recent token-volume samples for the Sparkbar trail. */
  tokensSpark?: number[];

  /** Number of open / active chat sessions. */
  openChats: number | undefined;
  /**
   * Per-chat live/idle dots. Render up to 5 dots, padded with idles.
   * Anything past the first 5 is dropped — the slot is fixed-width.
   */
  chatStates?: LiveDotState[];

  /** Number of currently-running missions. */
  missions: number | undefined;
  /** Total mission slots / cap — used for the gradient progress bar. */
  missionsTotal?: number;
  /** Pending proposals count — paints the amber pill when > 0. */
  pendingProposals?: number;
}

function chatDots(states: LiveDotState[] | undefined): LiveDotState[] {
  const head = (states ?? []).slice(0, 5);
  while (head.length < 5) head.push("idle");
  return head;
}

// --- Open chats tile (KpiTile-ish wrapper with a bottom dot slot) ----------

interface OpenChatsTileProps {
  value: number | undefined;
  states: LiveDotState[];
}

function OpenChatsTile({ value, states }: OpenChatsTileProps) {
  const display =
    value === undefined || Number.isNaN(value) || !Number.isFinite(value)
      ? "—"
      : String(value);
  return (
    <div
      data-testid="kpi-tile"
      data-tile="open-chats"
      data-tone="default"
      className="rounded-xl border divider-y bg-white dark:bg-zinc-900 p-3.5"
    >
      <div
        data-testid="kpi-label"
        className="text-[11px] uppercase tracking-wider font-medium text-zinc-500 dark:text-zinc-400"
      >
        Open chats
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span
          data-testid="kpi-value"
          className="text-[18px] font-semibold tabular-nums leading-none"
        >
          {display}
        </span>
      </div>
      <div
        data-testid="open-chats-dots"
        role="list"
        aria-label="chat session liveness"
        className="mt-2 flex items-center gap-1.5"
      >
        {states.map((state, i) => (
          <LiveDot
            key={i}
            state={state}
            size="xs"
            role="listitem"
            data-testid={`open-chats-dot-${i}`}
          />
        ))}
      </div>
    </div>
  );
}

// --- Missions tile (count + optional amber pill + gradient progress) -------

interface MissionsTileProps {
  value: number | undefined;
  total?: number;
  pendingProposals?: number;
}

function MissionsTile({ value, total, pendingProposals }: MissionsTileProps) {
  const display =
    value === undefined || Number.isNaN(value) || !Number.isFinite(value)
      ? "—"
      : String(value);
  const showProgress = total !== undefined && total > 0;
  const num = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const pct = showProgress
    ? Math.max(0, Math.min(1, num / total)) * 100
    : 0;
  const showProposals =
    pendingProposals !== undefined && pendingProposals > 0;

  return (
    <div
      data-testid="kpi-tile"
      data-tile="missions"
      data-tone="default"
      className="rounded-xl border divider-y bg-white dark:bg-zinc-900 p-3.5"
    >
      <div
        data-testid="kpi-label"
        className="text-[11px] uppercase tracking-wider font-medium text-zinc-500 dark:text-zinc-400"
      >
        Missions
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span
          data-testid="kpi-value"
          className="text-[18px] font-semibold tabular-nums leading-none"
        >
          {display}
        </span>
        {showProposals && (
          <StatusPill
            tone="warning"
            size="sm"
            data-testid="missions-proposals-pill"
          >
            {pendingProposals} proposals
          </StatusPill>
        )}
      </div>
      {showProgress && (
        <div className="mt-2">
          <div
            data-testid="kpi-progress"
            data-tone="gradient"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={num}
            className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
          >
            <div
              className={cn(
                "h-full rounded-full transition-all",
                "bg-gradient-to-r from-indigo-400 to-indigo-600",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// --- DashboardKpiTiles -----------------------------------------------------

export function DashboardKpiTiles({
  activeTasks,
  activeTasksTrend,
  costUsd,
  costBudgetUsd,
  tokensTotal,
  tokensIn,
  tokensOut,
  tokensSpark,
  openChats,
  chatStates,
  missions,
  missionsTotal,
  pendingProposals,
}: DashboardKpiTilesProps): React.JSX.Element {
  const costFormatted = formatUsdGuarded(costUsd);
  const costBudgetFormatted = formatUsdGuarded(costBudgetUsd);
  const inOutHint = formatInOutHint(tokensIn, tokensOut);

  return (
    <div
      data-testid="dashboard-kpi-tiles"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
    >
      {/* 1 — Active tasks */}
      <KpiTile
        label="Active tasks"
        value={activeTasks}
        trend={
          activeTasksTrend
            ? { delta: activeTasksTrend, tone: "neutral" }
            : undefined
        }
      />

      {/* 2 — Cost · 24h (mono, budget hint, indigo progress bar) */}
      <KpiTile
        label="Cost · 24h"
        value={costFormatted ?? "—"}
        mono
        hint={
          costBudgetFormatted ? `of ${costBudgetFormatted}` : undefined
        }
        progress={
          costBudgetUsd !== undefined && costBudgetUsd > 0
            ? {
                value: costUsd ?? 0,
                max: costBudgetUsd,
                tone: "indigo",
              }
            : undefined
        }
      />

      {/* 3 — Tokens (mono, in/out hint, Sparkbar) */}
      <KpiTile
        label="Tokens"
        value={tokensTotal}
        mono
        hint={inOutHint}
        spark={tokensSpark && tokensSpark.length > 0 ? tokensSpark : undefined}
      />
      {/*
        Note: KpiTile renders an internal `InlineSparkbar` from the same
        `.sparkbar` CSS utility that the shared <Sparkbar> primitive uses,
        so passing `spark` to KpiTile is pixel-identical to wrapping the
        tile around <Sparkbar>. If we ever need to lift the trail outside
        the tile body, swap the inline spark for an explicit <Sparkbar>
        sibling here — both share the same utility class.
      */}

      {/* 4 — Open chats (sibling tile with bottom dot slot) */}
      <OpenChatsTile value={openChats} states={chatDots(chatStates)} />

      {/* 5 — Missions (count + amber proposals pill + gradient bar) */}
      <MissionsTile
        value={missions}
        total={missionsTotal}
        pendingProposals={pendingProposals}
      />
    </div>
  );
}

export default DashboardKpiTiles;
