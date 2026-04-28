import { useEffect, useRef } from "react";
import { useAttention } from "./attention";
import { renderBadge } from "../favicon-badge";

/**
 * Default favicon path. Matches the `<link rel="icon">` declared in
 * `ui/index.html`. If you ever rename the static asset, fix it both here
 * and in `index.html` — the hook reads whichever href is on the live link
 * at mount time, so a missing `/favicon.svg` would also explain a
 * silently-blank tab icon.
 */
const BASE_FAVICON = "/favicon.svg";

/**
 * sessionStorage key for the captured original favicon href. Keying it
 * here keeps the magic string in one place and survives Vite hot reloads
 * within the same tab — see comment block in the effect for rationale.
 */
const SESSION_STORAGE_KEY = "flockctl.favicon.original";

/**
 * Debounce window before the badge is re-rendered. Attention totals can
 * tick rapidly when several `attention_changed` WS frames arrive back to
 * back; rendering at canvas-rate would burn CPU for an icon the user
 * usually only glances at. 250ms is short enough to feel instant and long
 * enough to coalesce the bursts seen in practice.
 */
const DEBOUNCE_MS = 250;

/**
 * Mount-once hook that mirrors the global "attention" total into a badge
 * baked onto the document's favicon.
 *
 * Lifecycle:
 *   1. On mount, locate (or create) the `<link rel="icon">` element and
 *      remember its current href as the "clean" base. The reference is
 *      stashed in `sessionStorage` so a Vite HMR remount picks up the
 *      original SVG path instead of the previously-baked data URL.
 *   2. On every total change, debounce by 250ms then call `renderBadge`
 *      and assign the resulting data URL back to the link. When the total
 *      is 0, `renderBadge` short-circuits to the clean base — no canvas
 *      work needed.
 *   3. On unmount, restore the original href so a SPA route change that
 *      tears the runner down doesn't leave a stale badge in the tab.
 */
export function useFaviconBadge(): void {
  const { total } = useAttention();
  const originalHrefRef = useRef<string | null>(null);
  const linkRef = useRef<HTMLLinkElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Locate (or create) the <link rel="icon">, capture its original href,
  // and queue cleanup. Runs once.
  useEffect(() => {
    if (typeof document === "undefined") return;
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    linkRef.current = link;

    if (originalHrefRef.current === null) {
      // sessionStorage protects against a Vite HMR remount: the previous
      // mount may have written a data: URL into the link's href before
      // unmount. Reading the live href on the next mount would capture
      // that data URL as the new "original", and we'd permanently lose
      // the path back to the static favicon. Persisting the cleanly
      // captured original through the session avoids that regression.
      let original: string | null = null;
      try {
        const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
        if (stored && !stored.startsWith("data:")) original = stored;
      } catch {
        // sessionStorage may be unavailable (privacy mode, sandboxed
        // iframe). Fall through to live-href capture; the worst case is a
        // sticky data URL after HMR, which is dev-only.
      }
      if (!original) {
        const liveHref = link.href || BASE_FAVICON;
        original = liveHref.startsWith("data:") ? BASE_FAVICON : liveHref;
        try {
          sessionStorage.setItem(SESSION_STORAGE_KEY, original);
        } catch {
          // see above
        }
      }
      originalHrefRef.current = original;
    }

    return () => {
      // Cancel any pending render — the component is going away and
      // mutating its captured link ref after unmount would be a leak.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (originalHrefRef.current && linkRef.current) {
        linkRef.current.href = originalHrefRef.current;
      }
    };
  }, []);

  // Debounced badge swap. Re-runs whenever `total` ticks.
  useEffect(() => {
    if (!linkRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      const base = originalHrefRef.current ?? BASE_FAVICON;
      const url = await renderBadge(total, base);
      // The link ref may have been cleared by the unmount cleanup that
      // ran while this timer was queued; guard against assigning to a
      // stale reference.
      if (linkRef.current) linkRef.current.href = url;
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [total]);
}

/**
 * Mountable wrapper. The hook itself returns nothing renderable, but the
 * app needs to compose it inside the React tree so that `useAttention`
 * (which depends on `QueryClientProvider`) is in scope. Exporting a
 * component keeps the call site declarative — see `ui/src/main.tsx`.
 */
export function FaviconBadgeRunner(): null {
  useFaviconBadge();
  return null;
}
