/**
 * Leader election across browser tabs/windows for the same origin.
 *
 * One — and only one — tab takes the role of "leader" and is responsible for
 * side-effects that must happen at most once per browser (e.g. showing a
 * desktop notification, polling a websocket, etc.). Election uses a single
 * `BroadcastChannel("flockctl.notifications")`; the smallest tabId wins.
 *
 * Lifecycle:
 *   const el = new LeaderElection();
 *   el.addEventListener("becameLeader",   () => { ... });
 *   el.addEventListener("becameFollower", () => { ... });
 *   el.start();              // joins the election
 *   ...
 *   el.stop();               // leaves the election; relinquishes if leader
 *
 * Fallback: if `BroadcastChannel` is unavailable in the runtime, the tab
 * unconditionally becomes leader (the "always-leader" mode). This is the
 * correct behavior for old browsers, SSR, and most test environments where
 * only one "tab" exists.
 *
 * Protocol (kept intentionally simple):
 *   - claim       : I want to be leader. Posted on start() and after a
 *                   detected leader-death.
 *   - heartbeat   : I am still the leader. Posted by the leader every 1500ms.
 *   - relinquish  : I am stepping down (e.g. tab unload).
 *
 * Tie-breaking: lexicographic order on tabId (UUIDs). The smallest wins.
 * Double-leader resolution: if the current leader sees a `claim` or
 * `heartbeat` from a tab with a smaller tabId, it demotes itself.
 */

type Msg =
  | { type: "claim"; tabId: string; at: number }
  | { type: "heartbeat"; tabId: string; at: number }
  | { type: "relinquish"; tabId: string };

const CHANNEL_NAME = "flockctl.notifications";
const HEARTBEAT_MS = 1500;
const DEADCHECK_MS = 1000;
const LEADER_DEAD_AFTER_MS = 5000;
const CLAIM_WINDOW_MS = 200;

export class LeaderElection extends EventTarget {
  private tabId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  private channel: BroadcastChannel | null = null;
  private isLeaderFlag = false;
  private started = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private deadcheckTimer: ReturnType<typeof setInterval> | null = null;
  private claimTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeenLeaderAt = 0;
  private claimCandidates = new Set<string>();

  /** Test-only: surface the assigned tabId so tests can drive deterministic
   *  ordering by spawning channels with controlled UUIDs. */
  get id(): string {
    return this.tabId;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    if (typeof BroadcastChannel === "undefined") {
      // No multi-tab signal possible — be the leader unconditionally.
      this.becomeLeader();
      return;
    }

    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (e: MessageEvent) => this.onMessage(e.data as Msg);
    this.attemptClaim();
    this.deadcheckTimer = setInterval(() => this.deadcheck(), DEADCHECK_MS);

    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this.onUnload);
      window.addEventListener("pageshow", this.onPageShow);
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.deadcheckTimer) {
      clearInterval(this.deadcheckTimer);
      this.deadcheckTimer = null;
    }
    if (this.claimTimer) {
      clearTimeout(this.claimTimer);
      this.claimTimer = null;
    }

    if (this.isLeaderFlag && this.channel) {
      try {
        this.channel.postMessage({
          type: "relinquish",
          tabId: this.tabId,
        } satisfies Msg);
      } catch {
        // Channel may already be closed in some teardown orderings.
      }
    }

    this.isLeaderFlag = false;

    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        /* no-op */
      }
      this.channel = null;
    }

    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", this.onUnload);
      window.removeEventListener("pageshow", this.onPageShow);
    }
  }

  isLeader(): boolean {
    return this.isLeaderFlag;
  }

  private attemptClaim(): void {
    if (!this.channel) return;
    this.claimCandidates.clear();
    this.claimCandidates.add(this.tabId);
    this.channel.postMessage({
      type: "claim",
      tabId: this.tabId,
      at: Date.now(),
    } satisfies Msg);

    if (this.claimTimer) clearTimeout(this.claimTimer);
    this.claimTimer = setTimeout(() => {
      this.claimTimer = null;
      this.decide();
    }, CLAIM_WINDOW_MS);
  }

  private decide(): void {
    if (!this.started) return;
    // Sort lexicographically — UUIDs are strings; smallest wins.
    const winner = [...this.claimCandidates].sort()[0];
    if (winner === this.tabId) {
      this.becomeLeader();
    } else {
      this.becomeFollower();
    }
  }

  private deadcheck(): void {
    if (this.isLeaderFlag) return;
    if (
      this.lastSeenLeaderAt > 0 &&
      Date.now() - this.lastSeenLeaderAt > LEADER_DEAD_AFTER_MS
    ) {
      this.lastSeenLeaderAt = 0;
      this.attemptClaim();
    }
  }

  private onMessage(msg: Msg): void {
    if (!msg || msg.tabId === this.tabId) return;
    if (msg.type === "claim") {
      this.claimCandidates.add(msg.tabId);
      // If I'm leader and a smaller tabId just claimed, step down so it
      // can take over.
      if (this.isLeaderFlag && msg.tabId < this.tabId) {
        this.becomeFollower();
      } else if (this.isLeaderFlag && this.channel) {
        // I'm still leader and the claimant is larger. Heartbeat
        // immediately so the claimant knows we exist before its 200ms
        // election window closes (otherwise it would believe it is
        // alone and elect itself, leading to a transient double-leader
        // state that only resolves on the next 1500ms heartbeat).
        this.channel.postMessage({
          type: "heartbeat",
          tabId: this.tabId,
          at: Date.now(),
        } satisfies Msg);
      }
    } else if (msg.type === "heartbeat") {
      this.lastSeenLeaderAt = Date.now();
      // If we are in the middle of our own election (claim window is
      // open), treat the heartbeating leader as a candidate so we do
      // not elect ourselves a second leader.
      if (this.claimTimer !== null) {
        this.claimCandidates.add(msg.tabId);
      }
      // Double-leader resolution: smaller tabId wins.
      if (this.isLeaderFlag && msg.tabId < this.tabId) {
        this.becomeFollower();
      }
    } else if (msg.type === "relinquish") {
      this.lastSeenLeaderAt = 0;
      this.attemptClaim();
    }
  }

  private becomeLeader(): void {
    if (this.isLeaderFlag) return;
    this.isLeaderFlag = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.channel) {
      // Post a heartbeat *immediately* so any other tab still inside its
      // own election window learns about us before deciding. This is the
      // primary mechanism that prevents transient double-leader states
      // when two tabs start at exactly the same moment.
      this.channel.postMessage({
        type: "heartbeat",
        tabId: this.tabId,
        at: Date.now(),
      } satisfies Msg);
      this.heartbeatTimer = setInterval(() => {
        this.channel?.postMessage({
          type: "heartbeat",
          tabId: this.tabId,
          at: Date.now(),
        } satisfies Msg);
      }, HEARTBEAT_MS);
    }
    this.dispatchEvent(new Event("becameLeader"));
  }

  private becomeFollower(): void {
    if (!this.isLeaderFlag) return;
    this.isLeaderFlag = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.dispatchEvent(new Event("becameFollower"));
  }

  private onUnload = (): void => {
    if (this.isLeaderFlag && this.channel) {
      try {
        this.channel.postMessage({
          type: "relinquish",
          tabId: this.tabId,
        } satisfies Msg);
      } catch {
        /* no-op */
      }
    }
  };

  private onPageShow = (): void => {
    // Page restored from bfcache — re-enter the election in case our
    // state diverged while frozen.
    if (this.started) this.attemptClaim();
  };
}
