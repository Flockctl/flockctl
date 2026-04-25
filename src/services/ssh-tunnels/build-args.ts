import { ValidationError } from "../../lib/errors.js";
import type { RemoteServerConfig } from "./types.js";

/**
 * Permitted characters in an ssh hostname (or `user@host` / host-alias).
 *
 * A-Z, a-z, 0-9, underscore, dot, hyphen, at-sign, colon. That's enough to
 * express `alice@host.example.com`, IPv4 literals, and `Host Foo` aliases
 * defined in `~/.ssh/config`. It deliberately rejects shell metacharacters
 * (`$`, backticks, spaces, `;`, `|`, newlines, etc.) as a defence-in-depth
 * measure on top of the fact that we never invoke ssh through a shell.
 *
 * IPv6 literals with colons/brackets are intentionally not supported here —
 * remote servers over IPv6 should use a host-alias in `~/.ssh/config`.
 */
const HOST_REGEX = /^[A-Za-z0-9_.\-@:]+$/;

/**
 * Validate an ssh hostname before it is handed to `spawn('ssh', …)`.
 *
 * @throws {ValidationError} if `host` is empty / whitespace-only, contains
 *   control characters, or does not match {@link HOST_REGEX}.
 *
 * Exported so the HTTP route layer (slice 03) can validate before the
 * request ever reaches the manager.
 */
export function validateSshHost(host: unknown): asserts host is string {
  if (typeof host !== "string") {
    throw new ValidationError("invalid host: must be a string");
  }
  if (host.length === 0 || host.trim().length === 0) {
    throw new ValidationError("invalid host: must not be empty");
  }
  // Reject control characters (\x00–\x1F, \x7F) explicitly. The regex below
  // would also reject them, but a targeted message is friendlier.
   
  if (/[\x00-\x1F\x7F]/.test(host)) {
    throw new ValidationError("invalid host: contains control characters");
  }
  if (!HOST_REGEX.test(host)) {
    throw new ValidationError(
      `invalid host: ${JSON.stringify(host)} does not match ${HOST_REGEX.source}`,
    );
  }
}

/**
 * Validate a TCP port number is in the IANA-defined user range.
 *
 * @throws {ValidationError} if not a finite integer in [1, 65535].
 */
export function validatePort(value: unknown, label: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535
  ) {
    throw new ValidationError(
      `invalid ${label}: must be an integer in [1, 65535], got ${String(value)}`,
    );
  }
}

/**
 * Default port the remote flockctl daemon listens on.
 * Mirrors the value hard-coded in server-entry.ts / CLAUDE.md.
 */
const DEFAULT_REMOTE_DAEMON_PORT = 52077;

/**
 * Build the argv array for `spawn('ssh', …)` that opens a local port-forward
 * to the remote flockctl daemon.
 *
 * This is the authoritative translation of a {@link RemoteServerConfig} into
 * ssh CLI flags. The argv order and the conditional presence of each flag
 * match the spec in `slice.md` of slice 00 of the SSH-only remote-servers
 * milestone. Do NOT reorder casually — the classifier in a later task
 * depends on the invariant that `-L` is the forwarding spec.
 *
 * @param server - Remote server config. `server.ssh.host` is validated.
 * @param lport  - Local port allocated by the manager (must be 1..65535).
 * @returns argv WITHOUT the leading "ssh" program name, ready for
 *   `spawn('ssh', argv, {stdio: ['ignore', 'pipe', 'pipe']})`.
 *
 * @throws {ValidationError} if host / remotePort fail validation.
 */
export function buildSshArgs(server: RemoteServerConfig, lport: number): string[] {
  validatePort(lport, "local port");

  const { host, user, port, identityFile, remotePort } = server.ssh;
  validateSshHost(host);

  const rport = remotePort ?? DEFAULT_REMOTE_DAEMON_PORT;
  validatePort(rport, "remote port");

  // Identity file: accept any non-empty, non-control string. We don't constrain
  // the filesystem path shape beyond that; ssh itself will reject unreadable
  // files and the argv-array form means special characters can't be
  // interpreted by a shell.
  if (identityFile !== undefined) {
    if (typeof identityFile !== "string" || identityFile.length === 0) {
      throw new ValidationError("invalid identityFile: must be a non-empty string");
    }
     
    if (/[\x00-\x1F\x7F]/.test(identityFile)) {
      throw new ValidationError("invalid identityFile: contains control characters");
    }
  }

  if (user !== undefined) {
    if (typeof user !== "string" || user.length === 0) {
      throw new ValidationError("invalid user: must be a non-empty string");
    }
    if (!/^[A-Za-z0-9_.\-]+$/.test(user)) {
      throw new ValidationError(`invalid user: ${JSON.stringify(user)}`);
    }
  }

  const args: string[] = [
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "BatchMode=yes",
  ];

  // -p only when port is set and != 22.
  if (port !== undefined && port !== 22) {
    validatePort(port, "ssh port");
    args.push("-p", String(port));
  }

  // -i only when identityFile is set.
  if (identityFile !== undefined) {
    args.push("-i", identityFile);
  }

  args.push("-L", `127.0.0.1:${lport}:127.0.0.1:${rport}`);

  // Host comes last. If the config supplied a separate `user`, prepend it
  // here so the argv contains `user@host` as a single token (the ssh CLI's
  // canonical form). The host-alias path — where users put `Host foo` in
  // their `~/.ssh/config` — is supported by leaving `user` undefined.
  args.push(user !== undefined ? `${user}@${host}` : host);

  return args;
}
