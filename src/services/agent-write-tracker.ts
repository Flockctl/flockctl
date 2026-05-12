/**
 * agent-write-tracker — best-effort tagging surface so the FS watcher can
 * label a `fs.changed` broadcast as `source: "agent"` vs `source: "external"`.
 *
 * The agent runtime calls `track(projectId, path)` IMMEDIATELY before it
 * writes a file via the Edit / Write tools — it knows the path it is about
 * to mutate and the time of the call. The FS watcher then calls
 * `consume(projectId, path)`; if a track entry exists within the TTL window,
 * the watcher tags the event as `agent` and removes the entry. Otherwise
 * the event is `external`.
 *
 * Why best-effort:
 *   - **False negatives are acceptable.** If the tracker forgets an entry
 *     (TTL too short, watcher debounce too long, missed track call) the UI
 *     just sees an "external" tag for an agent-driven write — annoying but
 *     not unsafe.
 *   - **False positives are NOT acceptable.** Tagging an external edit as
 *     `agent` would silently suppress a "the agent overwrote my work"
 *     warning in the UI. So `consume` is single-shot (`delete` on consume)
 *     and entries past the TTL are pruned on every call.
 *
 * Storage is in-process — restarting the daemon clears the table. A 5-second
 * TTL covers the worst-case watcher debounce + chokidar `awaitWriteFinish`
 * settle (`100ms` + `100ms`) plus a generous slack margin.
 */

const TTL_MS = 5_000;

type Bucket = Map<string, number>;

const buckets = new Map<string, Bucket>();

/**
 * Hard cap on the number of project buckets retained in memory. Without it,
 * a daemon that observes writes across many short-lived projects accumulates
 * one bucket per project forever — even if every individual bucket is empty
 * after `consume()` strips its last entry. The cap evicts the oldest project
 * (Map iteration is insertion-ordered) before adding a new one.
 *
 * 1024 covers any realistic operator load while keeping the worst case
 * bounded. Buckets that legitimately need to survive an eviction get
 * recreated on the next `track()` for that project — each is a 1-line cost.
 */
const BUCKETS_MAX = 1024;

/**
 * Hard cap on entries per bucket. Audit-round-8 finding: the outer
 * `buckets` map is bounded, but each individual bucket could still
 * accumulate arbitrarily many path entries (each track() insert grows
 * the bucket; consume() only matches paths the watcher actually
 * surfaces). A hot project that writes millions of unique paths over
 * a long uptime would grow its bucket without bound. The size cap
 * evicts the oldest path (insertion-ordered Map) before a fresh
 * insert pushes past the limit.
 *
 * 4096 paths per project covers any realistic burst of agent writes
 * inside the 5s TTL window — the eviction only fires on extreme load.
 */
const BUCKET_ENTRY_MAX = 4096;

/**
 * Record that the agent is about to write `relPath` inside `projectId`.
 * Idempotent — repeated calls just refresh the timestamp. Call this
 * BEFORE the actual write, so the watcher event (which fires after) sees
 * a fresh entry.
 */
export function track(projectId: string, relPath: string): void {
  let b = buckets.get(projectId);
  if (!b) {
    if (buckets.size >= BUCKETS_MAX) {
      // Evict oldest project to keep memory bounded. The evicted project's
      // in-flight tracks are lost, which means the next watcher event for
      // that project may be tagged `external` instead of `agent` — a known
      // false-negative class the module's docstring already accepts.
      const oldest = buckets.keys().next();
      if (!oldest.done) buckets.delete(oldest.value);
    }
    b = new Map();
    buckets.set(projectId, b);
  }
  // Bound the per-bucket size (audit-round-8). Map iteration is
  // insertion-ordered, so the first key is the oldest entry. We evict
  // BEFORE the insert so the new entry doesn't push past the limit.
  if (b.size >= BUCKET_ENTRY_MAX && !b.has(relPath)) {
    const oldestEntry = b.keys().next();
    if (!oldestEntry.done) b.delete(oldestEntry.value);
  }
  b.set(relPath, Date.now());
}

/**
 * Drop the bucket for a project — call from project-deletion paths so a
 * removed project doesn't leak its tracker entries until the size cap
 * kicks in. Idempotent: no-op if the bucket is already absent.
 */
export function clearProject(projectId: string): void {
  buckets.delete(projectId);
}

/**
 * If the agent recently wrote `relPath` inside `projectId`, consume the
 * entry and return true. Otherwise return false. Also prunes any entries
 * older than the TTL on the way through.
 *
 * The consume-on-read semantics are deliberate: a single agent write should
 * tag exactly one watcher event. If the agent writes the same path twice in
 * rapid succession, the second event will fall through to `external` —
 * acceptable noise vs. the danger of mis-tagging a follow-up external edit.
 */
export function consume(projectId: string, relPath: string): boolean {
  const b = buckets.get(projectId);
  if (!b) return false;

  const now = Date.now();
  // Prune stale entries first so a long-lived bucket doesn't grow unbounded.
  for (const [k, ts] of b) {
    if (now - ts > TTL_MS) b.delete(k);
  }

  const ts = b.get(relPath);
  if (ts === undefined) return false;
  if (now - ts > TTL_MS) {
    b.delete(relPath);
    return false;
  }
  b.delete(relPath);
  if (b.size === 0) buckets.delete(projectId);
  return true;
}

/**
 * Test-only: clear the in-process tracker. Exposed as a named export so
 * tests can deterministically reset state between runs without resorting
 * to fake-timer dances.
 */
export function _resetForTests(): void {
  buckets.clear();
}

/**
 * Test-only: peek at the current entry count for a project (read-only).
 */
export function _sizeForTests(projectId: string): number {
  return buckets.get(projectId)?.size ?? 0;
}

export const AgentWriteTracker = { track, consume, clearProject };
