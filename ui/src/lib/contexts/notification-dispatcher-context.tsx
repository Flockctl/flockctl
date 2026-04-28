/**
 * React glue for the notification Dispatcher.
 *
 * Mounts a single `Dispatcher` instance per app, wires it to a singleton
 * `LeaderElection`, exposes both via context, and surfaces an ergonomic
 * `useLeaderStatus()` hook so the Settings UI can show "this tab fires
 * notifications" / "another tab is firing notifications" without any
 * caller plumbing.
 *
 * The provider also publishes the dispatcher on `window.__flockctlDispatcher`
 * so Playwright tests can `page.evaluate(...)` to drive `fire()` directly
 * — the dispatcher is otherwise an internal API with no UI button.
 *
 * Tolerates a missing provider:
 *   - `useNotificationDispatcher()` returns `null` when no provider is
 *     mounted (used by `useLeaderStatus` to fall back to "leader" so old
 *     unit tests rendering `<NotificationsTab />` directly still see a
 *     sensible status row).
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { LeaderElection } from "@/lib/leader-election";
import {
  Dispatcher,
  type Notifiable,
} from "@/lib/notification-dispatcher";
import { loadPrefs } from "@/lib/notification-prefs";

declare global {
  interface Window {
    /** Test-only handle for Playwright. Not part of the public API. */
    __flockctlDispatcher?: Dispatcher;
  }
}

const NotificationDispatcherContext = createContext<Dispatcher | null>(null);

/** Returns the live dispatcher, or `null` if no provider is mounted. */
export function useNotificationDispatcher(): Dispatcher | null {
  return useContext(NotificationDispatcherContext);
}

interface ProviderProps {
  children: ReactNode;
  /** Test seam: inject a pre-built dispatcher. When omitted, the provider
   *  builds one wired to a fresh LeaderElection + the localStorage-backed
   *  prefs loader. */
  dispatcher?: Dispatcher;
}

export function NotificationDispatcherProvider({
  children,
  dispatcher,
}: ProviderProps): React.JSX.Element {
  // `useMemo` rather than `useState(() => …)` so React's StrictMode-driven
  // double-mount in dev doesn't leak two LeaderElection instances onto the
  // BroadcastChannel for the same tab. The memo's identity is stable for
  // the component's lifetime, and the LeaderElection's start()/stop() in
  // the effect below already handles the re-mount cycle.
  const live = useMemo(() => {
    if (dispatcher) return dispatcher;
    const election = new LeaderElection();
    return new Dispatcher(loadPrefs, (k) => k, election);
  }, [dispatcher]);

  useEffect(() => {
    live.leader.start();
    if (typeof window !== "undefined") {
      window.__flockctlDispatcher = live;
    }
    return () => {
      live.leader.stop();
      if (typeof window !== "undefined" && window.__flockctlDispatcher === live) {
        delete window.__flockctlDispatcher;
      }
    };
  }, [live]);

  return (
    <NotificationDispatcherContext.Provider value={live}>
      {children}
    </NotificationDispatcherContext.Provider>
  );
}

/**
 * Reactive view of "is this tab the notification leader?".
 *
 * Re-renders on `becameLeader` / `becameFollower` events from the
 * underlying LeaderElection. Defaults to `"leader"` when no provider is
 * mounted — matches the LeaderElection fallback semantics (a single tab
 * with no BroadcastChannel is unconditionally the leader) and keeps
 * unit tests that render `<NotificationsTab />` without the provider
 * passing without modification.
 */
export function useLeaderStatus(): "leader" | "follower" {
  const dispatcher = useNotificationDispatcher();
  const leader = dispatcher?.leader;
  const [status, setStatus] = useState<"leader" | "follower">(() =>
    leader ? (leader.isLeader() ? "leader" : "follower") : "leader",
  );

  useEffect(() => {
    if (!leader) return;
    // Sync once on mount in case the leader flipped between the initial
    // useState seed and the effect actually running (rare, but cheap).
    setStatus(leader.isLeader() ? "leader" : "follower");
    const onLeader = () => setStatus("leader");
    const onFollower = () => setStatus("follower");
    leader.addEventListener("becameLeader", onLeader);
    leader.addEventListener("becameFollower", onFollower);
    return () => {
      leader.removeEventListener("becameLeader", onLeader);
      leader.removeEventListener("becameFollower", onFollower);
    };
  }, [leader]);

  return status;
}

/** Convenience export so call sites don't need a separate import. */
export type { Notifiable };
