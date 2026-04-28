/**
 * useNotificationClickRouter — bridges OS notification clicks back into
 * the SPA router.
 *
 * The Dispatcher fires a `notification-click` event on its own
 * EventTarget every time the OS callback runs (see
 * `notification-dispatcher.ts`). This hook subscribes to that bus and
 * navigates to the path computed by `routeForNotification`.
 *
 * Why this lives in a hook (and not inside the dispatcher):
 *   - The OS notification callback runs OUTSIDE any React tree —
 *     `useNavigate()` would be unreachable from there. Re-emitting on a
 *     bus lets us bridge into React-land at the right layer.
 *   - The dispatcher must stay router-agnostic so its unit tests don't
 *     have to mount react-router-dom. That contract is what makes
 *     `Dispatcher.fire`'s gate suite cheap to evolve.
 *
 * Mount once at the layout root via `<NotificationClickRouterRunner />` —
 * a sibling of the attention / task-terminal runners. Living under
 * `<RouterProvider>` (specifically inside `<Layout />`) is REQUIRED so
 * `useNavigate()` resolves; the alternative — mounting at `main.tsx` as a
 * sibling of the router — would crash with "useNavigate must be used
 * within a Router".
 *
 * Edge cases:
 *
 *   - User is already on the target route: `navigate()` is a no-op for
 *     same-path navigation, `window.focus()` is harmless. No special
 *     case needed.
 *   - Multiple stacked notifications, click one in the middle: each OS
 *     notification has its own onclick closure capturing its own `n`.
 *     The bus dispatches the right payload per click.
 *   - Race on shutdown — notification fires just as the React tree
 *     unmounts (e.g. provider torn down): the try/catch around
 *     `navigate(...)` swallows the resulting "router gone" error so a
 *     stray click can't crash an unrelated React render.
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { useNotificationDispatcher } from "@/lib/contexts/notification-dispatcher-context";
import { routeForNotification } from "@/lib/notification-click-router";
import type { Notifiable } from "@/lib/notification-dispatcher";

export function useNotificationClickRouter(): void {
  const dispatcher = useNotificationDispatcher();
  const navigate = useNavigate();

  useEffect(() => {
    if (!dispatcher) return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<Notifiable>).detail;
      if (!detail) return;
      const path = routeForNotification(detail);
      try {
        navigate(path);
      } catch (err) {
        // navigate() can throw if the router is mid-unmount or the
        // history stack is in a transient state. We log + swallow so
        // a stale OS notification click doesn't trigger a React render
        // crash; the user simply ends up where they were.
        console.warn("[notifications] navigate failed", err);
      }
    };
    dispatcher.addEventListener("notification-click", handler);
    return () => {
      dispatcher.removeEventListener("notification-click", handler);
    };
  }, [dispatcher, navigate]);
}

/**
 * Mountable wrapper. Sits inside `<Layout />` next to the attention /
 * task-terminal runners so the entire notification fleet shares the same
 * provider chain and routing context.
 */
export function NotificationClickRouterRunner(): null {
  useNotificationClickRouter();
  return null;
}
