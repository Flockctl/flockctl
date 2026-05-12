import * as React from "react";
import { Inbox } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { EmptyState } from "@/components/EmptyState";
import { FlatCard } from "@/components/design/FlatCard";
import { missionQueryKeys, type MissionProposal } from "@/lib/hooks/missions";

import { ProposalCard } from "./ProposalCard";

/**
 * ProposalsQueue — right-column "what's pending operator decision" rail
 * for the mission detail page (slice 24/01 T03).
 *
 * Renders one {@link ProposalCard} per pending proposal; surfaces an
 * empty state with the `Inbox` lucide icon when nothing is waiting.
 *
 * Data flow:
 *
 *   Page mounts
 *     ├─ useMissionProposals(missionId, { status: "pending" })  ← parent query
 *     │     yields MissionProposal[] (rows of kind=remediation_proposed
 *     │     with no later approve/dismiss row pointing back at them)
 *     ├─ ProposalsQueue maps each row → ProposalCard
 *     └─ on Accept / Reject:
 *           ProposalCard fires the POST and invokes the queue's
 *           `onMutated()` callback. The queue invalidates the
 *           `events` + `proposals` query keys so:
 *             • the timeline picks up the new
 *               remediation_approved / remediation_dismissed event
 *             • the proposals list re-fetches and the accepted /
 *               rejected row drops off the queue
 *
 * The cache invalidation is centralised here (not in ProposalCard) so a
 * caller using ProposalCard outside the queue (e.g. inbox surface) can
 * wire its own onSuccess without dragging the queue's invalidation
 * policy along.
 */

export interface ProposalsQueueProps {
  /** Mission this queue belongs to; passed straight through to ProposalCard. */
  missionId: string;
  /**
   * Pending proposals (rows of kind=remediation_proposed). Already
   * filtered by the `useMissionProposals(_, {status: "pending"})` hook
   * server-side; we render in the order received.
   */
  proposals: ReadonlyArray<MissionProposal>;
  /**
   * Optional notify-up callback. Fires after a successful Accept *or*
   * Reject completes (post-animation in the Accept case). Defaults to
   * a react-query invalidation of the mission's events + proposals
   * cache entries — pass an explicit handler to override.
   */
  onMutated?: () => void;
  /** Optional className passthrough on the outer container. */
  className?: string;
}

export function ProposalsQueue({
  missionId,
  proposals,
  onMutated,
  className,
}: ProposalsQueueProps): React.JSX.Element {
  const queryClient = useQueryClient();

  // Default mutation hook: invalidate both the proposals list (so the
  // accepted/rejected card drops off) and the events feed (so the new
  // remediation_approved / _dismissed row lands in the timeline).
  const handleMutated = React.useCallback(() => {
    if (onMutated) {
      onMutated();
      return;
    }
    queryClient.invalidateQueries({
      queryKey: ["missions", missionId, "proposals"],
    });
    queryClient.invalidateQueries({
      queryKey: missionQueryKeys.events(missionId),
    });
  }, [onMutated, queryClient, missionId]);

  if (proposals.length === 0) {
    return (
      <div
        id="proposals-queue"
        data-testid="mission-proposals-queue-empty-card"
        className={className}
      >
        <FlatCard>
          <div className="p-2">
            <EmptyState
              data-testid="mission-proposals-queue-empty"
              icon={Inbox}
              title="No proposals waiting"
              description="The supervisor hasn't filed anything pending operator decision."
            />
          </div>
        </FlatCard>
      </div>
    );
  }

  return (
    <div
      id="proposals-queue"
      data-testid="mission-proposals-queue"
      data-proposal-count={proposals.length}
      className={className}
    >
      <div className="flex flex-col gap-3">
        {proposals.map((p) => (
          <ProposalCard
            key={p.id}
            missionId={missionId}
            proposal={p}
            onAccepted={handleMutated}
            onRejected={handleMutated}
          />
        ))}
      </div>
    </div>
  );
}

export default ProposalsQueue;
