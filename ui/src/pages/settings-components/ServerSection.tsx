import * as React from "react";
import { Loader2, RefreshCw, RotateCw } from "lucide-react";

import { FlatCard } from "@/components/design";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ServerConnectionsList } from "@/components/server-connections";
import {
  fetchUpdateState,
  fetchVersion,
  getApiBaseUrl,
  triggerUpdate,
  type UpdateState,
  type VersionInfo,
} from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * ServerSection — restyled "Server" tab content for the new settings page.
 *
 * Renders three pieces of information about the daemon the UI is currently
 * connected to, all inside a single `<FlatCard>` to match the rest of the
 * redesigned settings surface:
 *
 *   1. Daemon URL — read-only `<input>` showing the resolved API base URL
 *      (`http://127.0.0.1:52077` for the local daemon, or the SSH-tunnel
 *      loopback for a remote). Read-only because changing the active server
 *      is the Server Switcher's responsibility, not this card's.
 *
 *   2. Version display — the daemon's current version string with a refresh
 *      icon button. Falls back to "—" while the request is in flight or if
 *      the endpoint is unreachable; no toast / no banner — matches the
 *      sidebar footer's quiet-failure behaviour.
 *
 *   3. Restart button — kicks off `triggerUpdate()` (the same flow the
 *      sidebar footer uses for "install + restart"), then polls
 *      `fetchUpdateState()` every 3 s until the install leaves the
 *      `running` state. Success surfaces "Update installed — restart the
 *      daemon."; this **preserves the existing restart flow** verbatim so
 *      operators don't have to relearn anything when the section is moved
 *      from the sidebar into Settings → Server.
 *
 * The card is presentational with side effects only on click — no parent
 * props are required, which keeps the integration with `<SettingsTabs>`
 * trivial.
 */

const POLL_INTERVAL_MS = 3000;

export interface ServerSectionProps {
  className?: string;
}

export function ServerSection({
  className,
}: ServerSectionProps): React.JSX.Element {
  const [daemonUrl, setDaemonUrl] = React.useState<string>(() => {
    try {
      return getApiBaseUrl();
    } catch {
      // Active server is remote and the tunnel hasn't reported `ready` yet.
      // Show a placeholder rather than crashing — the field is read-only
      // anyway, so a momentary "—" is acceptable while the tunnel finishes
      // coming up.
      return "—";
    }
  });

  const [info, setInfo] = React.useState<VersionInfo | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [update, setUpdate] = React.useState<UpdateState>({ status: "idle" });
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = React.useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollOnce = React.useCallback(async () => {
    try {
      const next = await fetchUpdateState();
      setUpdate(next);
      if (next.status !== "running") stopPolling();
    } catch {
      // Network blip — keep polling on the same cadence.
    }
  }, [stopPolling]);

  const startPolling = React.useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
  }, [pollOnce]);

  const refreshVersion = React.useCallback(async () => {
    setChecking(true);
    try {
      setInfo(await fetchVersion());
    } catch {
      setInfo({
        current: "",
        latest: null,
        update_available: false,
        error: "unavailable",
        install_mode: "unknown",
      });
    } finally {
      setChecking(false);
    }
  }, []);

  // Initial mount: pull version + current update state in parallel.
  React.useEffect(() => {
    void refreshVersion();
    void (async () => {
      try {
        const initial = await fetchUpdateState();
        setUpdate(initial);
        if (initial.status === "running") startPolling();
      } catch {
        // Older daemons without /meta/update — leave state as "idle".
      }
    })();
    // Refresh the daemon URL too — the tunnel may have finished coming up
    // between the initial render and now.
    try {
      setDaemonUrl(getApiBaseUrl());
    } catch {
      /* still pending — leave the placeholder in place */
    }
    return stopPolling;
  }, [refreshVersion, startPolling, stopPolling]);

  const onRestart = React.useCallback(async () => {
    setUpdate({ status: "running" });
    try {
      await triggerUpdate();
    } catch (err) {
      setUpdate({
        status: "error",
        error: err instanceof Error ? err.message : "Restart failed",
      });
      return;
    }
    // Whether POST returned 202 or 409 (conflict with an in-flight install),
    // start polling for the final status either way.
    startPolling();
    void pollOnce();
  }, [pollOnce, startPolling]);

  const current = info?.current ?? "";
  const versionLabel = current ? `v${current}` : info ? "—" : "…";
  const running = update.status === "running";
  const isSuccess = update.status === "success";
  const isError = update.status === "error";

  return (
    <div className={cn("flex flex-col gap-4", className)}>
    <FlatCard className="flex flex-col">
      <div className="px-4 py-3" data-testid="server-section-header">
        <h3 className="text-sm font-semibold">Server</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Daemon this UI is connected to.
        </p>
      </div>

      <div className="px-4 py-3 space-y-4">
        {/* 1. Daemon URL ----------------------------------------------- */}
        <div className="space-y-1.5">
          <Label htmlFor="server-section-url">Daemon URL</Label>
          <Input
            id="server-section-url"
            data-testid="server-section-url"
            value={daemonUrl}
            readOnly
            className="font-mono text-sm"
            aria-readonly="true"
          />
        </div>

        {/* 2. Version display ------------------------------------------ */}
        <div className="space-y-1.5">
          <Label htmlFor="server-section-version">Version</Label>
          <div className="flex items-center gap-2">
            <span
              id="server-section-version"
              data-testid="server-section-version"
              className="font-mono text-sm"
            >
              {versionLabel}
            </span>
            <button
              type="button"
              onClick={() => void refreshVersion()}
              disabled={checking}
              className="rounded-md p-1 text-muted-foreground hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
              title="Refresh version"
              aria-label="Refresh version"
              data-testid="server-section-version-refresh"
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", checking && "animate-spin")}
              />
            </button>
          </div>
        </div>

        {/* 3. Restart button ------------------------------------------- */}
        <div className="space-y-1.5">
          <Button
            type="button"
            onClick={() => void onRestart()}
            disabled={running}
            data-testid="server-section-restart"
            variant="default"
            size="sm"
          >
            {running ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="mr-1 h-3.5 w-3.5" />
            )}
            {running ? "Restarting…" : "Restart daemon"}
          </Button>
          {running && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="server-section-status-running"
            >
              Restarting daemon…
            </p>
          )}
          {isSuccess && (
            <p
              className="text-xs text-emerald-600 dark:text-emerald-400"
              data-testid="server-section-status-success"
            >
              Update installed — restart the daemon.
            </p>
          )}
          {isError && (
            <p
              className="text-xs text-destructive"
              data-testid="server-section-status-error"
              title={update.error}
            >
              {update.error ?? "Restart failed"}
            </p>
          )}
        </div>
      </div>
    </FlatCard>

    {/* Remote connections — list / add / rename / delete servers
       this UI can switch to. The Local entry is always present. */}
    <FlatCard className="flex flex-col">
      <div className="px-4 py-3 overflow-x-auto">
        <ServerConnectionsList />
      </div>
    </FlatCard>
    </div>
  );
}

export default ServerSection;
