/**
 * Classify the stderr output of an ssh child process into a stable error
 * code the UI can reason about.
 *
 * Contract:
 *   - `classifyStderr(stderr, exitCode)` is a pure function.
 *   - Pattern table order matters: more specific patterns come first
 *     (e.g. host-key mismatch wins over the auth-denied cascade that
 *     follows on a changed host key).
 *   - ANSI escape sequences are stripped before matching so colored
 *     output from ssh or a wrapping shell cannot defeat the regexes.
 *   - If no pattern matches but the exit code is 127, we assume the
 *     remote shell failed to exec `flockctl` and return
 *     `remote_flockctl_missing`.
 *   - Otherwise, for any non-zero exit code with no matching pattern,
 *     we return `unknown` and preserve the (ANSI-stripped, trimmed)
 *     stderr tail up to ~2KB so the UI can show it verbatim.
 *   - An exit code of 0 with no matching pattern is `ok`.
 */

// The canonical `TunnelErrorCode` union lives in ./types.ts (owned by the
// earlier slices of the SSH remote-servers milestone). Re-export so callers
// that only need the classifier don't need a second import.
export type { TunnelErrorCode } from "./types.js";
import type { TunnelErrorCode } from "./types.js";

export interface ClassifyResult {
  errorCode: TunnelErrorCode;
  rawStderr: string;
}

/**
 * Ordered pattern table. First match wins, so put the more specific /
 * higher-priority patterns first. In particular, `host_key_mismatch`
 * must come before `auth_failed` — when a server's host key changes,
 * ssh emits BOTH the scary "REMOTE HOST IDENTIFICATION HAS CHANGED"
 * banner AND a permission-denied line; the host-key warning is the
 * more important one for the user to see.
 */
const PATTERNS: Array<[RegExp, TunnelErrorCode]> = [
  [/REMOTE HOST IDENTIFICATION HAS CHANGED/i, "host_key_mismatch"],
  [/Host key verification failed/i, "host_key_mismatch"],
  [/Permission denied \(publickey/i, "auth_failed"],
  [/Permission denied/i, "auth_failed"],
  // `channel N: open failed` must come before the generic Connection-refused
  // pattern: ssh prints `channel 3: open failed: connect failed: Connection
  // refused` when the LOCAL forward reaches the remote sshd but the remote
  // daemon isn't listening — a materially different error from "couldn't
  // even reach sshd", and the UX needs to distinguish them.
  [/channel \d+: open failed: connect failed/i, "remote_daemon_down"],
  [/Connection refused/i, "connect_refused"],
  [/Name or service not known/i, "connect_refused"],
  [/Could not resolve hostname/i, "connect_refused"],
  [/flockctl.*(command not found|No such file)/i, "remote_flockctl_missing"],
];

const MAX_RAW_STDERR_BYTES = 2048;

/**
 * Strip CSI SGR (color / style) escape sequences. Matching on ANSI-clean
 * text guarantees that colored `ssh` output (or output piped through a
 * shell with a colorizing wrapper) doesn't defeat our regexes.
 */
export function stripAnsi(s: string): string {
   
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Keep the tail of the stderr, because the interesting diagnostic (the
 * last line ssh wrote before dying) is almost always at the end.
 */
function truncateTail(s: string, maxBytes: number): string {
  if (s.length <= maxBytes) return s;
  return s.slice(s.length - maxBytes);
}

export function classifyStderr(
  stderr: string,
  exitCode: number | null,
): ClassifyResult {
  const clean = stripAnsi(stderr ?? "");
  const rawStderr = truncateTail(clean, MAX_RAW_STDERR_BYTES);

  for (const [pattern, code] of PATTERNS) {
    if (pattern.test(clean)) {
      return { errorCode: code, rawStderr };
    }
  }

  // Exec-failed from the remote shell: the command didn't run at all.
  // `ssh user@host flockctl ...` exits 127 when the remote shell can't
  // find `flockctl`. We fall through here when the remote shell's error
  // string is unusual (busybox, fish, etc.) and doesn't match the
  // `command not found` regex above.
  if (exitCode === 127) {
    return { errorCode: "remote_flockctl_missing", rawStderr };
  }

  // Exit code 0 (clean shutdown) or null (still running — we're being
  // called from a stderr-read, pre-exit) with no matching pattern: no
  // known error. Surface `unknown` so callers can distinguish "nothing
  // interesting happened" from a specific failure; the rawStderr is
  // empty in the clean case and will simply be an empty tooltip.
  return { errorCode: "unknown", rawStderr };
}
