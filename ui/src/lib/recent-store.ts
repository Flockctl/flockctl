import { useEffect, useSyncExternalStore } from "react";

/**
 * Recent / pinned navigation list — the model behind the shell's
 * sidebar `RECENT` group.
 *
 * Storage shape on disk (`localStorage["flockctl.recent"]`):
 *
 * ```jsonc
 * {
 *   "v": 1,
 *   "items": [
 *     {
 *       "kind":   "project",
 *       "id":     "abc-123",
 *       "label":  "my-app",
 *       "href":   "/projects/abc-123",
 *       "pinned": true,
 *       "ts":     1714789200000
 *     }
 *   ]
 * }
 * ```
 *
 * Invariants:
 *   - The store key lives under the `flockctl.*` namespace.
 *   - Items are de-duped by `id` — re-tracking the same id refreshes
 *     `ts` (and updates `label`/`href` if they changed).
 *   - Cap of `RECENT_MAX = 5` applies to non-pinned items only. Pinned
 *     items survive eviction. Oldest non-pinned item is evicted first
 *     when the cap is exceeded.
 *   - The store survives an empty/corrupt localStorage payload by
 *     resetting to an empty list — never throws on read.
 *   - Vanilla pub/sub backed by `useSyncExternalStore`, mirroring
 *     `code-mode/tab-store.ts` so we don't drag a state-management
 *     dependency into the bundle just for this.
 *
 * Test seam: `recentStore.__resetForTests()` clears state and storage.
 */

export const RECENT_KEY = "flockctl.recent";
export const RECENT_MAX = 5;

export type RecentKind =
  | "project"
  | "workspace"
  | "chat"
  | "task"
  | "mission"
  | "incident"
  | "schedule"
  | "template";

export interface RecentItem {
  /** Logical type of the entity being tracked — drives the icon shown. */
  kind: RecentKind;
  /**
   * Stable id within `kind`. Two items with the same `id` but different
   * `kind`s are distinct. We do not enforce kind+id uniqueness on input —
   * callers are expected to use a single `id` per entity.
   */
  id: string;
  /** Human-readable label rendered in the sidebar row. */
  label: string;
  /** Click target — must be an internal SPA path. */
  href: string;
  /** True when the user explicitly pinned this row. */
  pinned?: boolean;
  /**
   * Last-touched timestamp (ms). Updated on every `track()` call.
   * Used both for the eviction order (oldest non-pinned first) and
   * for visual sort within `list()`.
   */
  ts: number;
}

interface PersistedState {
  v: 1;
  items: RecentItem[];
}

const SCHEMA_VERSION = 1;

const listeners = new Set<() => void>();
let state: RecentItem[] = [];
let snapshot: ReadonlyArray<RecentItem> = [];
// Pre-sorted `list()` output cached and refreshed on every emit(). Previously
// `list()` ran two `filter` passes + sort + spread on every consumer call —
// `useSyncExternalStore` consumers call `getSnapshot` on every render so the
// cost added up on busy pages.
let listSnapshot: ReadonlyArray<RecentItem> = [];
let hydrated = false;
/**
 * Monotonic per-track counter. We previously used raw `Date.now()` for
 * `ts` and learnt the hard way that several tracks within the same
 * millisecond produced duplicate timestamps, making eviction order
 * non-deterministic. The counter is mixed into `ts` (`Date.now()` is
 * still the dominant component for cross-process ordering) so ties
 * are impossible within a single process and the eviction order of
 * `track(track(...))` calls in the same millisecond is the insertion
 * order, just like a human would expect.
 */
let trackSeq = 0;
function nextTs(): number {
  // 13-digit `Date.now()` × 1000 leaves room for 1000 monotonic ticks
  // per millisecond — far more than any UI ever issues. Numbers stay
  // safely under MAX_SAFE_INTEGER.
  trackSeq = (trackSeq + 1) % 1000;
  return Date.now() * 1000 + trackSeq;
}

function emit() {
  // Recreate the snapshot on every change so consumers using identity
  // equality detect the update — `useSyncExternalStore` would otherwise
  // skip a render when the array reference is reused.
  snapshot = state.slice();
  // Compute the pre-sorted list once per mutation. The sort+filter
  // previously ran inside `list()` on every render; doing it here amortises
  // the cost across many reads.
  const pinned = snapshot.filter((i) => i.pinned);
  const recent = snapshot
    .filter((i) => !i.pinned)
    .sort((a, b) => b.ts - a.ts);
  listSnapshot = [...pinned, ...recent];
  for (const fn of listeners) fn();
}

function readStorage(): RecentItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedState | unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as PersistedState).v !== SCHEMA_VERSION ||
      !Array.isArray((parsed as PersistedState).items)
    ) {
      return [];
    }
    // Drop any item missing a required field — rather corrupt-tolerant
    // than throw and lock the user out of the sidebar permanently.
    return (parsed as PersistedState).items.filter(
      (it): it is RecentItem =>
        !!it &&
        typeof it.id === "string" &&
        typeof it.kind === "string" &&
        typeof it.label === "string" &&
        typeof it.href === "string" &&
        typeof it.ts === "number",
    );
  } catch {
    return [];
  }
}

function writeStorage() {
  if (typeof window === "undefined") return;
  try {
    const payload: PersistedState = { v: SCHEMA_VERSION, items: state };
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(payload));
  } catch {
    // Quota / private mode / etc. — best-effort persistence; the
    // in-memory list still works for the rest of the session.
  }
}

function hydrateOnce() {
  if (hydrated) return;
  hydrated = true;
  state = readStorage();
  snapshot = state.slice();
  // Seed the sorted list snapshot so the first `list()` call doesn't
  // need to wait for the first mutation.
  const pinned = snapshot.filter((i) => i.pinned);
  const recent = snapshot
    .filter((i) => !i.pinned)
    .sort((a, b) => b.ts - a.ts);
  listSnapshot = [...pinned, ...recent];
}

function applyCap() {
  // Pinned items are immune to the cap. The non-pinned tail is sorted
  // newest-first; everything past `RECENT_MAX` is dropped.
  const pinned = state.filter(i => i.pinned);
  const recent = state
    .filter(i => !i.pinned)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, RECENT_MAX);
  state = [...pinned, ...recent];
}

export const recentStore = {
  /**
   * Track an entity visit. Idempotent on `id`: existing entries get
   * their `label`, `href`, and `ts` refreshed (so a project rename
   * shows up next time the user navigates back). The `pinned` flag is
   * preserved across re-tracks.
   */
  track(item: Omit<RecentItem, "ts" | "pinned">) {
    hydrateOnce();
    const ts = nextTs();
    const existing = state.find(i => i.id === item.id && i.kind === item.kind);
    if (existing) {
      existing.label = item.label;
      existing.href = item.href;
      existing.ts = ts;
    } else {
      state.push({ ...item, ts });
    }
    applyCap();
    writeStorage();
    emit();
  },

  pin(id: string, kind?: RecentKind) {
    hydrateOnce();
    const it = kind
      ? state.find(i => i.id === id && i.kind === kind)
      : state.find(i => i.id === id);
    if (!it || it.pinned) return;
    it.pinned = true;
    writeStorage();
    emit();
  },

  unpin(id: string, kind?: RecentKind) {
    hydrateOnce();
    const it = kind
      ? state.find(i => i.id === id && i.kind === kind)
      : state.find(i => i.id === id);
    if (!it || !it.pinned) return;
    delete it.pinned;
    applyCap(); // unpinning a stale entry may now push it over the cap
    writeStorage();
    emit();
  },

  /**
   * Snapshot of the current list. Pinned entries first (in pin
   * insertion order), then recents newest-first. Returns the same
   * frozen reference until the next mutation — safe to use as a hook
   * dependency.
   */
  list(): ReadonlyArray<RecentItem> {
    hydrateOnce();
    // `listSnapshot` is refreshed in `emit()` on every mutation; reading
    // here is a single reference return — no filter/sort/spread per call.
    return listSnapshot;
  },

  /**
   * `useSyncExternalStore` glue. The snapshot is recreated on every
   * mutation (see `emit`) so identity-equality subscribers always
   * see a fresh reference when the store actually changed.
   */
  subscribe(fn: () => void): () => void {
    hydrateOnce();
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getSnapshot(): ReadonlyArray<RecentItem> {
    hydrateOnce();
    return snapshot;
  },

  __resetForTests() {
    state = [];
    snapshot = [];
    hydrated = true;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(RECENT_KEY);
      } catch {
        /* ignore */
      }
    }
    emit();
  },
};

/**
 * React-friendly wrapper. Subscribes via `useSyncExternalStore` so
 * concurrent rendering stays consistent and the list re-renders the
 * moment another component calls `track`/`pin`/`unpin`.
 */
export function useRecentList(): ReadonlyArray<RecentItem> {
  // We pass `recentStore.list` rather than `getSnapshot` so the
  // sorted shape is what consumers see — `getSnapshot` exists to
  // satisfy the SES contract (must return the *same* reference
  // unless data changed, which `snapshot` does).
  useSyncExternalStore(recentStore.subscribe, recentStore.getSnapshot, recentStore.getSnapshot);
  return recentStore.list();
}

/**
 * `useTrackRecent` — call from a detail page to register the entity
 * the user is currently looking at. Tracks once per stable identity;
 * passing a falsy `id`/`label` is a no-op so callers can guard with
 * the params that haven't resolved yet without an extra `if`.
 *
 * Example, inside `<ProjectDetailPage />`:
 *
 *   useTrackRecent({ kind: "project", id, label: project?.name, href: `/projects/${id}` });
 *
 * One persistent store, one source of truth.
 */
export function useTrackRecent(item: {
  kind: RecentKind;
  id: string | undefined;
  label: string | undefined | null;
  href: string;
}) {
  const { kind, id, label, href } = item;
  useEffect(() => {
    if (!id || !label) return;
    recentStore.track({ kind, id, label, href });
    // Track on every change of (kind,id,label,href). React's effect
    // runner already de-duplicates on equal-reference deps so the
    // store doesn't see redundant writes — but the store also dedupes
    // on `id` internally, so even an over-eager call is cheap.
  }, [kind, id, label, href]);
}
