import * as React from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { apiFetch } from "../api/core";
import type { ConnectionState, WSMessage } from "../ws";
import { useGlobalWs } from "./global-ws";

/**
 * Mission domain types + react-query wrappers.
 *
 * Keeping the API surface (`fetchMission`, `fetchMissions`) and the hook
 * layer (`useMission`, `useMissions`) in one file because the shape is
 * intentionally narrow — the supervisor side ships its own router
 * (`src/routes/missions.ts`) and this file only needs the read-side calls
 * the project-detail tree panel uses to render the new mission node.
 *
 * Cache contract (slice 11/04 — "use_mission_hook_reads_and_caches"):
 *
 *   - `useMission(id)`   → keyed by `["missions", id]`
 *   - `useMissions(pid)` → keyed by `["missions", "project", pid]`
 *
 *   Two independent components reading the SAME id (or the SAME projectId)
 *   share the exact same query-cache entry, so mounting the tree panel
 *   alongside any future mission-detail rail will not fan out a second
 *   request. The default react-query staleTime applies — we deliberately
 *   do NOT set it here so a project-wide invalidation (issued by a future
 *   create / patch mutation) refetches both views in lockstep.
 *
 * Why the API and hooks share a file:
 *   The mission read surface is small (two GETs) and the hook is a thin
 *   wrapper around the fetcher. Splitting into `lib/api/missions.ts` +
 *   `lib/hooks/missions.ts` would double the import graph for almost no
 *   reuse — none of the mission api functions are called outside hooks.
 *   If the surface grows (mutations, SSE, mission events) we can split
 *   then; the public exports stay stable.
 */

// ─── Domain types ──────────────────────────────────────────────────────────
//
// Wire shape after `apiFetch` runs its camelCase→snake_case conversion on
// the response (and string-coerces any `*_id` numeric column). The router
// in `src/routes/missions.ts` returns the drizzle row in camelCase; the
// shared `apiFetch` helper rewrites the keys, so consumers always see the
// snake_case form aligned with the rest of the UI types (Project,
// Milestone, …).

export type MissionStatus =
  | "drafting"
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "aborted";

export type MissionAutonomy = "manual" | "suggest" | "auto";

export interface Mission {
  /** UUID-ish slug — string after `apiFetch`'s id-coercion pass. */
  id: string;
  /** FK to projects.id; coerced to string by the api-layer key converter. */
  project_id: string;
  objective: string;
  status: MissionStatus;
  autonomy: MissionAutonomy;
  budget_tokens: number;
  budget_usd_cents: number;
  spent_tokens: number;
  spent_usd_cents: number;
  supervisor_prompt_version: string;
  created_at: number;
  updated_at: number;
}

/**
 * List response for `GET /projects/:id/missions`. The router returns a
 * `{ items }` envelope (not a bare array) so a future addition of pagination
 * does not break clients.
 */
export interface MissionsListResponse {
  items: Mission[];
}

/**
 * Mutable subset of `Mission`. Mirrors `updateSchema` in
 * `src/routes/missions.ts` — the router accepts any combination of these
 * fields (at least one required) and rejects unknown keys with `.strict()`.
 *
 * `autonomy: 'auto'` is grammatically valid here but the server returns 501
 * (slice §04 gate). The dialog disables the option client-side; this type
 * still admits it so callers receive the same 501 surface if forced.
 */
export interface MissionUpdate {
  objective?: string;
  autonomy?: MissionAutonomy;
  status?: MissionStatus;
  budget_tokens?: number;
  budget_usd_cents?: number;
}

/**
 * Wire shape for a `mission_events` row of kind `remediation_proposed` (or
 * any timeline event we surface through the proposals endpoint). `payload`
 * is decoded JSON — the router runs `JSON.parse` server-side so the consumer
 * never sees the raw string.
 *
 * The shape is intentionally loose on `payload` (`unknown`) because the
 * parent slice §04 supervisor schema may evolve — the proposal-list view
 * cares about `id`, `kind`, `created_at`, and surfaces `payload` to a
 * detail rail that does its own narrowing.
 */
export interface MissionProposal {
  id: string;
  mission_id: string;
  kind: string;
  payload: unknown;
  cost_tokens: number;
  cost_usd_cents: number;
  depth: number;
  created_at: number;
}

/** Closed filter set accepted by `GET /missions/:id/proposals?status=…`. */
export type ProposalStatusFilter = "pending" | "dismissed" | "all";

/**
 * `{ items }` envelope returned by the proposals endpoint. `total` is the
 * filtered count (not the unfiltered all-proposals count); `status` echoes
 * back the resolved filter so the consumer can disambiguate "default
 * pending" from an explicit `?status=pending`.
 */
export interface MissionProposalsResponse {
  items: MissionProposal[];
  total: number;
  status: ProposalStatusFilter;
}

// ─── Query keys ────────────────────────────────────────────────────────────
//
// Exported so a caller writing into the cache directly (optimistic update,
// test setup) doesn't have to reconstruct the key shape by hand.

export const missionQueryKeys = {
  all: ["missions"] as const,
  byId: (id: string) => ["missions", id] as const,
  byProject: (projectId: string) => ["missions", "project", projectId] as const,
  proposals: (id: string, status: ProposalStatusFilter) =>
    ["missions", id, "proposals", status] as const,
  events: (id: string) => ["missions", id, "events"] as const,
};

// ─── Mission events (timeline) types ───────────────────────────────────────
//
// Wire shape for a single `mission_events` row, as returned by
// `GET /missions/:id/events`. The router emits camelCase + decoded payload;
// `apiFetch` rewrites keys to snake_case before this type is exposed.
//
// Why we re-declare instead of reusing `MissionProposal`:
//   `MissionProposal` is intentionally narrowed to the proposals surface
//   (`payload` is a `Proposal` shape consumers narrow further). The
//   timeline view needs the full set of kinds (`task_observed`,
//   `remediation_proposed`, `no_action`, `parse_error`, …) and treats
//   payload opaquely — keeping the two types separate keeps the consumer
//   layers honest.

export interface MissionEvent {
  id: string;
  mission_id: string;
  kind: string;
  payload: unknown;
  cost_tokens: number;
  cost_usd_cents: number;
  depth: number;
  created_at: number;
}

/** Shape of `GET /missions/:id/events` after `apiFetch` key conversion. */
export interface MissionEventsResponse {
  items: MissionEvent[];
  total: number;
  page: number;
  per_page: number;
}

/**
 * Wire shape of the `mission_event` envelope `wsManager.broadcastAll` sends
 * from `SupervisorService.evaluate()`. WS frames bypass `apiFetch` so the
 * keys stay camelCase — this is the only place in the UI that consumes
 * raw camelCase off the socket.
 *
 * See `src/services/missions/supervisor.ts` (`SUPERVISOR_BROADCAST_TYPE`).
 */
export interface MissionEventEnvelope {
  type: "mission_event";
  missionId: string;
  kind: string;
  eventId: string;
  depth: number;
}

// ─── API fetchers ──────────────────────────────────────────────────────────

export function fetchMission(id: string): Promise<Mission> {
  return apiFetch<Mission>(`/missions/${id}`);
}

/**
 * List missions for a project. Hits `/projects/:projectId/missions`.
 * The endpoint returns the missions in `created_at DESC` order; downstream
 * consumers (the tree panel, the mission picker) preserve that order so
 * the most-recent mission lands at the top of any list rendering.
 */
export function fetchMissions(
  projectId: string,
): Promise<MissionsListResponse> {
  return apiFetch<MissionsListResponse>(`/projects/${projectId}/missions`);
}

/**
 * PATCH a mission row. The router accepts a partial update and returns the
 * fully-updated row, so the mutation `onSuccess` can swap the cache entry
 * directly (avoiding a second GET).
 *
 * Note: when the operator selects `autonomy: 'auto'`, the server returns
 * 501 — the caller surfaces the resulting `Error` through `mutate`'s
 * `onError`. We do NOT short-circuit client-side because the dialog
 * already disables the option; if a custom call still forces it, the
 * 501 is the correct, observable signal.
 */
export function updateMission(id: string, patch: MissionUpdate): Promise<Mission> {
  return apiFetch<Mission>(`/missions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/**
 * List proposals (events of kind `remediation_proposed`) for a mission.
 * The default `status=pending` matches the server-side default — operators
 * scrolling the approval queue almost always want "what's left to act on".
 */
export function fetchMissionProposals(
  missionId: string,
  status: ProposalStatusFilter,
): Promise<MissionProposalsResponse> {
  const qs = `?status=${encodeURIComponent(status)}`;
  return apiFetch<MissionProposalsResponse>(
    `/missions/${missionId}/proposals${qs}`,
  );
}

/**
 * First page of the mission timeline. The router caps `per_page` at
 * 1000/page (vs. the global 100/page default) — see
 * `src/routes/missions.ts` `EVENTS_MAX_PER_PAGE`. We ask for 200 here:
 * enough to seed the supervisor log tab without an obvious "load more"
 * gap on most missions, while keeping the response under a kilobyte
 * for typical event payloads.
 */
export function fetchMissionEvents(
  missionId: string,
  perPage = 200,
): Promise<MissionEventsResponse> {
  const qs = `?per_page=${perPage}`;
  return apiFetch<MissionEventsResponse>(
    `/missions/${missionId}/events${qs}`,
  );
}

// ─── Hooks ─────────────────────────────────────────────────────────────────

/**
 * Read a single mission row by id.
 *
 * `enabled: !!id` skips the query when the caller passes an empty string —
 * keeps the mission-detail panel from firing a request before its URL
 * param has been resolved. Pass `enabled: false` via `options` to suppress
 * the fetch in tests.
 */
export function useMission(
  id: string,
  options?: Partial<UseQueryOptions<Mission>>,
) {
  return useQuery<Mission>({
    queryKey: missionQueryKeys.byId(id),
    queryFn: () => fetchMission(id),
    enabled: !!id,
    ...options,
  });
}

/**
 * List all missions for a project. Used by `ProjectTreePanel` to render the
 * mission node above its child milestones, and by the mission-picker
 * surface (slice 11/05) to populate the new-milestone form's dropdown.
 *
 * Same `enabled: !!projectId` guard as `useMission` so the tree panel does
 * not over-fetch on a project-detail mount that has not yet resolved its
 * `:id` route param.
 */
export function useMissions(
  projectId: string,
  options?: Partial<UseQueryOptions<MissionsListResponse>>,
) {
  return useQuery<MissionsListResponse>({
    queryKey: missionQueryKeys.byProject(projectId),
    queryFn: () => fetchMissions(projectId),
    enabled: !!projectId,
    ...options,
  });
}

/**
 * List proposals for a mission, filtered by lifecycle status. The default
 * filter is `pending` — see `fetchMissionProposals` for the rationale.
 *
 * Cache key includes the resolved filter, so switching from `pending` to
 * `dismissed` (or `all`) does not collapse the two views into one cache
 * entry — they share the same network surface but have independent staleness.
 *
 * `enabled: !!missionId` mirrors the guard on `useMission` so the
 * proposal panel can mount before its parent route param resolves without
 * firing a request against `/missions//proposals`.
 */
export function useMissionProposals(
  missionId: string,
  options: { status?: ProposalStatusFilter } & Partial<
    UseQueryOptions<MissionProposalsResponse>
  > = {},
) {
  const { status = "pending", ...queryOptions } = options;
  return useQuery<MissionProposalsResponse>({
    queryKey: missionQueryKeys.proposals(missionId, status),
    queryFn: () => fetchMissionProposals(missionId, status),
    enabled: !!missionId,
    ...queryOptions,
  });
}

/**
 * PATCH a mission, then invalidate the per-id and per-project cache entries
 * so any open mission-detail rail and the project tree both refresh. Update
 * also refreshes the proposals listing — supervisor-driven proposals can
 * become stale when an operator pauses or aborts a mission.
 */
export function useUpdateMission(missionId: string) {
  const queryClient = useQueryClient();
  return useMutation<Mission, Error, MissionUpdate>({
    mutationFn: (patch) => updateMission(missionId, patch),
    onSuccess: (row) => {
      // Swap the per-id cache entry with the fresh row to avoid a second GET.
      queryClient.setQueryData(missionQueryKeys.byId(missionId), row);
      // Per-project list may sort/filter on mutated fields — invalidate.
      queryClient.invalidateQueries({
        queryKey: missionQueryKeys.byProject(row.project_id),
      });
      queryClient.invalidateQueries({
        queryKey: ["missions", missionId, "proposals"],
      });
    },
  });
}

// ─── useMissionEvents ──────────────────────────────────────────────────────
//
// Live timeline for the supervisor log tab. Two data sources stitched
// together:
//
//   1. Initial fetch via react-query (`GET /missions/:id/events`) — seeds
//      the buffer with the most-recent N events on mount.
//   2. Live `mission_event` envelopes off the global WebSocket. Each frame
//      is appended to a per-mount RAF buffer; once per animation frame we
//      flush the buffer into React state. This is the "RAF coalescing"
//      pattern called out by parent slice 10/05 — a 100-event burst lands
//      as ONE setState (and therefore ONE re-render) rather than 100, so a
//      heavy supervisor run does not drop a 60fps scroll.
//
// Reconnect handling:
//   On WS reconnect (state transitions back to "open"), we invalidate the
//   query so the canonical timeline is re-fetched — frames sent while the
//   socket was down are not replayed by the server, and the optimistic
//   appended-from-WS rows would diverge from the DB otherwise. The fresh
//   query result REPLACES the local buffer, which keeps the list aligned
//   with `created_at DESC` ordering coming off the server.
//
// Why we synthesize a partial event row from the envelope instead of
// re-fetching on every frame:
//   The envelope only carries `{eventId, kind, depth}` — not payload, not
//   cost, not created_at. Re-fetching per envelope would make a 100-event
//   burst issue 100 GETs, which is exactly the antipattern this hook
//   exists to avoid. The synthesized row fills `created_at` with `now`
//   (close enough for log-tab UX; the canonical value lands on the next
//   reconnect-driven invalidation), `payload` with `null`, and the cost
//   columns with 0. Consumers that need the full payload can query the
//   single event row by id — but the supervisor log tab only renders
//   `kind + depth + ts`, and that's what the envelope already carries.

export interface UseMissionEventsResult {
  /** Newest-first timeline. Same ordering as `GET /events?per_page=N`. */
  events: MissionEvent[];
  isLoading: boolean;
  error: unknown;
  /** Live WS connection state for the mission_event channel. */
  connectionState: ConnectionState;
}

/**
 * Schedule a callback to run on the next animation frame, with a setTimeout
 * fallback for environments without `requestAnimationFrame` (jsdom).
 *
 * Returning a typed `cancel` lets the caller abort a pending flush when
 * its mount unmounts mid-frame.
 */
function scheduleFrame(cb: () => void): { cancel: () => void } {
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame })
      .requestAnimationFrame === "function"
  ) {
    const id = requestAnimationFrame(cb);
    return {
      cancel: () => cancelAnimationFrame(id),
    };
  }
  /* v8 ignore next 4 — jsdom polyfills RAF in our test setup, so this
     fallback is defensive only. */
  const id = setTimeout(cb, 16);
  return {
    cancel: () => clearTimeout(id as unknown as number),
  };
}

/**
 * Synthesize a `MissionEvent` row from a live WS envelope. See header
 * comment for why we do this instead of re-fetching the row.
 */
function envelopeToEvent(env: MissionEventEnvelope): MissionEvent {
  return {
    id: env.eventId,
    mission_id: env.missionId,
    kind: env.kind,
    payload: null,
    cost_tokens: 0,
    cost_usd_cents: 0,
    depth: env.depth,
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Runtime narrow for `mission_event` envelopes. WS frames bypass
 * `apiFetch` so the check has to validate camelCase keys directly.
 *
 * `useGlobalWs` types the callback arg as `WSMessage` (`{type, payload}`),
 * but the supervisor broadcaster ships fields at the TOP LEVEL of the
 * frame (no `payload` wrapper) and uses `type: "mission_event"` which is
 * not in the shared `MessageType` enum — so we narrow off the literal
 * `type` plus the presence of `missionId`/`eventId`/`kind`/`depth`.
 *
 * Returns the parsed envelope (or null) instead of using a type predicate
 * because `MessageType` doesn't include `"mission_event"` and a `msg is X`
 * predicate would falsely narrow the rest of the codebase's WS handlers.
 */
function parseMissionEventEnvelope(
  msg: WSMessage,
): MissionEventEnvelope | null {
  const m = msg as unknown as Partial<MissionEventEnvelope> & {
    type?: string;
  };
  if (
    m.type === "mission_event" &&
    typeof m.missionId === "string" &&
    typeof m.kind === "string" &&
    typeof m.eventId === "string" &&
    typeof m.depth === "number"
  ) {
    return {
      type: "mission_event",
      missionId: m.missionId,
      kind: m.kind,
      eventId: m.eventId,
      depth: m.depth,
    };
  }
  return null;
}

/**
 * Live mission timeline. Combines an initial GET with a RAF-coalesced WS
 * stream. See header comment block above for the design rationale.
 */
export function useMissionEvents(missionId: string): UseMissionEventsResult {
  const queryClient = useQueryClient();
  const queryKey = missionQueryKeys.events(missionId);

  const { data, isLoading, error } = useQuery<MissionEventsResponse>({
    queryKey,
    queryFn: () => fetchMissionEvents(missionId),
    enabled: !!missionId,
  });

  // Live buffer. We keep a ref-of-pending-events + a state-of-committed
  // events so the WS callback can append at high frequency without
  // forcing a re-render per frame — a single rAF flush moves the buffer
  // into the React tree.
  const pendingRef = React.useRef<MissionEvent[]>([]);
  const frameRef = React.useRef<{ cancel: () => void } | null>(null);
  const seenIdsRef = React.useRef<Set<string>>(new Set());
  const [liveEvents, setLiveEvents] = React.useState<MissionEvent[]>([]);

  // Re-seed `seenIdsRef` whenever the canonical query result changes —
  // we don't want a duplicate row when the WS envelope arrives AFTER its
  // canonical row already landed via a refetch.
  React.useEffect(() => {
    if (!data) return;
    const set = seenIdsRef.current;
    for (const ev of data.items) set.add(ev.id);
    // Drop overlay events that the canonical fetch already covers — the
    // live overlay is only for rows strictly newer than the latest GET.
    setLiveEvents((prev) => prev.filter((ev) => !set.has(ev.id)));
  }, [data]);

  const flush = React.useCallback(() => {
    frameRef.current = null;
    if (pendingRef.current.length === 0) return;
    const incoming = pendingRef.current;
    pendingRef.current = [];
    setLiveEvents((prev) => {
      // De-dupe by event id. The seen set is updated as we go.
      const out = [...prev];
      for (const ev of incoming) {
        if (seenIdsRef.current.has(ev.id)) continue;
        seenIdsRef.current.add(ev.id);
        out.unshift(ev); // newest-first
      }
      return out;
    });
  }, []);

  const handleMessage = React.useCallback(
    (msg: WSMessage) => {
      const env = parseMissionEventEnvelope(msg);
      if (env === null) return;
      if (env.missionId !== missionId) return;
      pendingRef.current.push(envelopeToEvent(env));
      if (frameRef.current === null) {
        frameRef.current = scheduleFrame(flush);
      }
    },
    [missionId, flush],
  );

  const { state: connectionState } = useGlobalWs(handleMessage, !!missionId);

  // Reconnect refresh: when the socket transitions back to `open`, we
  // invalidate the query so the freshly-resumed timeline displaces any
  // optimistic-from-WS rows we may have appended before the disconnect.
  const prevState = React.useRef(connectionState);
  React.useEffect(() => {
    if (prevState.current !== "open" && connectionState === "open") {
      queryClient.invalidateQueries({ queryKey });
    }
    prevState.current = connectionState;
  }, [connectionState, queryClient, queryKey]);

  // Cancel any pending RAF on unmount so a stale flush can't fire after
  // teardown (would be a no-op via React's setState guards, but the
  // cancel keeps the test environment clean).
  React.useEffect(() => {
    return () => {
      frameRef.current?.cancel();
      frameRef.current = null;
    };
  }, []);

  // Compose the canonical fetch (newest-first via the router's
  // `created_at DESC`) with the live overlay. `liveEvents` is also
  // newest-first (we `unshift` on flush), so concatenation preserves the
  // ordering invariant.
  const events = React.useMemo<MissionEvent[]>(() => {
    const fetched = data?.items ?? [];
    if (liveEvents.length === 0) return fetched;
    return [...liveEvents, ...fetched];
  }, [data, liveEvents]);

  return { events, isLoading, error, connectionState };
}
