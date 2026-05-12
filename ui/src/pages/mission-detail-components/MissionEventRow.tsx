import * as React from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Coins,
  HelpCircle,
  Layers,
  Target,
  Trophy,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/format";
import type { MissionEvent } from "@/lib/hooks/missions";

/**
 * MissionEventRow — switch-on-kind renderer for one mission timeline row.
 *
 * Slice 24-01 / T02. The renderer covers the 9 `MissionEventKind` variants
 * named in the slice goal-block. Each kind has a tone-icon, a one-line
 * title, a multi-line body, and optionally a footer link (e.g. the
 * `proposal_filed` row links to the right-column proposals queue).
 *
 * Why a kind → renderer table rather than a switch
 * ------------------------------------------------
 * Each row renderer takes a typed `payload` view (narrowed locally per
 * kind) and returns the title / body / footer slots. A static table
 * indexed by kind makes the dispatch O(1), keeps every variant adjacent
 * for review, and makes "add a kind" a single-entry edit. A `switch`
 * statement would force the rendering JSX into one giant function and
 * the per-kind narrowing into ad-hoc casts — the table form keeps the
 * narrowings local.
 *
 * Forward-compat
 * --------------
 * Production currently emits a few canonical kinds the goal-block does
 * NOT enumerate (`remediation_proposed`, `no_action`, `heartbeat`, …)
 * — see `slice.md ## Audit findings`. When the renderer encounters a
 * kind not in {@link KIND_RENDERERS}, it falls through to a neutral
 * fallback row and emits `console.warn` once per unique unknown kind.
 * That keeps existing missions readable while we wire up the canonical
 * names in a follow-up edit.
 *
 * SSE animation
 * -------------
 * The parent ({@link MissionEventsFeed}) sets `data-fresh="true"` on
 * rows that arrived via the live WS stream (vs. the canonical GET).
 * The `mission-event-row` class plus that attribute selector triggers
 * the slide+fade keyframe defined in `index.css` — opt-out under
 * `prefers-reduced-motion: reduce` per WCAG 2.3.3.
 */

// ─── Tone palette ───────────────────────────────────────────────────────────
//
// One source of truth for the four tones used across the renderer table.
// Adding a tone means appending one entry here; renderers reference the
// tone by key, not by raw class name, so a palette tweak is one edit.

export type EventTone = "indigo" | "amber" | "emerald" | "red" | "zinc";

interface ToneClasses {
  /** Tinted background for the avatar disc (10% alpha). */
  bg: string;
  /** Foreground colour for the icon SVG. */
  fg: string;
}

const TONE_CLASSES: Record<EventTone, ToneClasses> = {
  indigo: {
    bg: "bg-indigo-500/10",
    fg: "text-indigo-600 dark:text-indigo-400",
  },
  amber: {
    bg: "bg-amber-500/10",
    fg: "text-amber-600 dark:text-amber-400",
  },
  emerald: {
    bg: "bg-emerald-500/10",
    fg: "text-emerald-600 dark:text-emerald-400",
  },
  red: {
    bg: "bg-red-500/10",
    fg: "text-red-600 dark:text-red-400",
  },
  zinc: {
    bg: "bg-zinc-500/10",
    fg: "text-zinc-600 dark:text-zinc-400",
  },
};

// ─── Renderer descriptor ────────────────────────────────────────────────────

/**
 * Result of a per-kind renderer. Title and body are React nodes (not
 * strings) so a renderer can paint inline `<code>` / `<strong>` /
 * link nodes without re-implementing the row chrome.
 *
 * `footer` is optional and rendered below the body with a subtle
 * separator — used by `proposal_filed` to surface a "View proposal →"
 * jump to the right-column queue.
 */
export interface KindRendererResult {
  tone: EventTone;
  Icon: LucideIcon;
  /** Stable label for the icon's data-icon attribute (test hook). */
  iconLabel: string;
  title: React.ReactNode;
  body?: React.ReactNode;
  footer?: React.ReactNode;
}

type KindRenderer = (event: MissionEvent) => KindRendererResult;

// ─── Per-kind payload narrowers ─────────────────────────────────────────────
//
// Kept separate from the renderer so the JSX stays readable. Each helper
// returns a narrowed view with safe defaults — the renderer can rely on
// the fields being present without scattering `??` across the JSX.

function asObj(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ─── Renderers ──────────────────────────────────────────────────────────────

const renderMissionStarted: KindRenderer = (event) => {
  const p = asObj(event.payload);
  const objective = asString(p.objective, "(no objective recorded)");
  return {
    tone: "indigo",
    Icon: Target,
    iconLabel: "target",
    title: "Mission started",
    body: <p className="text-sm text-foreground/90">{objective}</p>,
  };
};

const renderTaskObserved: KindRenderer = (event) => {
  const p = asObj(event.payload);
  const summary = asString(p.summary, asString(p.task_id, "task"));
  const excerpt = asString(p.output_excerpt);
  return {
    tone: "indigo",
    Icon: Zap,
    iconLabel: "zap",
    title: <>Task observed: {summary}</>,
    body: excerpt ? (
      <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-[12px] text-muted-foreground">
        {excerpt}
      </pre>
    ) : null,
  };
};

const renderProposalFiled: KindRenderer = (event) => {
  const p = asObj(event.payload);
  const candidate = asObj(p.candidate);
  const action = asString(candidate.action, "(no action recorded)");
  const rationale = asString(p.rationale);
  return {
    tone: "amber",
    Icon: AlertTriangle,
    iconLabel: "alert",
    title: <>Supervisor proposed: {action}</>,
    body: rationale ? (
      <p className="text-sm text-foreground/85">{rationale}</p>
    ) : null,
    footer: (
      <a
        href="#proposals-queue"
        data-testid="mission-event-footer-link"
        className="text-[12.5px] font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
      >
        View proposal →
      </a>
    ),
  };
};

const renderProposalAccepted: KindRenderer = (event) => {
  const p = asObj(event.payload);
  const action = asString(p.action, asString(p.target_id, "proposal"));
  return {
    tone: "emerald",
    Icon: CheckCircle2,
    iconLabel: "check",
    title: "Proposal accepted",
    body: <p className="text-sm text-foreground/85">{action}</p>,
  };
};

const renderProposalRejected: KindRenderer = (event) => {
  const p = asObj(event.payload);
  const reason = asString(p.reason, "(no reason given)");
  return {
    tone: "zinc",
    Icon: XCircle,
    iconLabel: "x",
    title: "Proposal rejected",
    body: <p className="text-sm text-foreground/85">{reason}</p>,
  };
};

const renderBudgetWarning: KindRenderer = (event) => {
  const p = asObj(event.payload);
  const pct = asNumber(p.pct_used);
  const exhaustAt = asNumber(p.projected_exhaust_at);
  const exhaustText = exhaustAt
    ? `Projected exhaust at ${new Date(exhaustAt * 1000).toLocaleTimeString()}`
    : "Projection unavailable";
  return {
    tone: "amber",
    Icon: AlertTriangle,
    iconLabel: "alert",
    title: <>Budget warning: {pct}% used</>,
    body: <p className="text-sm text-foreground/85">{exhaustText}</p>,
  };
};

const renderBudgetExceeded: KindRenderer = (event) => {
  const p = asObj(event.payload);
  const halt = asString(
    p.halt_reason,
    "Mission paused — spend exceeded the configured cap.",
  );
  return {
    tone: "red",
    Icon: Coins,
    iconLabel: "coins",
    title: "Budget exceeded",
    body: <p className="text-sm text-foreground/85">{halt}</p>,
  };
};

const renderDepthWarning: KindRenderer = (event) => {
  const p = asObj(event.payload);
  const depth = asNumber(p.depth, event.depth);
  const max = asNumber(p.max_depth, asNumber(p.max_allowed_depth, 0));
  const path = Array.isArray(p.recursion_path)
    ? (p.recursion_path as unknown[]).map((s) => asString(s)).filter(Boolean)
    : [];
  return {
    tone: "amber",
    Icon: Layers,
    iconLabel: "layers",
    title: (
      <>
        Depth warning: {depth}/{max || "?"}
      </>
    ),
    body:
      path.length > 0 ? (
        <p className="font-mono text-[12px] text-muted-foreground">
          {path.join(" → ")}
        </p>
      ) : null,
  };
};

const renderMissionCompleted: KindRenderer = (event) => {
  const p = asObj(event.payload);
  const summary = asString(p.summary, "Mission objective met.");
  return {
    tone: "emerald",
    Icon: Trophy,
    iconLabel: "trophy",
    title: "Mission completed",
    body: <p className="text-sm text-foreground/85">{summary}</p>,
  };
};

/**
 * Kind → renderer table. The renderer for an unknown kind is the
 * fallback below, which lives outside the table so a `kind in
 * KIND_RENDERERS` check is meaningful.
 *
 * Order of entries here is purely conventional — runtime dispatch is
 * `KIND_RENDERERS[kind]`, so the order has no behavioural effect.
 */
export const KIND_RENDERERS: Record<string, KindRenderer> = {
  mission_started: renderMissionStarted,
  task_observed: renderTaskObserved,
  proposal_filed: renderProposalFiled,
  proposal_accepted: renderProposalAccepted,
  proposal_rejected: renderProposalRejected,
  budget_warning: renderBudgetWarning,
  budget_exceeded: renderBudgetExceeded,
  depth_warning: renderDepthWarning,
  mission_completed: renderMissionCompleted,
};

/**
 * Module-scoped set so each unique unknown kind only logs `console.warn`
 * once per session — a chatty heartbeat-only mission would otherwise
 * spam the console with hundreds of identical warnings.
 *
 * Exported `__resetWarnedKindsForTest` lets the test suite clear the
 * memoisation between cases.
 */
const warnedUnknownKinds = new Set<string>();

/* v8 ignore next 3 — test-only helper. */
export function __resetWarnedKindsForTest(): void {
  warnedUnknownKinds.clear();
}

function fallbackRender(event: MissionEvent): KindRendererResult {
  if (!warnedUnknownKinds.has(event.kind)) {
    warnedUnknownKinds.add(event.kind);
    console.warn(
      `[MissionEventRow] unknown event kind "${event.kind}" — rendering fallback. ` +
        `Add a renderer to KIND_RENDERERS in MissionEventRow.tsx if this ` +
        `kind is now first-class.`,
    );
  }
  let payloadText: string;
  try {
    payloadText = JSON.stringify(event.payload, null, 0);
  } catch {
    payloadText = "[unserialisable payload]";
  }
  return {
    tone: "zinc",
    Icon: HelpCircle,
    iconLabel: "help",
    title: <span className="font-mono">{event.kind}</span>,
    body: (
      <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
        {payloadText.length > 240
          ? `${payloadText.slice(0, 240)}…`
          : payloadText}
      </pre>
    ),
  };
}

// ─── Time formatting ────────────────────────────────────────────────────────
//
// Pure helpers so tests can assert on exact strings without timezone
// flake. `now` is injectable so a deterministic `Date.now()` (vitest's
// fake timers) yields stable output.

/** Render `created_at` (Unix seconds) as a relative-time short string. */
export function formatRelativeTime(unixSec: number, nowMs = Date.now()): string {
  const diffMs = nowMs - unixSec * 1000;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface MissionEventRowProps {
  event: MissionEvent;
  /**
   * When `true`, the row carries a `data-fresh="true"` attribute that
   * triggers the SSE-arrival keyframe in `index.css`. Set by the parent
   * feed when the row was prepended via the live WS overlay (vs. the
   * canonical GET).
   */
  isFresh?: boolean;
  /**
   * Override "now" for relative-time rendering. Tests pass a fixed value
   * so the rendered string is deterministic; production omits it and
   * the row reads `Date.now()` at render time.
   */
  nowMs?: number;
}

export function MissionEventRow({
  event,
  isFresh,
  nowMs,
}: MissionEventRowProps): React.JSX.Element {
  const renderer = KIND_RENDERERS[event.kind] ?? fallbackRender;
  const { tone, Icon, iconLabel, title, body, footer } = renderer(event);
  const tones = TONE_CLASSES[tone];

  const showCost = event.cost_tokens > 0 || event.cost_usd_cents > 0;
  const showDepth = event.depth > 0;

  return (
    <li
      data-testid={`mission-event-row-${event.id}`}
      data-kind={event.kind}
      data-tone={tone}
      data-fresh={isFresh ? "true" : undefined}
      className={cn(
        "mission-event-row flex items-start gap-3 px-3 py-2",
        "border-b divider-y last:border-b-0",
      )}
    >
      <span
        data-testid={`mission-event-icon-${event.id}`}
        data-icon={iconLabel}
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          tones.bg,
        )}
      >
        <Icon className={cn("h-[14px] w-[14px]", tones.fg)} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3
            data-testid={`mission-event-title-${event.id}`}
            className="text-sm font-medium text-foreground"
          >
            {title}
          </h3>
          {showDepth && (
            <span
              data-testid={`mission-event-depth-${event.id}`}
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              depth {event.depth}
            </span>
          )}
          <span
            data-testid={`mission-event-time-${event.id}`}
            className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
            title={new Date(event.created_at * 1000).toLocaleString()}
          >
            {formatRelativeTime(event.created_at, nowMs)}
          </span>
        </div>
        {body && (
          <div
            data-testid={`mission-event-body-${event.id}`}
            className="mt-1.5"
          >
            {body}
          </div>
        )}
        {(footer || showCost) && (
          <div
            data-testid={`mission-event-footer-${event.id}`}
            className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground"
          >
            {footer}
            {showCost && (
              <span
                data-testid={`mission-event-cost-${event.id}`}
                className="ml-auto inline-flex items-center gap-1 tabular-nums"
              >
                <Activity
                  aria-hidden="true"
                  className="h-3 w-3 text-muted-foreground"
                />
                {event.cost_tokens.toLocaleString()} tok ·{" "}
                {formatCents(event.cost_usd_cents)}
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export default MissionEventRow;
