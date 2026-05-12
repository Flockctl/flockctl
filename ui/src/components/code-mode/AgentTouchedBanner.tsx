/**
 * AgentTouchedBanner — the conflict banner the editor shows when the
 * file has changed on disk while the local buffer is dirty.
 *
 * The copy distinguishes the two attribution sources:
 *
 *   - "by agent"     — `source === "agent"` (a Claude tool call wrote
 *                      the file via our own agent-write-tracker).
 *   - "externally"   — `source === "external"` (someone outside Flockctl
 *                      touched the file: another editor, git, an unseen
 *                      shell, …).
 *
 * UX matters here because the user's mental model is different in each
 * case: "the agent helped" vs "something I didn't initiate". The banner
 * exposes two terminal actions and nothing else — keep it boring.
 */
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

export interface AgentTouchedBannerProps {
  /** Attribution source from the triggering `fs.changed` frame. */
  source: "agent" | "external";
  /** Path the editor has open — surfaced for screen readers + clarity. */
  path: string;
  /** Discard local edits, refetch the disk version, and clear dirty. */
  onReload: () => void;
  /** Dismiss the banner; keep the dirty buffer untouched. */
  onKeepMine: () => void;
}

export function AgentTouchedBanner({
  source,
  path,
  onReload,
  onKeepMine,
}: AgentTouchedBannerProps) {
  // Pre-format the attribution phrase so it reads naturally inside the
  // banner copy ("File changed on disk by agent" vs "File changed on
  // disk externally").
  const attribution = source === "agent" ? "by agent" : "externally";

  return (
    <div
      data-testid="agent-touched-banner"
      data-source={source}
      role="alert"
      // The banner sits above the editor pane — we deliberately avoid
      // `position: sticky` so the editor's own scroll context isn't
      // disturbed. Caller is expected to stack it with flex.
      className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <div className="min-w-0">
          <p className="leading-snug">
            <span className="font-medium">File changed on disk</span> ({attribution}).
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground" title={path}>
            {path}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onKeepMine}
          data-testid="agent-touched-banner-keep"
        >
          Keep mine
        </Button>
        <Button
          size="sm"
          onClick={onReload}
          data-testid="agent-touched-banner-reload"
        >
          Reload
        </Button>
      </div>
    </div>
  );
}
