// TypeScript types mirroring shared/flockctl_shared/schemas.py and enums.py

// --- Remote server connections ---

/**
 * Closed set of failure modes surfaced by the SSH-tunnel lifecycle and
 * remote-bootstrap flow. Keep this in sync with `ui/src/locales/en.json` — the
 * i18n-parity test asserts a 1:1 mapping.
 */
export type ServerErrorCode =
  | "invalid_ssh_config"
  | "legacy_transport_rejected"
  | "auth_failed"
  | "host_key_mismatch"
  | "connect_refused"
  | "remote_flockctl_missing"
  | "remote_daemon_down"
  | "bootstrap_bad_output"
  | "tunnel_open_timeout"
  | "persistence_failed"
  | "unknown";

/** Every valid `ServerErrorCode` value, in the same order as the union above. */
export const SERVER_ERROR_CODES: readonly ServerErrorCode[] = [
  "invalid_ssh_config",
  "legacy_transport_rejected",
  "auth_failed",
  "host_key_mismatch",
  "connect_refused",
  "remote_flockctl_missing",
  "remote_daemon_down",
  "bootstrap_bad_output",
  "tunnel_open_timeout",
  "persistence_failed",
  "unknown",
] as const;

/**
 * Public server view. The UI never holds a bearer token or a remote URL —
 * every HTTP request goes to `http://127.0.0.1:${tunnelPort}` for remote
 * servers and `http://127.0.0.1:52077` for the local daemon. The SSH tunnel
 * makes remote access look identical to local, so no per-connection auth
 * header is needed.
 */
export interface ServerConnection {
  id: string;
  name: string;
  is_local: boolean;
  /**
   * SSH connection summary returned by `GET /meta/remote-servers`. Absent on
   * the synthetic Local entry. The row UI surfaces `ssh.host` as the server's
   * address so users know which remote they're looking at.
   */
  ssh?: {
    host: string;
    user?: string;
    port?: number;
    identityFile?: string;
    remotePort?: number;
  };
  /** SSH-tunnel lifecycle phase, surfaced by the server-connections UI. */
  tunnelStatus?: "starting" | "ready" | "error" | "stopped";
  /** Local loopback port the tunnel is bound to once `tunnelStatus === "ready"`. */
  tunnelPort?: number;
  /** Human-readable stderr tail captured when the tunnel last failed. */
  tunnelLastError?: string;
  /** Classified error code — pair with `errorCodeMessage()` for a UI string. */
  errorCode?: ServerErrorCode;
}

export type ConnectionStatus = "connected" | "checking" | "error";

// --- Error-code i18n ---

/**
 * Localized messages for every `ServerErrorCode`. Mirrored in
 * `ui/src/locales/en.json`; a test enforces parity so the two cannot drift.
 * When more locales arrive, swap this for a locale-aware lookup.
 */
const SERVER_ERROR_CODE_MESSAGES_EN: Record<ServerErrorCode, string> = {
  invalid_ssh_config: "SSH configuration is invalid. Check host, user, and key path.",
  legacy_transport_rejected:
    "Legacy direct-HTTP transport is no longer accepted. Re-add the server over SSH.",
  auth_failed: "SSH authentication failed. Verify your key is authorized on the remote host.",
  host_key_mismatch:
    "Remote host key does not match known_hosts. The server may have changed or be impersonated.",
  connect_refused: "Connection refused. The remote host is unreachable or SSH is not listening.",
  remote_flockctl_missing:
    "The `flockctl` binary was not found on the remote host. Install it, then retry.",
  remote_daemon_down: "Remote Flockctl daemon is not running. Start it with `flockctl start`.",
  bootstrap_bad_output:
    "Remote bootstrap returned unexpected output. The remote flockctl version may be incompatible.",
  tunnel_open_timeout: "Timed out waiting for the SSH tunnel to become ready.",
  persistence_failed: "Could not save server connection to ~/.flockctlrc.",
  unknown: "An unknown error occurred. See the daemon logs for details.",
};

/**
 * Resolve a `ServerErrorCode` to a human-readable message. Unknown or missing
 * codes fall back to the `unknown` entry so the UI always has something to
 * show.
 */
export function errorCodeMessage(code: string | undefined): string {
  if (code && Object.prototype.hasOwnProperty.call(SERVER_ERROR_CODE_MESSAGES_EN, code)) {
    return SERVER_ERROR_CODE_MESSAGES_EN[code as ServerErrorCode];
  }
  return SERVER_ERROR_CODE_MESSAGES_EN.unknown;
}

// --- Response types ---

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface ErrorResponse {
  detail: string;
  status_code: number;
}
