/**
 * Notification permission helper.
 *
 * Wraps the browser Notification API with explicit handling for environments
 * where it's unavailable (SSR, old browsers) or unusable (insecure context).
 *
 * Status is read fresh on every call — never cached — because users can
 * revoke permission at any time via the browser's site-settings UI.
 */

export type PermissionStatus =
  | "granted"
  | "denied"
  | "default"
  | "unsupported" // browser has no Notification API
  | "insecure-context"; // isSecureContext === false

/** Synchronous read of the current notification permission status. */
export function getStatus(): PermissionStatus {
  if (typeof window === "undefined") return "unsupported";
  if (!("Notification" in window)) return "unsupported";
  if (!window.isSecureContext) return "insecure-context";
  return window.Notification.permission as "granted" | "denied" | "default";
}

/**
 * Dev-mode user-gesture assertion. A top-level click handler bumps a
 * timestamp; if `requestPermission` is invoked more than 1s after the last
 * click, we log a console.error in dev. Production never errors.
 */
const USER_GESTURE_WINDOW_MS = 1000;

declare global {
  // eslint-disable-next-line no-var
  var __lastUserGestureAt: number | undefined;
}

let gestureListenerInstalled = false;
function ensureGestureListener(): void {
  if (gestureListenerInstalled) return;
  if (typeof document === "undefined") return;
  gestureListenerInstalled = true;
  const handler = () => {
    globalThis.__lastUserGestureAt = Date.now();
  };
  document.addEventListener("click", handler, { capture: true });
  document.addEventListener("keydown", handler, { capture: true });
}
ensureGestureListener();

function isDevMode(): boolean {
  try {
    // import.meta.env is replaced at build time by Vite. In test environments
    // without Vite it'll throw — treat that as "not dev" so tests don't
    // pollute output.
    return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
}

/**
 * Request permission from the user. Must be called from a user-gesture
 * handler; in dev, we log a warning if it isn't.
 *
 * Only prompts when current status is "default" — all other states are
 * returned unchanged (you can't re-prompt once denied/granted).
 */
export async function requestPermission(): Promise<PermissionStatus> {
  const cur = getStatus();
  if (
    cur === "granted" ||
    cur === "denied" ||
    cur === "unsupported" ||
    cur === "insecure-context"
  ) {
    return cur;
  }

  // cur === "default" — only state where prompting is allowed.
  if (isDevMode()) {
    const last = globalThis.__lastUserGestureAt ?? 0;
    if (Date.now() - last > USER_GESTURE_WINDOW_MS) {
      // eslint-disable-next-line no-console
      console.error(
        "[notification-permission] requestPermission() called outside a user-gesture handler. " +
          "Browsers will reject this prompt silently in some configurations.",
      );
    }
  }

  const result = await window.Notification.requestPermission();
  return result as PermissionStatus;
}

/**
 * Subscribe to permission changes. Uses the Permissions API when available
 * so revocation via site settings is detected without a page reload.
 *
 * Returns an unsubscribe function. No-op (returns a no-op unsubscribe) if
 * the Permissions API is missing or rejects the query (e.g. older Firefox).
 */
export function subscribePermissionChange(
  cb: (s: PermissionStatus) => void,
): () => void {
  if (typeof navigator === "undefined") return () => {};
  type ChangeListener = ((ev: Event) => unknown) | null;
  type MutablePermStatus = { onchange: ChangeListener };
  const permissions = (navigator as Navigator & {
    permissions?: {
      query: (descriptor: { name: string }) => Promise<MutablePermStatus>;
    };
  }).permissions;
  if (!permissions || typeof permissions.query !== "function") {
    return () => {};
  }

  let cancelled = false;
  let permStatus: MutablePermStatus | null = null;

  permissions
    .query({ name: "notifications" })
    .then((s) => {
      if (cancelled) return;
      permStatus = s;
      s.onchange = () => {
        cb(getStatus());
      };
    })
    .catch(() => {
      // Older Firefox (and some privacy-hardened browsers) reject the
      // query. There's nothing useful to do — the caller will pick up the
      // new permission state on next mount.
    });

  return () => {
    cancelled = true;
    if (permStatus) {
      permStatus.onchange = null;
      permStatus = null;
    }
  };
}
