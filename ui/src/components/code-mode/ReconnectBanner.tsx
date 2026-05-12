/**
 * ReconnectBanner — surfaced by the reconnect-drift handler when, on
 * resumption of the WebSocket, an open file tab's on-disk sha has
 * drifted away from `heldSha` AND the local buffer is dirty (or the
 * file vanished entirely).
 *
 * Two shapes match the {@link ReconnectBannerState} discriminator:
 *
 *   - `changed` — disk moved while we were offline. Two terminal
 *     actions: Reload (overwrite buffer with disk; clears dirty) and
 *     Keep (dismiss banner, leave buffer intact for the user's next
 *     save — which will re-conflict server-side via the sha-conflict
 *     PUT envelope, by design).
 *   - `deleted` — file is gone on disk. Two terminal actions: Save
 *     (recreate from buffer — call site decides whether `allowCreate`
 *     fits the project) and Close (drop the tab and let the FS-changed
 *     stream catch up).
 *
 * The banner is rendered above the affected Monaco editor (per-tab
 * position). Style mirrors `AgentTouchedBanner` so the editor's
 * conflict-banner surface is visually consistent — different copy,
 * same affordance.
 */
import { Button } from "@/components/ui/button";
import { AlertTriangle, FileX } from "lucide-react";

import type { ReconnectBannerState } from "./tab-store";

export interface ReconnectBannerProps {
  /** Path the editor has open — surfaced for screen readers + clarity. */
  path: string;
  /** Banner shape; the discriminator drives copy + actions. */
  banner: ReconnectBannerState;
  /**
   * Reload disk into buffer (only meaningful for `changed`). The caller
   * is expected to fetch via the file query and call `setBuffer` on the
   * editor-tabs store; we don't take a sha because the call-site has
   * to read the freshest copy anyway.
   */
  onReload?: () => void;
  /**
   * Dismiss the banner without touching the buffer. Maps to "Keep" on
   * `changed` and "Close" on `deleted`.
   */
  onDismiss: () => void;
  /**
   * Save buffer back to disk (only meaningful for `deleted`). Optional
   * because a parent may not wire it up — the banner falls back to
   * showing only the dismiss button when the prop is missing.
   */
  onSave?: () => void;
}

export function ReconnectBanner({
  path,
  banner,
  onReload,
  onDismiss,
  onSave,
}: ReconnectBannerProps) {
  if (banner.kind === "deleted") {
    return (
      <div
        data-testid="reconnect-banner"
        data-kind="deleted"
        role="alert"
        className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm"
      >
        <div className="flex items-start gap-2">
          <FileX
            className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="leading-snug">
              <span className="font-medium">File no longer exists on disk.</span>{" "}
              It was removed while you were offline.
            </p>
            <p
              className="truncate font-mono text-xs text-muted-foreground"
              title={path}
            >
              {path}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onSave ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onSave}
              data-testid="reconnect-banner-save"
            >
              Save
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={onDismiss}
            data-testid="reconnect-banner-close"
          >
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="reconnect-banner"
      data-kind="changed"
      data-current-sha={banner.currentSha}
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <div className="min-w-0">
          <p className="leading-snug">
            <span className="font-medium">File changed on disk</span> while
            you were offline.
          </p>
          <p
            className="truncate font-mono text-xs text-muted-foreground"
            title={path}
          >
            {path}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onDismiss}
          data-testid="reconnect-banner-keep"
        >
          Keep mine
        </Button>
        {onReload ? (
          <Button
            size="sm"
            onClick={onReload}
            data-testid="reconnect-banner-reload"
          >
            Reload
          </Button>
        ) : null}
      </div>
    </div>
  );
}
