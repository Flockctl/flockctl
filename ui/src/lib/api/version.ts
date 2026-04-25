import { apiFetch } from "./core";

// --- Version & Update ---

export interface VersionInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
  error: string | null;
  install_mode: "global" | "local" | "unknown";
}

export function fetchVersion(): Promise<VersionInfo> {
  return apiFetch("/meta/version");
}

export interface UpdateState {
  status: "idle" | "running" | "success" | "error";
  error?: string;
  target_version?: string;
  exit_code?: number | null;
  stdout?: string;
  stderr?: string;
}

export interface UpdateTrigger {
  triggered: boolean;
  target_version?: string;
  install_mode?: "global" | "local" | "unknown";
}

export function fetchUpdateState(): Promise<UpdateState> {
  return apiFetch("/meta/update");
}

// POST returns 202 immediately; the install keeps running in the background.
// Poll `fetchUpdateState()` until status leaves "running". A 409 means another
// install is already in flight — just start polling instead.
export async function triggerUpdate(): Promise<UpdateTrigger | { conflict: true }> {
  try {
    return await apiFetch<UpdateTrigger>("/meta/update", { method: "POST" });
  } catch (err) {
    // apiFetch throws on non-2xx. Treat 409 as a non-error "already running" signal.
    if (err instanceof Error && /already in progress/i.test(err.message)) {
      return { conflict: true };
    }
    throw err;
  }
}
