import { useState } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { statusBadge } from "@/components/status-badge";
import { apiFetch } from "@/lib/api/core";

// --- Proposed card (mission-scoped slice board) ---
//
// Renders a single supervisor remediation proposal as a violet-accented card
// in the "Proposed" column of the mission-scoped board variant
// (see DEFAULT_MISSION_COLUMNS). Companion to SliceCard — but proposals
// are mission events, NOT plan-store slices, so this component lives in
// its own file with its own data shape and its own action surface.
//
// Visual anatomy:
//
//   ┌─┬──────────────────────────────────────────┐
//   │ │ [proposed badge]   target_type · slug    │
//   │ │ <rationale, escaped, max 5000 chars>     │
//   │ │ <candidate.action / summary>             │
//   │ │ [Approve]  [Dismiss]  [Edit]             │
//   └─┴──────────────────────────────────────────┘
//     ↑ violet left border (matches the violet status badge)
//
// ─── Security invariants (parent slice.md threat surface §) ───
//
// 1. **NEVER use dangerouslySetInnerHTML.** The supervisor LLM produces the
//    `rationale` and `summary` strings; both are user-attacker-controllable
//    via prompt injection on a quoted task error. We render them as plain
//    text children — React's default escaping is the only sanitisation
//    layer, and it is sufficient because the strings never need to carry
//    markup (the supervisor is constrained by `proposalSchema` which caps
//    rationale at 4000 chars and refuses destructive verbs in
//    candidate.action). If a future iteration wants markdown rendering,
//    that goes through a real allowlist sanitiser, not raw HTML injection.
//
// 2. **Truncate rationale at 5000 chars** before rendering. Defense in depth:
//    `proposalSchema` already caps at 4000, but the wire shape is the
//    `mission_events.payload` JSON which a future migration could relax.
//    Truncating at the render boundary keeps a runaway model reply from
//    blowing past the card's two-line clamp + breaking the column layout.
//
// 3. **Stale approve toast guard.** A double-click on Approve must NOT fire
//    two POSTs (the server is idempotent, but the client should not surface
//    two success toasts for the same decision). We disable the buttons while
//    a request is in flight via `isSubmitting`, and resolve the post-approve
//    state through the `onApproved` callback so the parent can drop the card
//    from the column rather than leaving it in an ambiguous "approved but
//    still rendered" state.
//
// ─── Wire shape ───
//
// The proposal mission-event payload (see `src/services/missions/proposal-schema.ts`)
// shapes up as:
//
//   {
//     rationale: string,                     // ≤ 4000 chars (we truncate at 5000 for safety)
//     proposal: {
//       target_type: "milestone" | "slice" | "task",
//       candidate: {
//         action: string,                    // verb-phrase, ≤ 500 chars
//         target_id?: string,                // parent slug
//         summary?: string,                  // optional elaboration
//       },
//     },
//   }
//
// The card flattens that into props rather than accepting the raw event so
// callers (the SliceBoard "Proposed" column, future inbox surface) can hand
// in already-validated data without re-walking the JSON path each render.
//
// ─── Endpoints ───
//
// Approve:  POST /missions/:missionId/proposals/:proposalId/approve
// Dismiss:  POST /missions/:missionId/proposals/:proposalId/dismiss
//             body: { reason?: string }
//
// Both endpoints are idempotent on the server (return same decision_id on
// retry) — see `src/routes/missions.ts`.

/** Hard cap applied at the render boundary. Defense in depth for the 4000
 * char zod cap in `proposalSchema.rationale`. */
export const RATIONALE_MAX_CHARS = 5000;

/** Cosmetic ellipsis appended when truncation kicks in. Exported so tests
 * can assert against it without re-deriving the suffix string. */
export const RATIONALE_TRUNCATE_SUFFIX = "…";

/** Visible suffix when the rationale exceeds RATIONALE_MAX_CHARS. */
function truncateRationale(rationale: string): string {
  if (rationale.length <= RATIONALE_MAX_CHARS) return rationale;
  // Slice to MAX-1 so the overall string with the ellipsis is still
  // bounded — RATIONALE_MAX_CHARS is the visible-character budget.
  return rationale.slice(0, RATIONALE_MAX_CHARS - 1) + RATIONALE_TRUNCATE_SUFFIX;
}

export type ProposalTargetType = "milestone" | "slice" | "task";

export interface ProposedCardProps {
  /** Mission this proposal belongs to. Forms the URL prefix for both
   * approve / dismiss POSTs. */
  missionId: string;
  /** Proposal event id (= `mission_events.id` of the kind='remediation_proposed'
   * row). Forms the URL suffix. */
  proposalId: string;
  /** Operator-facing "why?" string. Rendered as plain text — see security
   * invariant §1 above. Truncated at RATIONALE_MAX_CHARS. */
  rationale: string;
  /** Discriminator that drives the entity the approve handler will create
   * server-side. Shown in the card header so operators can tell at a glance
   * whether they are about to mint a milestone, a slice, or a task. */
  targetType: ProposalTargetType;
  /** Candidate verb-phrase from the supervisor (`candidate.action`). The
   * approve handler uses this as the entity title. */
  candidateAction: string;
  /** Optional elaboration (`candidate.summary`) — when present, shown under
   * the action text in muted size. */
  candidateSummary?: string | null;
  /** Optional parent pointer (`candidate.target_id`) — slug of the parent
   * milestone (slice target_type) or slice (task target_type). Surfaced in
   * the header so operators can verify the proposal is wired against the
   * right parent before approving. */
  candidateTargetId?: string | null;
  /** Fires AFTER a successful approve POST. Parents typically remove the
   * card from the proposed column on this signal. The decision id from
   * the server is forwarded so callers can correlate timeline rows. */
  onApproved?: (decisionId: string) => void;
  /** Fires AFTER a successful dismiss POST (with the operator-supplied
   * reason if any). Same removal semantics as `onApproved`. */
  onDismissed?: (decisionId: string, reason: string | null) => void;
  /** Click handler for the Edit button. The card itself does not own the
   * edit dialog — when omitted the Edit button is hidden so a caller that
   * has not yet wired an editor doesn't show a non-functional control. */
  onEdit?: () => void;
  /** Optional injection point for tests / future inbox UIs to override the
   * fetcher. Defaults to `apiFetch`. */
  fetcher?: typeof apiFetch;
  /** Optional injection point for the dismiss reason prompt. Defaults to
   * `window.prompt`. Tests stub this to avoid jsdom's blocking prompt. */
  promptReason?: (message: string) => string | null;
  /** Optional extra classes merged onto the card root. */
  className?: string;
}

interface ApproveResponse {
  decision_id: string;
  // ...other server fields ignored at this layer.
}

interface DismissResponse {
  decision_id: string;
}

export function ProposedCard({
  missionId,
  proposalId,
  rationale,
  targetType,
  candidateAction,
  candidateSummary,
  candidateTargetId,
  onApproved,
  onDismissed,
  onEdit,
  fetcher = apiFetch,
  promptReason,
  className,
}: ProposedCardProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const truncatedRationale = truncateRationale(rationale);
  const wasTruncated = rationale.length > RATIONALE_MAX_CHARS;

  const handleApprove = async () => {
    if (isSubmitting) return; // stale-approve-toast guard
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetcher<ApproveResponse>(
        `/missions/${missionId}/proposals/${proposalId}/approve`,
        { method: "POST" },
      );
      onApproved?.(res.decision_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDismiss = async () => {
    if (isSubmitting) return;
    const ask = promptReason ?? ((msg: string) => window.prompt(msg));
    const reasonRaw = ask("Reason for dismissing this proposal? (optional)");
    // User hit Cancel — do nothing.
    if (reasonRaw === null) return;
    const reason = reasonRaw.trim().length === 0 ? null : reasonRaw.trim();

    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetcher<DismissResponse>(
        `/missions/${missionId}/proposals/${proposalId}/dismiss`,
        {
          method: "POST",
          body: JSON.stringify(reason !== null ? { reason } : {}),
        },
      );
      onDismissed?.(res.decision_id, reason);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dismiss failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card
      size="sm"
      data-testid="proposed-card"
      data-proposal-id={proposalId}
      data-mission-id={missionId}
      data-target-type={targetType}
      className={cn(
        "border-l-[3px] border-l-violet-500 transition-colors",
        className,
      )}
    >
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          {statusBadge("proposed")}
          <div
            className="flex items-center gap-1 text-xs text-muted-foreground"
            data-testid="proposed-card-target"
          >
            <Badge variant="outline" className="text-[10px] uppercase">
              {targetType}
            </Badge>
            {candidateTargetId ? (
              <span
                className="truncate font-mono"
                title={candidateTargetId}
                data-testid="proposed-card-target-id"
              >
                {candidateTargetId}
              </span>
            ) : null}
          </div>
        </div>

        <p
          className="text-sm leading-snug text-foreground line-clamp-3 whitespace-pre-wrap break-words"
          data-testid="proposed-card-rationale"
          data-rationale-truncated={wasTruncated ? "true" : "false"}
          title={truncatedRationale}
        >
          {/* React escapes the rationale by default — NEVER replace this
           * with dangerouslySetInnerHTML. See file header §1. */}
          {truncatedRationale}
        </p>

        <div
          className="flex flex-col gap-0.5 text-xs"
          data-testid="proposed-card-candidate"
        >
          <span
            className="font-medium text-foreground line-clamp-2"
            title={candidateAction}
          >
            {candidateAction}
          </span>
          {candidateSummary ? (
            <span
              className="text-muted-foreground line-clamp-2"
              data-testid="proposed-card-candidate-summary"
              title={candidateSummary}
            >
              {candidateSummary}
            </span>
          ) : null}
        </div>

        {error ? (
          <p
            role="alert"
            data-testid="proposed-card-error"
            className="text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="default"
            data-testid="proposed-card-approve"
            disabled={isSubmitting}
            onClick={handleApprove}
          >
            Approve
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-testid="proposed-card-dismiss"
            disabled={isSubmitting}
            onClick={handleDismiss}
          >
            Dismiss
          </Button>
          {onEdit ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-testid="proposed-card-edit"
              disabled={isSubmitting}
              onClick={onEdit}
            >
              Edit
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default ProposedCard;
