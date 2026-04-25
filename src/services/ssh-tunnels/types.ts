/**
 * Shared types for the SshTunnelManager service.
 *
 * The full `RemoteServerConfig` shape is owned by slice 01 of the SSH-only
 * remote-servers milestone. Until that lands we keep an interim interface
 * here so the tunnel manager can be implemented and tested without circular
 * dependencies. Slice 03 will swap the import over.
 */

export type TunnelStatus = "starting" | "ready" | "error" | "stopped";

export type TunnelErrorCode =
  | "auth_failed"
  | "host_key_mismatch"
  | "connect_refused"
  | "remote_flockctl_missing"
  | "remote_daemon_down"
  | "unknown";

export interface SshTunnelHandle {
  serverId: string;
  localPort: number;
  status: TunnelStatus;
  errorCode?: TunnelErrorCode;
  rawStderr?: string;
  startedAt?: number;
  readyAt?: number;
}

/**
 * Interim shape — will be replaced by the canonical RemoteServerConfig from
 * slice 01 once that lands. Keep this narrow on purpose.
 */
export interface RemoteServerConfig {
  id: string;
  name: string;
  ssh: {
    host: string;
    user?: string;
    port?: number;
    identityFile?: string;
    /** Port of the remote flockctl daemon (defaults to 52077 when unset). */
    remotePort?: number;
  };
}
