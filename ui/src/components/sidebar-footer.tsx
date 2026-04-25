import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchUpdateState,
  fetchVersion,
  triggerUpdate,
  type UpdateState,
  type VersionInfo,
} from "@/lib/api";

const POLL_INTERVAL_MS = 3000;

export function SidebarFooter() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateState>({ status: "idle" });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollOnce = useCallback(async () => {
    try {
      const next = await fetchUpdateState();
      setUpdate(next);
      if (next.status !== "running") stopPolling();
    } catch {
      // Network blip — keep polling on the same cadence.
    }
  }, [stopPolling]);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
  }, [pollOnce]);

  const refreshVersion = useCallback(async () => {
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

  // Initial load: fetch version + current update state in parallel.
  useEffect(() => {
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
    return stopPolling;
  }, [refreshVersion, startPolling, stopPolling]);

  const onUpdate = useCallback(async () => {
    setUpdate({ status: "running" });
    try {
      await triggerUpdate();
    } catch (err) {
      setUpdate({
        status: "error",
        error: err instanceof Error ? err.message : "Update failed",
      });
      return;
    }
    // Whether POST returned 202 or 409 (conflict with an in-flight install),
    // start polling for the final status either way.
    startPolling();
    void pollOnce();
  }, [startPolling, pollOnce]);

  if (info?.error === "unavailable") return null;

  const current = info?.current ?? "";
  const hasUpdate = !!info?.update_available;
  const canUpdate = info?.install_mode === "global" || info?.install_mode === "local";
  const running = update.status === "running";
  const isSuccess = update.status === "success";
  const isError = update.status === "error";

  return (
    <div className="px-3 py-2 text-[11px] text-sidebar-foreground/70">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono truncate" title={current ? `v${current}` : "Checking…"}>
          {current ? `v${current}` : "…"}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={refreshVersion}
            disabled={checking || running}
            className="rounded-md p-1 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground disabled:opacity-50"
            title="Check for updates"
            aria-label="Check for updates"
          >
            <RefreshCw className={cn("h-3 w-3", checking && "animate-spin")} />
          </button>
          {(hasUpdate || isError) && canUpdate && !isSuccess && (
            <button
              type="button"
              onClick={onUpdate}
              disabled={running}
              className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
              title={`Install v${info?.latest ?? ""} via ${
                info?.install_mode === "global" ? "npm i -g" : "npm i"
              }`}
            >
              {running ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              {isError ? "Retry" : "Update"}
            </button>
          )}
        </div>
      </div>
      {running && (
        <div className="mt-1 text-muted-foreground">
          Installing v{info?.latest ?? ""}…
        </div>
      )}
      {isSuccess && (
        <div className="mt-1 text-emerald-600 dark:text-emerald-400">
          Update installed — restart the daemon.
        </div>
      )}
      {isError && (
        <div className="mt-1 text-red-600 dark:text-red-400" title={update.error}>
          {update.error ?? "Update failed"}
        </div>
      )}
      {hasUpdate && !running && !isSuccess && !isError && (
        <div className="mt-1 truncate text-muted-foreground">
          New: v{info?.latest}
          {!canUpdate && " (update manually)"}
        </div>
      )}
    </div>
  );
}
