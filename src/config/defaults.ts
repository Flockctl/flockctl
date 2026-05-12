import { loadRc, saveRc } from "./paths.js";

/**
 * The TCP port the local daemon binds to by default. Used by the CLI
 * (`flockctl start --port`), the daemon entry point, the daemon HTTP
 * client, and the SSH tunnel builder for the remote-port assumption.
 *
 * Hard-coded to 52077 because:
 *   1. The daemon is single-tenant per host — there's no fleet of
 *      daemons that needs distinct ports.
 *   2. `${secret:NAME}` placeholder URLs in `.flockctlrc` and the
 *      `flockctl-host` MCP server hard-code this number; changing it
 *      here without a migration would silently break user configs.
 *
 * Override at runtime via the `--port` CLI flag or `FLOCKCTL_PORT` env.
 */
export const DEFAULT_DAEMON_PORT = 52077;

export function getDefaultModel(): string {
  return loadRc().defaultModel ?? "claude-sonnet-4-6";
}

export function getPlanningModel(): string {
  return loadRc().planningModel ?? "claude-opus-4-7";
}

export function getDefaultAgent(): string {
  return loadRc().defaultAgent ?? "claude-code";
}

/** Default AI Provider Key id (numeric). Returns null when unset. */
export function getDefaultKeyId(): number | null {
  const raw = loadRc().defaultKeyId;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  return null;
}

/**
 * Update one or more global defaults in ~/.flockctlrc. Pass `null` to clear a
 * field; omit a key to leave it untouched.
 */
export function setGlobalDefaults(input: {
  defaultModel?: string | null;
  defaultKeyId?: number | null;
}): void {
  const rc = { ...loadRc() };
  if (input.defaultModel !== undefined) {
    if (input.defaultModel === null || input.defaultModel === "") {
      delete rc.defaultModel;
    } else {
      rc.defaultModel = input.defaultModel;
    }
  }
  if (input.defaultKeyId !== undefined) {
    if (input.defaultKeyId === null) {
      delete rc.defaultKeyId;
    } else {
      rc.defaultKeyId = input.defaultKeyId;
    }
  }
  saveRc(rc);
}
