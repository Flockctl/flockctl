import * as React from "react";
import { Layers, Plus } from "lucide-react";

import { FlatCard } from "@/components/design/FlatCard";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api/core";
import { formatCents, formatTokens } from "@/lib/format";
import type { MissionProposal } from "@/lib/hooks/missions";

/**
 * ProposalCard — one row in the right-column proposals queue (slice 24/01 T03).
 *
 * A `<FlatCard>` rendering of a single supervisor remediation proposal.
 * Visually:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ rationale (3-line clamp, escaped)           │
 *   │ ┌─────────────────────────────────────────┐ │
 *   │ │ + create slice — chat upload pipeline   │ │  ← diff-add line
 *   │ └─────────────────────────────────────────┘ │
 *   │ depth 2 · 4.5K tok · $0.72                  │  ← trigger context
 *   │ [Accept]  [Reject]                          │
 *   └─────────────────────────────────────────────┘
 *
 * ─── Why this lives next to ProposedCard ───
 *
 * `ui/src/pages/project-detail-components/ProposedCard.tsx` is the
 * existing slice-board "Proposed column" card — slimmer chrome, violet
 * left rule, edit affordance, fits the mission-scoped board layout.
 *
 * `ProposalCard` (this file) is the mission-detail right-rail card —
 * uses the new M22 `<FlatCard>` primitive, adds a diff-add visualisation
 * of the candidate action, surfaces the trigger context (depth + cost
 * snapshot from the event row), and gates Reject behind a confirm
 * dialog rather than a `window.prompt` for a reason.
 *
 * The two intentionally co-exist: project-detail's slice-board variant
 * is a kanban column where dense cards matter; mission-detail's
 * proposals queue is a tall narrow rail where richer per-card affordance
 * is the right call. We keep them separate so a tweak to one's chrome
 * doesn't destabilise the other's layout.
 *
 * ─── Security invariants ───
 *
 *   1. Rationale + candidate action render as plain text children — React
 *      escapes them by default. NEVER `dangerouslySetInnerHTML`.
 *   2. Rationale is clamped to {@link RATIONALE_MAX_CHARS} at the render
 *      boundary as defense-in-depth (`proposalSchema` already caps at
 *      4000 chars, but a future migration could relax that).
 *   3. Submitting buttons disable while a request is in flight to defeat
 *      double-clicks; the server is idempotent but a duplicate optimistic
 *      animation would surface a confusing UX.
 *
 * ─── Endpoints ───
 *
 *     Approve: POST /missions/:missionId/proposals/:proposalId/approve
 *     Reject:  POST /missions/:missionId/proposals/:proposalId/dismiss
 *               body: { reason?: string }
 *
 * Both are idempotent server-side (see `src/routes/missions.ts`).
 */

/** Hard cap applied at the render boundary. Mirrors ProposedCard. */
export const RATIONALE_MAX_CHARS = 5000;

/** Cosmetic ellipsis appended when truncation kicks in. */
export const RATIONALE_TRUNCATE_SUFFIX = "…";

/** Width of the accept-out animation. Exported so the test can assert. */
export const ACCEPT_ANIMATION_MS = 200;

function truncateRationale(rationale: string): string {
  if (rationale.length <= RATIONALE_MAX_CHARS) return rationale;
  return rationale.slice(0, RATIONALE_MAX_CHARS - 1) + RATIONALE_TRUNCATE_SUFFIX;
}

// ─── Payload narrowing ─────────────────────────────────────────────────────
//
// Mission proposal payloads come in two real-world shapes:
//   (a) Canonical (proposalSchema, what the supervisor LLM emits today):
//         { rationale, proposal: { target_type, candidate: { action, … } } }
//   (b) Flatter (used by some fixtures and older paths):
//         { rationale, candidate: { action, target_type } }
//
// The narrower below reads from whichever shape is present. `payload` is
// `unknown` at the wire boundary (`MissionProposal.payload: unknown`) so
// every field access goes through a defensive narrow.

interface NarrowedProposal {
  rationale: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string | null;
}

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function narrowProposalPayload(payload: unknown): NarrowedProposal {
  const root = asObj(payload);
  // Try canonical shape first.
  const inner = asObj(root.proposal);
  // Candidate may live on `proposal.candidate` (canonical) or `.candidate`.
  const candidate = asObj(
    Object.keys(inner).length > 0 ? inner.candidate : root.candidate,
  );

  const action = asString(candidate.action, "(no action recorded)");
  const targetType = asStringOrNull(
    Object.keys(inner).length > 0 ? inner.target_type : candidate.target_type,
  );
  const targetId = asStringOrNull(candidate.target_id);
  const summary = asStringOrNull(candidate.summary);
  const rationale = asString(root.rationale, "(no rationale recorded)");

  return { rationale, action, targetType, targetId, summary };
}

// ─── Cost / depth formatting (private helpers) ─────────────────────────────
//
// Cost / token formatters are imported from `@/lib/format` to keep one
// canonical implementation. The two `fmt*Local` wrappers below pin the
// per-card sentinel ("0" / "$0.00") because mission proposals deliberately
// render zero rather than the em-dash; the canonical helpers' non-finite
// guard does the rest.

function fmtTokensLocal(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return formatTokens(n);
}

function fmtCentsLocal(c: number): string {
  return formatCents(c, { nullSentinel: "$0.00" });
}

// ─── Component ─────────────────────────────────────────────────────────────

interface ApproveResponse {
  decision_id: string;
}

interface DismissResponse {
  decision_id: string;
}

export interface ProposalCardProps {
  /** Mission this proposal belongs to. URL prefix for both decision endpoints. */
  missionId: string;
  /** Proposal event row. `payload` is narrowed locally — any shape is tolerated. */
  proposal: MissionProposal;
  /**
   * Fires AFTER a successful POST /approve completes AND after the
   * 200ms animate-out is finished. Parent typically refetches mission
   * events here so the timeline reflects the new `remediation_approved`
   * row.
   */
  onAccepted?: (decisionId: string) => void;
  /**
   * Fires AFTER a successful POST /dismiss completes. The `reason` arg
   * is `null` when the operator left the confirm dialog's reason field
   * empty (current behaviour) or always-`null` until a reason input is
   * added in a follow-up.
   */
  onRejected?: (decisionId: string, reason: string | null) => void;
  /** Test/E2E injection point. Defaults to `apiFetch`. */
  fetcher?: typeof apiFetch;
  /**
   * Test injection point for the reject confirm dialog. Defaults to
   * `window.confirm` in the browser. Tests stub this to avoid jsdom's
   * blocking `confirm`. Returning `true` fires the dismiss POST;
   * `false` cancels with no side effect.
   */
  confirmReject?: (message: string) => boolean;
  /** Optional extra classes merged onto the FlatCard root. */
  className?: string;
}

type Phase = "idle" | "submitting" | "accepted-animating-out" | "rejected";

const ACCEPT_OUT_CLASS =
  "opacity-0 -translate-y-1 transition-all duration-200 ease-out";
const ACCEPT_IDLE_CLASS = "opacity-100 transition-all duration-200 ease-out";

const REJECT_CONFIRM_MESSAGE =
  "Reject this proposal? This decision is logged in mission events.";

export function ProposalCard({
  missionId,
  proposal,
  onAccepted,
  onRejected,
  fetcher = apiFetch,
  confirmReject,
  className,
}: ProposalCardProps): React.JSX.Element {
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [error, setError] = React.useState<string | null>(null);

  const narrowed = narrowProposalPayload(proposal.payload);
  const truncatedRationale = truncateRationale(narrowed.rationale);
  const wasTruncated = narrowed.rationale.length > RATIONALE_MAX_CHARS;

  const isSubmitting = phase === "submitting";
  const isAnimatingOut = phase === "accepted-animating-out";

  const handleAccept = async () => {
    if (phase !== "idle") return;
    setError(null);
    setPhase("submitting");
    try {
      const res = await fetcher<ApproveResponse>(
        `/missions/${missionId}/proposals/${proposal.id}/approve`,
        { method: "POST" },
      );
      // Trigger animate-out, then notify parent so it can refetch.
      setPhase("accepted-animating-out");
      window.setTimeout(() => {
        onAccepted?.(res.decision_id);
      }, ACCEPT_ANIMATION_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Accept failed");
      setPhase("idle");
    }
  };

  const handleReject = async () => {
    if (phase !== "idle") return;
    const ask =
      confirmReject ??
      ((msg: string) =>
        typeof window !== "undefined" && typeof window.confirm === "function"
          ? window.confirm(msg)
          : false);
    const ok = ask(REJECT_CONFIRM_MESSAGE);
    if (!ok) return;

    setError(null);
    setPhase("submitting");
    try {
      const res = await fetcher<DismissResponse>(
        `/missions/${missionId}/proposals/${proposal.id}/dismiss`,
        { method: "POST", body: JSON.stringify({}) },
      );
      onRejected?.(res.decision_id, null);
      // Parent typically removes the card; we still flip to a
      // terminal phase so a stray render after the unmount tick
      // doesn't refire the mutation.
      setPhase("rejected");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reject failed");
      setPhase("idle");
    }
  };

  return (
    <FlatCard
      className={cn(
        "p-4",
        isAnimatingOut ? ACCEPT_OUT_CLASS : ACCEPT_IDLE_CLASS,
        className,
      )}
    >
      <div
        data-testid={`mission-proposal-card-${proposal.id}`}
        data-proposal-id={proposal.id}
        data-mission-id={missionId}
        data-phase={phase}
        data-rationale-truncated={wasTruncated ? "true" : "false"}
        className="flex flex-col gap-3"
      >
        <p
          data-testid="mission-proposal-rationale"
          className="text-sm leading-snug text-foreground line-clamp-3 whitespace-pre-wrap break-words"
          title={truncatedRationale}
        >
          {/* React's default escaping is the only sanitisation layer. */}
          {truncatedRationale}
        </p>

        <div
          data-testid="mission-proposal-diff"
          className="diff-add rounded-md px-2.5 py-1.5"
        >
          <div className="flex items-start gap-2 font-mono text-[12px] leading-snug">
            <span
              aria-hidden="true"
              className="diff-add-marker mt-[1px] inline-flex shrink-0 items-center"
              data-testid="mission-proposal-diff-marker"
            >
              <Plus className="h-3 w-3" />
            </span>
            <span className="min-w-0 break-words text-foreground/90">
              {narrowed.targetType ? `${narrowed.targetType}: ` : null}
              {narrowed.action}
            </span>
          </div>
          {narrowed.summary && (
            <p
              data-testid="mission-proposal-diff-summary"
              className="mt-1 pl-5 text-[11.5px] text-muted-foreground"
            >
              {narrowed.summary}
            </p>
          )}
        </div>

        <div
          data-testid="mission-proposal-trigger"
          className="flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums"
        >
          <span className="inline-flex items-center gap-1">
            <Layers className="h-3 w-3" aria-hidden="true" />
            depth {proposal.depth}
          </span>
          <span aria-hidden="true">·</span>
          <span data-testid="mission-proposal-cost-tokens">
            {fmtTokensLocal(proposal.cost_tokens)} tok
          </span>
          <span aria-hidden="true">·</span>
          <span data-testid="mission-proposal-cost-cents">
            {fmtCentsLocal(proposal.cost_usd_cents)}
          </span>
          {narrowed.targetId && (
            <span
              data-testid="mission-proposal-target-id"
              className="ml-auto truncate font-mono"
              title={narrowed.targetId}
            >
              {narrowed.targetId}
            </span>
          )}
        </div>

        {error && (
          <p
            role="alert"
            data-testid="mission-proposal-error"
            className="text-xs text-destructive"
          >
            {error}
          </p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            data-testid="mission-proposal-accept"
            disabled={isSubmitting || isAnimatingOut}
            onClick={handleAccept}
          >
            Accept
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="mission-proposal-reject"
            disabled={isSubmitting || isAnimatingOut}
            onClick={handleReject}
          >
            Reject
          </Button>
        </div>
      </div>
    </FlatCard>
  );
}

export default ProposalCard;
