/**
 * `flockctl remote-bootstrap` — one-shot setup for remote access.
 *
 * This command is the "I want to use flockctl from another machine" button:
 * it ensures the daemon is running, mints a labelled remote-access token,
 * and (optionally) prints the token to stdout for scripting. The shape of
 * the module:
 *
 *   1. Parse and validate the flags (--print-token / --label / --port).
 *   2. Reject inputs that would corrupt downstream state (control chars in
 *      the label, out-of-range ports) with a short stderr message and a
 *      non-zero exit code — no stack traces.
 *   3. Ensure the daemon is running on the requested port (spawn if needed,
 *      poll /health). Failure → exit code 2.
 *   4. Ensure a token exists for the given label (mint if missing). Failure
 *      → exit code 1.
 *   5. When `--print-token` is set, write `token + "\n"` to stdout. Nothing
 *      else is ever written to stdout by this command.
 *
 * Output contract (hard rules — enforced by tests):
 *   - stdout: silent unless `--print-token`, in which case exactly one line:
 *     `token + "\n"`. No banners, no color codes, no progress spinners.
 *   - stderr: reserved for error one-liners. MUST NOT contain the token —
 *     all error messages pass through {@link redactTokenLike} so a stray
 *     exception with a token in its `.message` can't leak it.
 *   - No `console.log` anywhere in this file. Tests grep for it. Use
 *     `process.stdout.write` / `process.stderr.write` explicitly so stream
 *     routing is visible in the code.
 *
 * Return code is a number, not `process.exit`, so unit tests can drive the
 * function directly and the top-level CLI entrypoint owns the final exit.
 */
import { Command, CommanderError } from "commander";
import { setTimeout as sleep } from "node:timers/promises";
import { getRunningPid, startDaemon as realStartDaemon } from "../daemon.js";
import { loadRc, saveRc } from "../config/paths.js";
import { generateRemoteAccessToken } from "../lib/token.js";

/** Inclusive ASCII control character ranges that we refuse to store in a
 * label. 0x00–0x1F covers NUL through US (including newline/tab); 0x7F is
 * DEL. Anything in these ranges would break the single-line encoding used by
 * the `~/.flockctlrc` writer. */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export interface RemoteBootstrapOptions {
  /** Label to attach to the minted token. Must not contain ASCII control
   * characters. Defaults to "unnamed". */
  label: string;
  /** TCP port the daemon should listen on. Must be an integer 1..65535.
   * Defaults to 52077, the daemon's documented default. */
  port: number;
  /** When true, print the bearer token to stdout (for scripting). When
   * false, the token is stored but not echoed. */
  printToken: boolean;
}

/**
 * Add the `remote-bootstrap` subcommand to the given commander program. This
 * is what makes `flockctl remote-bootstrap --help` list the flags. The
 * action delegates straight to {@link runRemoteBootstrap} so the flag
 * definitions live in exactly one place.
 */
export function registerRemoteBootstrapCommand(program: Command): void {
  program
    .command("remote-bootstrap")
    .description(
      "Ensure the daemon is running and mint a remote-access token in one " +
        "step. Intended for setting up a new client machine.",
    )
    .option("--print-token", "Print the minted token to stdout", false)
    .option("-l, --label <name>", "Label to attach to the token", "unnamed")
    .option("-p, --port <number>", "Port the daemon should listen on", "52077")
    .action(
      async (opts: { printToken?: boolean; label: string; port: string }) => {
        // Forward as argv so there is a single source of truth for parsing
        // and validation (see runRemoteBootstrap below).
        const forwarded: string[] = [];
        if (opts.printToken) forwarded.push("--print-token");
        forwarded.push("--label", opts.label);
        forwarded.push("--port", opts.port);
        const code = await runRemoteBootstrap(forwarded);
        if (code !== 0) process.exit(code);
      },
    );
}

/**
 * Injection points for {@link runRemoteBootstrap}. Production callers pass
 * nothing; tests override individual dependencies without touching real fetch,
 * real child processes, or the real `~/.flockctlrc`. Keeping this surface
 * narrow (two entry points: ensure-daemon, ensure-token) is deliberate —
 * every additional knob is another way the "pure stdout" contract could be
 * violated.
 */
export interface RunRemoteBootstrapDeps {
  ensureDaemon?: (port: number) => Promise<void>;
  ensureToken?: (label: string) => string;
}

/**
 * Scrub anything that looks like a bearer token out of a free-form string.
 *
 * Our tokens are `base64url(crypto.randomBytes(32))` — exactly 43 chars from
 * `[A-Za-z0-9_-]`. The regex matches any run of ≥ 20 of those chars, which
 * safely covers our tokens while only very rarely catching benign text
 * (paths with hashes, node_modules-like strings, etc.). False positives on
 * stderr are acceptable; token leaks are not.
 *
 * This function is intentionally the ONLY way error messages reach stderr in
 * this module. If you add a new `process.stderr.write` path, route the
 * message through here first.
 */
export function redactTokenLike(s: string): string {
  return s.replace(/[A-Za-z0-9_-]{20,}/g, "[REDACTED]");
}

/**
 * Parse an argv-style array, validate, and — for now — stub-return 0.
 *
 * We build a throwaway commander program with `exitOverride()` so that
 * `--help` / unknown-flag errors become thrown `CommanderError`s instead of
 * slamming the process down. That keeps the function test-friendly: callers
 * (and unit tests) get an integer exit code back, and commander's own
 * stdout/stderr output is routed through the shared process streams for
 * easy capture.
 *
 * The signature takes raw argv (not pre-parsed opts) so callers that invoke
 * us from outside commander — tests, the upcoming daemon bootstrap flow —
 * don't need to know about our flag names.
 */
export async function runRemoteBootstrap(
  argv: string[],
  deps: RunRemoteBootstrapDeps = {},
): Promise<number> {
  // Force NO_COLOR before any downstream module that might auto-color gets a
  // chance to read it. The `--print-token` path must be byte-exact: `token +
  // "\n"` and nothing else. Even a stray reset sequence would break pipelines
  // like `TOKEN=$(flockctl remote-bootstrap --print-token)`.
  process.env.NO_COLOR = "1";

  const parser = new Command();
  parser
    .name("remote-bootstrap")
    .exitOverride()
    .allowExcessArguments(false)
    .option("--print-token", "Print the minted token to stdout", false)
    .option("-l, --label <name>", "Label to attach to the token", "unnamed")
    .option("-p, --port <number>", "Port the daemon should listen on", "52077");

  let parsed: { printToken?: boolean; label: string; port: string };
  try {
    await parser.parseAsync(argv, { from: "user" });
    parsed = parser.opts();
  } catch (err) {
    if (err instanceof CommanderError) {
      // commander already wrote its own message (help text, unknown flag,
      // etc.) to the right stream. Forward its chosen exit code.
      return err.exitCode ?? 1;
    }
    throw err;
  }

  // --- label sanitation ---------------------------------------------------
  const label = parsed.label;
  if (hasControlChars(label)) {
    process.stderr.write("invalid label\n");
    return 1;
  }

  // --- port validation ----------------------------------------------------
  // commander gives us the raw string; we want a strictly-integer 1..65535.
  // Number("") === 0 and Number("12abc") === NaN, both of which we reject.
  const portStr = parsed.port;
  const port = Number(portStr);
  if (
    !Number.isInteger(port) ||
    !/^-?\d+$/.test(portStr) ||
    port < 1 ||
    port > 65535
  ) {
    process.stderr.write(`invalid port: ${portStr}\n`);
    return 1;
  }

  const options: RemoteBootstrapOptions = {
    label,
    port,
    printToken: parsed.printToken === true,
  };

  // Resolve the daemon / token helpers. Production callers pass nothing and
  // inherit the real implementations defined below; tests override these to
  // avoid spawning processes or writing to `~/.flockctlrc`.
  const ensureDaemon = deps.ensureDaemon ?? ensureDaemonRunning;
  const ensureToken = deps.ensureToken ?? ensureTokenForLabel;

  // --- step 1: daemon -----------------------------------------------------
  // Exit code 2 is reserved for "daemon didn't come up" so bootstrap scripts
  // can distinguish it from generic failures (exit 1). Any error message is
  // passed through redactTokenLike defensively — the daemon path shouldn't
  // ever see a token, but we're a security-sensitive entrypoint and the
  // cost of one regex call is meaningless.
  try {
    await ensureDaemon(options.port);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `bootstrap: daemon did not start: ${redactTokenLike(msg)}\n`,
    );
    return 2;
  }

  // --- step 2: token ------------------------------------------------------
  // ensureToken should never throw in production — if it does (disk full,
  // permission denied on ~/.flockctlrc, etc.) the message might contain
  // path fragments but never the minted token (the error happens before
  // the token is returned). Still redact defensively: if a future refactor
  // inlines the token into an exception message, the redactor is the
  // safety net.
  let token: string;
  try {
    token = ensureToken(options.label);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`bootstrap: ${redactTokenLike(msg)}\n`);
    return 1;
  }

  // --- step 3: stdout contract -------------------------------------------
  // The ONLY stdout write in this entire function. If --print-token is unset
  // we stay completely silent so a caller piping into a file gets an empty
  // file and knows to re-run with --print-token.
  if (options.printToken) {
    process.stdout.write(token + "\n");
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* ensureDaemonRunning                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when `ensureDaemonRunning` spawns (or races with a spawn of) the
 * daemon but `/health` never returns a 200 within the deadline. Carries a
 * stable `errorCode` so the CLI entrypoint can translate it into exit code 2
 * without parsing the message string.
 */
export class DaemonStartTimeoutError extends Error {
  readonly errorCode = "daemon_start_timeout" as const;
  readonly port: number;
  readonly deadlineMs: number;
  constructor(port: number, deadlineMs: number) {
    super(
      `daemon on port ${port} did not answer /health within ${deadlineMs}ms`,
    );
    this.name = "DaemonStartTimeoutError";
    this.port = port;
    this.deadlineMs = deadlineMs;
  }
}

/**
 * Dependencies that {@link ensureDaemonRunning} pulls from — broken out as a
 * parameter so tests can swap in fakes without touching global fetch / fs /
 * child_process. Every field is optional; production callers should pass
 * nothing and let the defaults win.
 */
export interface EnsureDaemonRunningDeps {
  /**
   * Spawn the daemon. Must be fire-and-forget: return as soon as the child
   * is forked (or a concurrent caller has taken responsibility). The `port`
   * mirrors what the caller passed to `ensureDaemonRunning` so fakes can
   * assert on it.
   */
  startDaemon?: (port: number) => void | Promise<void>;
  /**
   * Return true iff `GET /health` on the local daemon answers 200 within
   * `timeoutMs`. Any transport error / non-200 / timeout is `false` — we
   * never want a health probe to throw out of `ensureDaemonRunning`.
   */
  checkHealth?: (port: number, timeoutMs: number) => Promise<boolean>;
  /** Return the running daemon's pid, or null if the pidfile is absent /
   * stale. Defaults to {@link getRunningPid} from the daemon module. */
  readPid?: () => number | null;
  /** Sleep between poll iterations. Tests pass a fake clock. */
  sleep?: (ms: number) => Promise<void>;
}

/** Tuning knobs — exported so tests can assert on the exact numbers the spec
 * pins. */
export const ENSURE_DAEMON_FAST_HEALTH_TIMEOUT_MS = 500;
export const ENSURE_DAEMON_POLL_INTERVAL_MS = 100;
export const ENSURE_DAEMON_STARTUP_DEADLINE_MS = 5_000;

/**
 * In-process serialization: two concurrent `ensureDaemonRunning` calls in
 * the same Node process share a single promise so we don't double-spawn.
 * Cross-process concurrency is handled by the O_EXCL pidfile write in
 * {@link realStartDaemon}; this mutex only covers the intra-process race
 * that `remote-bootstrap` can trigger when a single bootstrap invocation
 * fans out.
 */
let inFlight: Promise<void> | null = null;

/**
 * Ensure a Flockctl daemon is answering `/health` on `port`. Fast path: if the
 * pidfile points at a live process and `/health` returns 200 within 500 ms,
 * return immediately with no side effects. Otherwise spawn the daemon via
 * {@link realStartDaemon} (detached, stdio ignored) and poll `/health` every
 * 100 ms up to {@link ENSURE_DAEMON_STARTUP_DEADLINE_MS}. If `/health` never
 * answers within that window, throw {@link DaemonStartTimeoutError} — the
 * caller is expected to translate this into exit code 2.
 */
export async function ensureDaemonRunning(
  port: number,
  deps: EnsureDaemonRunningDeps = {},
): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      await doEnsureDaemonRunning(port, deps);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function doEnsureDaemonRunning(
  port: number,
  deps: EnsureDaemonRunningDeps,
): Promise<void> {
  const startDaemon = deps.startDaemon ?? defaultStartDaemon;
  const checkHealth = deps.checkHealth ?? defaultCheckHealth;
  const readPid = deps.readPid ?? getRunningPid;
  const wait = deps.sleep ?? ((ms: number) => sleep(ms));

  // Fast path — daemon is already up and answering quickly. `getRunningPid`
  // also cleans up stale pidfiles, so a `null` return is a hard signal that
  // nothing is running (not just "we're not sure").
  const existingPid = readPid();
  if (existingPid !== null) {
    const healthy = await checkHealth(
      port,
      ENSURE_DAEMON_FAST_HEALTH_TIMEOUT_MS,
    );
    if (healthy) return;
  }

  // Spawn the daemon. `startDaemon` must not throw on an EEXIST pidfile —
  // the production implementation handles the concurrent-spawn case via
  // `claimPidFile`. Fakes in tests simulate the same behavior.
  await startDaemon(port);

  // Poll until /health answers or we hit the deadline. Each probe's timeout
  // is capped so a hung TCP accept can't eat the whole remaining budget.
  const deadline = Date.now() + ENSURE_DAEMON_STARTUP_DEADLINE_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const probeTimeout = Math.min(
      ENSURE_DAEMON_POLL_INTERVAL_MS * 2,
      Math.max(1, remaining),
    );
    if (await checkHealth(port, probeTimeout)) return;
    // Don't sleep past the deadline.
    const sleepFor = Math.min(
      ENSURE_DAEMON_POLL_INTERVAL_MS,
      Math.max(0, deadline - Date.now()),
    );
    if (sleepFor <= 0) break;
    await wait(sleepFor);
  }

  throw new DaemonStartTimeoutError(port, ENSURE_DAEMON_STARTUP_DEADLINE_MS);
}

/**
 * Production startDaemon wrapper. The underlying `realStartDaemon` is a CLI
 * helper that calls `process.exit` once the forked server announces it's
 * ready — which is exactly what we want from a fire-and-forget "make sure
 * the daemon is up" entrypoint. We wrap it so the async signature stays
 * consistent with fakes and so accidental exceptions (e.g. fork failing)
 * propagate instead of crashing the bootstrap.
 */
function defaultStartDaemon(port: number): void {
  realStartDaemon({ port, host: "127.0.0.1" });
}

/**
 * Default `/health` probe. Uses `fetch` with an AbortController so the call
 * respects `timeoutMs`. Any non-200 / thrown error / abort is mapped to
 * `false` — the caller's polling loop treats "health probe failed" and
 * "health probe timed out" identically.
 */
async function defaultCheckHealth(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reset the in-flight promise. Exposed for tests only — production code
 * should never call this. Each test that invokes `ensureDaemonRunning`
 * should call this in `afterEach` so state doesn't leak across cases.
 */
export function __resetEnsureDaemonRunningForTests(): void {
  inFlight = null;
}

/* -------------------------------------------------------------------------- */
/* ensureTokenForLabel                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Idempotently return a bearer token for `label`, minting one iff none
 * exists yet.
 *
 * Semantics (read → decide → write):
 *  1. Load `~/.flockctlrc` and scan `remoteAccessTokens` for an entry whose
 *     `label` matches exactly. If found, return that entry's `token`
 *     unchanged — no rc write, no mutation of neighbouring entries.
 *  2. Otherwise generate 32 bytes from `crypto.randomBytes(32)` rendered as
 *     base64url (43 chars, [A-Za-z0-9_-]), append
 *     `{label, token, createdAt: <ISO timestamp>}`, persist via `saveRc`,
 *     and return the freshly-minted token.
 *
 * Concurrency: the rc file has no cross-process lock today. Two parallel
 * `remote-bootstrap --label A` invocations can both miss A and each append
 * their own entry; the second bootstrap to run will then pick up whichever
 * entry wins the last `saveRc`. This is acceptable for v1 — documented in
 * the slice threat surface — and is why this helper is named
 * `ensureTokenForLabel` rather than `getOrCreate…`: callers must be prepared
 * to see a duplicate-label race resolved on the next invocation.
 *
 * No other entries in the list are mutated (bytewise). This is a soft
 * invariant that the unit test exercises against a 10-entry seed.
 */
export function ensureTokenForLabel(label: string): string {
  // Defensive copy of the top-level rc object so we never hand a mutated
  // cache reference back to `saveRc`'s memo. `loadRc()` currently returns
  // the cached dict by reference.
  const rc: Record<string, any> = { ...loadRc() };

  // Only accept well-formed entries (both label and token are strings).
  // Garbled entries are scrubbed from the rewrite — this matches
  // `addRemoteAccessToken` and keeps rc hygienic across bootstraps.
  // We copy the array so the push below doesn't touch the loadRc() cache.
  const existing: Array<Record<string, any>> = Array.isArray(
    rc.remoteAccessTokens,
  )
    ? rc.remoteAccessTokens.filter(
        (e: unknown): e is Record<string, any> =>
          !!e &&
          typeof e === "object" &&
          !Array.isArray(e) &&
          typeof (e as Record<string, any>).label === "string" &&
          typeof (e as Record<string, any>).token === "string",
      )
    : [];

  for (const entry of existing) {
    if (entry.label === label) {
      return entry.token as string;
    }
  }

  const token = generateRemoteAccessToken();
  existing.push({
    label,
    token,
    createdAt: new Date().toISOString(),
  });
  rc.remoteAccessTokens = existing;
  saveRc(rc);
  return token;
}
