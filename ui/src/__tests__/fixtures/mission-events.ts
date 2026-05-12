import type { MissionEvent } from "@/lib/hooks/missions";

/**
 * Fixtures for the mission events feed (slice 24/01 T02).
 *
 * One example event per `MissionEventKind` variant declared in the slice
 * goal-block. The 9 kinds enumerated here are the renderer's first-class
 * citizens — each one carries the realistic body fields the per-kind
 * renderer narrows on (objective for `mission_started`, summary +
 * output_excerpt for `task_observed`, etc.).
 *
 * Why these 9 (and not the full 13-kind canonical set documented in
 * `slice.md ## Audit findings`):
 *   The slice's goal-block is the contract this task implements. The
 *   audit exposes that several of the names on the goal-block (e.g.
 *   `proposal_filed` vs the canonical `remediation_proposed`) differ
 *   from what production currently emits. The renderer treats unknown
 *   kinds via a `console.warn` fallback row — so when the canonical
 *   names land they will degrade gracefully until the renderer is
 *   updated to recognise them. Adding the canonical names later is a
 *   one-entry-per-line edit to `MissionEventRow.tsx`'s `KIND_RENDERERS`
 *   table.
 *
 * Timestamps are deliberately spread across three calendar days so the
 * day-grouping test can assert three sticky day-headers off the same
 * fixture array.
 *
 *   - day -2 (oldest): mission_started, task_observed
 *   - day -1: proposal_filed, proposal_accepted, proposal_rejected
 *   - day 0 (newest): budget_warning, budget_exceeded, depth_warning,
 *     mission_completed
 *
 * Each row uses `Math.floor(epochMs / 1000)` because the wire shape
 * carries Unix seconds (see `src/db/schema.ts` for `mission_events.created_at`).
 */

/** Stable reference time so tests can assert on exact day boundaries. */
export const FIXTURE_NOW_MS = new Date("2026-05-07T14:00:00Z").getTime();

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NOW_S = Math.floor(FIXTURE_NOW_MS / 1000);

/** Common scaffolding so each fixture only declares the per-kind delta. */
function row(
  kind: string,
  payload: unknown,
  offsetSec: number,
  overrides: Partial<MissionEvent> = {},
): MissionEvent {
  return {
    id: `evt-${kind}-${offsetSec}`,
    mission_id: "M-002",
    kind,
    payload,
    cost_tokens: 0,
    cost_usd_cents: 0,
    depth: 0,
    created_at: NOW_S - offsetSec,
    ...overrides,
  };
}

export const missionStartedFixture: MissionEvent = row(
  "mission_started",
  {
    objective:
      "Stand up a Drizzle migration for chat attachments so M04 can ship.",
  },
  2 * DAY,
);

export const taskObservedFixture: MissionEvent = row(
  "task_observed",
  {
    task_id: "T-021",
    summary: "Add 0027_add_chat_attachments migration",
    output_excerpt:
      "applied migration 0027_add_chat_attachments.sql; 3 statements OK",
    status: "completed",
  },
  2 * DAY - 1 * HOUR,
  { cost_tokens: 1240, cost_usd_cents: 18, depth: 1 },
);

export const proposalFiledFixture: MissionEvent = row(
  "proposal_filed",
  {
    proposal_event_id: "evt-proposal-99",
    candidate: {
      action: "create slice 02 — chat attachment upload pipeline",
      target_type: "slice",
    },
    rationale:
      "T-021 finished cleanly; the next blocker for M04 is the upload pipeline (slice 02). Filing this so the operator can approve it.",
  },
  1 * DAY,
  { cost_tokens: 4520, cost_usd_cents: 72, depth: 2 },
);

export const proposalAcceptedFixture: MissionEvent = row(
  "proposal_accepted",
  {
    proposal_event_id: "evt-proposal-99",
    action: "create slice 02 — chat attachment upload pipeline",
    target_id: "S-04-02",
  },
  1 * DAY - 30 * MINUTE,
);

export const proposalRejectedFixture: MissionEvent = row(
  "proposal_rejected",
  {
    proposal_event_id: "evt-proposal-100",
    reason:
      "Operator decision: ship the upload pipeline before the picker UI; this proposal is out of order.",
  },
  1 * DAY - 1 * HOUR,
);

export const budgetWarningFixture: MissionEvent = row(
  "budget_warning",
  {
    pct_used: 78,
    spent_usd_cents: 390,
    budget_usd_cents: 500,
    projected_exhaust_at: NOW_S + 4 * HOUR,
  },
  3 * HOUR,
);

export const budgetExceededFixture: MissionEvent = row(
  "budget_exceeded",
  {
    spent_tokens: 530000,
    spent_usd_cents: 540,
    budget_tokens: 500000,
    budget_usd_cents: 500,
    halt_reason:
      "Projected token spend exceeded the configured cap; mission auto-paused.",
  },
  90 * MINUTE,
);

export const depthWarningFixture: MissionEvent = row(
  "depth_warning",
  {
    depth: 4,
    max_depth: 5,
    recursion_path: ["heartbeat", "task_observed", "remediation", "remediation"],
  },
  45 * MINUTE,
);

export const missionCompletedFixture: MissionEvent = row(
  "mission_completed",
  {
    summary:
      "All 4 slices of M04 landed; CI green; mission objective met.",
    spent_tokens: 482310,
    spent_usd_cents: 470,
  },
  10 * MINUTE,
);

/**
 * Fallback / unknown-kind fixture. The renderer must NOT crash on an
 * unrecognised kind — it should fall through to the neutral fallback
 * row and emit a `console.warn`. Useful for the forward-compat test.
 */
export const unknownKindFixture: MissionEvent = row(
  "remediation_proposed", // canonical kind not in the goal-block 9
  { kind: "remediation_proposed", note: "real-world canonical kind" },
  5 * MINUTE,
);

/**
 * The 9 first-class fixtures, newest-first (matches the wire ordering
 * coming off `GET /missions/:id/events?per_page=N` and `useMissionEvents`).
 *
 * Tests that need only the table-driven 9 can map over this array; tests
 * that exercise unknown-kind fallback append `unknownKindFixture` themselves.
 */
export const missionEventFixtures: ReadonlyArray<MissionEvent> = [
  missionCompletedFixture,
  depthWarningFixture,
  budgetExceededFixture,
  budgetWarningFixture,
  proposalRejectedFixture,
  proposalAcceptedFixture,
  proposalFiledFixture,
  taskObservedFixture,
  missionStartedFixture,
];

/** All fixtures including the unknown-kind one, used by virtualization tests. */
export const allMissionEventFixtures: ReadonlyArray<MissionEvent> = [
  unknownKindFixture,
  ...missionEventFixtures,
];
