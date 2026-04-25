import { Hono } from "hono";
import { execa } from "execa";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import { listAgents } from "../services/agents/registry.js";
import {
  getDefaultModel,
  getPlanningModel,
  getDefaultAgent,
  getDefaultKeyId,
  setGlobalDefaults,
  getRemoteServers,
  deleteRemoteServer,
  updateRemoteServer,
} from "../config/index.js";
import { addRemoteServerWithToken } from "../config/remote-servers.js";
import type { RemoteServerConfig } from "../config/remote-servers.js";
import { getDb } from "../db/index.js";
import { aiProviderKeys } from "../db/schema.js";
import { desc, eq } from "drizzle-orm";
import {
  getInstallInfo,
  getPackageName,
  getPackageVersion,
  semverGt,
} from "../lib/package-version.js";
import {
  getUpdateState,
  setUpdateState,
} from "../services/update-state.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationError as AppValidationError,
} from "../lib/errors.js";
import { flattenZodError } from "../lib/zod-utils.js";
import { requireLoopback } from "../middleware/remote-auth.js";
import { SshTunnelManager } from "../services/ssh-tunnels/manager.js";
import {
  sshExec as realSshExec,
  SshExecTimeout,
  type SshExecResult,
} from "../services/ssh-tunnels/ssh-exec.js";
import {
  classifyStderr,
  type TunnelErrorCode,
} from "../services/ssh-tunnels/classify-stderr.js";
import type {
  RemoteServerConfig as TunnelRemoteServerConfig,
  SshTunnelHandle,
} from "../services/ssh-tunnels/types.js";

export const metaRoutes = new Hono();

/**
 * Enrich a persisted {@link RemoteServerConfig} with the live tunnel state
 * from the {@link SshTunnelManager}. The shape is the contract consumed by
 * slice-04's UI:
 *
 *   { id, name, ssh, tunnelStatus, tunnelPort, tunnelLastError, errorCode }
 *
 * `token` and `tokenLabel` are NEVER included — they live in
 * `~/.flockctlrc` only and the UI uses the dedicated proxy-token endpoint
 * to pull the bearer when it needs to talk to a remote daemon.
 *
 * `tunnelStatus` falls back to `"stopped"` when no canonical handle is
 * registered. That's the state after a daemon restart before autostart runs,
 * and after an explicit `stop`. The UI treats it the same as `error` for
 * the traffic-light colour, so we don't distinguish.
 */
function toEnriched(
  s: RemoteServerConfig,
  handle: SshTunnelHandle | null,
) {
  return {
    id: s.id,
    name: s.name,
    ssh: { ...s.ssh },
    tunnelStatus: handle?.status ?? ("stopped" as const),
    tunnelPort: handle?.localPort ?? null,
    tunnelLastError: handle?.rawStderr ?? null,
    errorCode: handle?.errorCode ?? null,
  };
}

async function parseBody<T>(c: import("hono").Context, schema: z.ZodType<T>): Promise<T> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Invalid JSON body");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("Invalid request body", flattenZodError(parsed.error));
  }
  return parsed.data;
}

// GET /meta/version — current daemon version + latest from npm registry
metaRoutes.get("/version", async (c) => {
  const current = getPackageVersion();
  const name = getPackageName();
  let latest: string | null = null;
  let error: string | null = null;
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://registry.npmjs.org/${name}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(to);
    if (!res.ok) throw new Error(`npm registry responded with ${res.status}`);
    const body = (await res.json()) as {
      "dist-tags"?: Record<string, string>;
    };
    const tags = body["dist-tags"] ?? {};
    const preferNext = current.includes("-");
    latest =
      (preferNext && tags.next) ? tags.next : (tags.latest ?? tags.next ?? null);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const updateAvailable =
    !!latest && current !== "unknown" && semverGt(latest, current);
  const install = getInstallInfo();
  return c.json({
    current,
    latest,
    updateAvailable,
    error,
    installMode: install.mode,
  });
});

// GET /meta/update — current state of the async update worker.
// See POST below for the transitions. Never blocks.
metaRoutes.get("/update", (c) => {
  return c.json(getUpdateState());
});

// POST /meta/update — fire-and-forget `npm install[ -g] <pkg>@<tag>` using the
// same mode the daemon was installed with. Returns 202 immediately; the caller
// polls `GET /meta/update` until status leaves "running". A second POST while
// one is running returns 409 so rapid clicks can't queue duplicate installs.
// For "unknown" install mode (running from source or an npx cache) we refuse.
metaRoutes.post("/update", (c) => {
  const current = getUpdateState();
  if (current.status === "running") {
    throw new ConflictError("Update already in progress", { status: current.status });
  }

  const name = getPackageName();
  const version = getPackageVersion();
  const tag = version.includes("-") ? "next" : "latest";
  const install = getInstallInfo();

  if (install.mode === "unknown") {
    throw new BadRequestError(
      "Cannot auto-update: the daemon is not running from an npm-installed package. Update the tool manually.",
      { installMode: install.mode },
    );
  }

  const args =
    install.mode === "global"
      ? ["install", "-g", `${name}@${tag}`]
      : ["install", `${name}@${tag}`];

  setUpdateState({ status: "running", targetVersion: tag });

  // Fire-and-forget: run npm in the background and record the outcome in the
  // state singleton. The HTTP response returns immediately (below).
  void (async () => {
    try {
      const result = await execa("npm", args, {
        timeout: 5 * 60_000,
        reject: false,
        ...(install.mode === "local" && install.root
          ? { cwd: install.root }
          : {}),
      });
      if (result.failed || result.exitCode !== 0) {
        setUpdateState({
          status: "error",
          error:
            (typeof result.stderr === "string" && result.stderr.trim()) ||
            `npm install exited with code ${result.exitCode}`,
          exitCode: result.exitCode,
          stdout: typeof result.stdout === "string" ? result.stdout : "",
          stderr: typeof result.stderr === "string" ? result.stderr : "",
          targetVersion: tag,
        });
      } else {
        setUpdateState({
          status: "success",
          stdout: typeof result.stdout === "string" ? result.stdout : "",
          stderr: typeof result.stderr === "string" ? result.stderr : "",
          targetVersion: tag,
        });
      }
    } catch (err) {
      setUpdateState({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        targetVersion: tag,
      });
    }
  })();

  return c.json(
    { triggered: true, targetVersion: tag, installMode: install.mode },
    202,
  );
});

// GET /meta/remote-servers — list remote servers (no tokens leaked)
//
// Each entry is enriched with live tunnel state from the manager so the
// slice-04 UI can render traffic-light indicators (ready / starting /
// error / stopped) without a second round-trip per server. The token and
// tokenLabel stay in `~/.flockctlrc` — the UI calls the dedicated
// `POST /meta/remote-servers/:id/proxy-token` endpoint when it needs the
// bearer to talk to a remote daemon.
metaRoutes.get("/remote-servers", (c) => {
  const servers = remoteServersPostDeps.listServers();
  const enriched = servers.map((s) => {
    const handle = remoteServersPostDeps.manager.getByServerId?.(s.id) ?? null;
    return toEnriched(s, handle);
  });
  return c.json(enriched);
});

// GET /meta/remote-servers/:id — fetch a single enriched server.
//
// 404 when the id is unknown. Same shape as the list endpoint so the UI
// can reuse the rendering component for both the list row and the detail
// panel.
metaRoutes.get("/remote-servers/:id", (c) => {
  const { id } = c.req.param();
  const server = remoteServersPostDeps.listServers().find((s) => s.id === id);
  if (!server) throw new NotFoundError("Server", id);
  const handle = remoteServersPostDeps.manager.getByServerId?.(id) ?? null;
  return c.json(toEnriched(server, handle));
});

// POST/PATCH /meta/remote-servers — add/update server
//
// TEMPORARY (slice 01/02): schema validates the SSH-only payload shape,
// but the persistence + tunnel bootstrap lands in slice 03. Handlers
// currently return 501 after successful validation so the negative-path
// tests (legacy rejection, malformed ssh config) can exercise the
// validation layer in isolation.
//
// The schemas are `.strict()` so any unknown top-level key — most
// importantly the legacy `url` / `token` keys from the pre-SSH client —
// triggers a Zod failure. The error-mapping helper (parseRemoteServerBody)
// inspects the *raw* body to decide between two errorCodes:
//   • `legacy_transport_rejected` when the raw body has `url` or `token`
//     at the top level. These are the two keys the pre-SSH UI/CLI posted
//     and we want a specific error message so the client can surface
//     "this daemon no longer supports direct HTTP; use SSH".
//   • `invalid_ssh_config` for every other shape failure — missing
//     `ssh`, bad `ssh.host`, out-of-range port, extra unknown keys, etc.

/**
 * Hostname pattern used for `ssh.host`.
 *
 * Permits the handful of forms real users type:
 *   • plain hostname (`web01`)
 *   • user@host (`alice@web01.example.com`)
 *   • dotted domain (`host.example.com`)
 *   • IPv4 literal (`192.168.1.1`)
 *   • optional `:port` suffix (`host:22`) — unusual but the ssh CLI
 *     tolerates it
 *   • `~/.ssh/config` host aliases (letters/digits/`_`/`-`/`.`)
 *
 * Deliberately rejects: whitespace, control characters, shell
 * metacharacters (`$`, backticks, `;`, `|`, parens, quotes), and any
 * non-ASCII character (emoji, smart quotes, etc.). We never invoke ssh
 * through a shell, but rejecting these up front gives users a crisp
 * 400 instead of an opaque ssh failure later.
 */
const SSH_HOST_REGEX = /^[A-Za-z0-9_.\-@:]+$/;

const sshConfigCreateSchema = z
  .object({
    host: z
      .string()
      .min(1, "ssh.host is required")
      .regex(SSH_HOST_REGEX, "ssh.host contains invalid characters"),
    user: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    identityFile: z.string().min(1).optional(),
    remotePort: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

export const remoteServerCreateSchema = z
  .object({
    name: z.string().trim().min(1, "name is required"),
    ssh: sshConfigCreateSchema,
  })
  .strict();

const sshConfigUpdateSchema = z
  .object({
    host: z
      .string()
      .min(1)
      .regex(SSH_HOST_REGEX, "ssh.host contains invalid characters")
      .optional(),
    user: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    identityFile: z.string().min(1).optional(),
    remotePort: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

export const remoteServerUpdateSchema = z
  .object({
    name: z.string().trim().min(1, "name must be a non-empty string").optional(),
    ssh: sshConfigUpdateSchema.optional(),
  })
  .strict();

type RemoteServerErrorCode = "legacy_transport_rejected" | "invalid_ssh_config";

interface RemoteServerValidationError {
  ok: false;
  errorCode: RemoteServerErrorCode;
  message: string;
}

/**
 * Parse + validate a remote-servers POST/PATCH body, mapping failure to
 * the `{errorCode, message}` shape the slice spec mandates.
 *
 * The discriminator between `legacy_transport_rejected` and
 * `invalid_ssh_config` is a dumb presence check on the raw body: if the
 * caller sent the legacy `url` / `token` top-level keys they get the
 * "legacy transport rejected" code, regardless of what else is in the
 * payload. Everything else (missing `ssh`, malformed `ssh.host`, extra
 * unknown keys) maps to `invalid_ssh_config`.
 */
async function parseRemoteServerBody<T>(
  c: import("hono").Context,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | RemoteServerValidationError> {
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errorCode: "invalid_ssh_config",
      message: "Invalid JSON body",
    };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };

  const rawObj = raw as Record<string, unknown>;
  const isLegacy =
    Object.prototype.hasOwnProperty.call(rawObj, "url") ||
    Object.prototype.hasOwnProperty.call(rawObj, "token");
  return isLegacy
    ? {
        ok: false,
        errorCode: "legacy_transport_rejected",
        message:
          "direct-HTTP remote servers are no longer supported; use ssh config instead",
      }
    : {
        ok: false,
        errorCode: "invalid_ssh_config",
        message: flattenFirstZodMessage(parsed.error),
      };
}

function flattenFirstZodMessage(err: z.ZodError): string {
  const first = err.issues[0];
  /* v8 ignore next — Zod errors always carry at least one issue when parsing fails; this fallback is structurally defensive */
  if (!first) return "invalid ssh config";
  const path = first.path.join(".");
  return path ? `${path}: ${first.message}` : first.message;
}

/**
 * Injectable dependencies for the `POST /meta/remote-servers` pipeline.
 *
 * Exported as a mutable object so unit tests can swap individual seams
 * (the SSH bootstrap exec, the tunnel manager, the rc persistence call,
 * the hostname source) without touching network, disk, or real ssh.
 *
 * Production callers never assign to this — the defaults wire up the
 * real {@link sshExec}, a process-wide {@link SshTunnelManager}, the
 * config/remote-servers persistence helpers, and `os.hostname()`.
 *
 * Tests MUST restore any replaced fields in `afterEach` or the next test
 * inherits the stub.
 */
export const remoteServersPostDeps: {
  sshExec: typeof realSshExec;
  manager: {
    start(server: TunnelRemoteServerConfig): Promise<SshTunnelHandle>;
    /**
     * Stop + evict a canonical tunnel. Optional on the type so legacy test
     * stubs (which only define `start`) still type-check; at runtime
     * handlers invoke it with `?.()` and fall through gracefully.
     */
    stop?(serverId: string): Promise<void>;
    /**
     * Resolve the live handle for a serverId — used by GET / PATCH to
     * enrich the rc entry with the current `status` / `localPort` /
     * `errorCode` / `rawStderr`. Optional for the same reason as `stop`.
     */
    getByServerId?(serverId: string): SshTunnelHandle | null;
  };
  saveServer: typeof addRemoteServerWithToken;
  /**
   * Partial-update a persisted rc entry (`name` and/or `ssh.*`). Returns
   * `null` if the entry does not exist. Invoked by PATCH for both the
   * name-only and the ssh-config change paths.
   */
  updateServer: typeof updateRemoteServer;
  deleteServer: (id: string) => boolean;
  /**
   * Enumerate persisted rc entries. Funneled through the deps so tests
   * can back the rc with an in-memory store instead of `~/.flockctlrc`,
   * matching the approach used by {@link saveServer} and
   * {@link deleteServer}.
   */
  listServers: typeof getRemoteServers;
  hostname: () => string;
  /**
   * Test-only hook that runs after the rc write but before `manager.start`.
   * A throw here simulates a daemon crash between persistence and tunnel
   * open — the handler does NOT catch this, and the rc entry stays on disk
   * so the next-boot autostart retries the tunnel. This is the
   * forward-recovery contract documented in slice 03.
   */
  afterSaveBeforeStart?: (id: string) => void;
} = {
  sshExec: realSshExec,
  manager: new SshTunnelManager(),
  saveServer: addRemoteServerWithToken,
  updateServer: updateRemoteServer,
  deleteServer: deleteRemoteServer,
  listServers: getRemoteServers,
  hostname: () => osHostname(),
};

/** Maximum wall-clock for the remote bootstrap exec. Tight bound — the
 * command is IO-light and a hung ssh shouldn't hold the HTTP request
 * open indefinitely. Matches slice 03's "within 10s" success criterion. */
const BOOTSTRAP_EXEC_TIMEOUT_MS = 10_000;

/** Shape of a base64url remote-access token: the exact 43-char form the CLI
 * mints (`base64url(crypto.randomBytes(32))`) is always ≥ 20 chars and only
 * contains `[A-Za-z0-9_-]`. Reject anything else as `bootstrap_bad_output`
 * — stdout pollution (progress dots, warnings, a `Hello, World!` banner)
 * would otherwise get stored as a "token" and silently break the remote. */
const TOKEN_REGEX = /^[A-Za-z0-9_-]{20,}$/;

/**
 * POST /meta/remote-servers — wired end-to-end per the slice 03 pipeline.
 *
 *    1. zod-validate → 400 invalid_ssh_config / legacy_transport_rejected
 *    2. assign id = crypto.randomUUID()
 *    3. label = `flockctl-local-${os.hostname()}`
 *    4. sshExec(server, ["flockctl","remote-bootstrap","--print-token",
 *       "--label",label]) → classify ssh exit+stderr on failure → 502 with
 *       errorCode, no rc write
 *    5. trimmed stdout → TOKEN_REGEX match → 502 bootstrap_bad_output on
 *       mismatch, no rc write
 *    6. saveRc with {id, name, ssh, token, tokenLabel} → 500
 *       persistence_failed on throw
 *    7. manager.start → wait for "ready" (bounded by probe timeout). On
 *       timeout/error: DELETE the rc entry, return 502 with the tunnel's
 *       errorCode (or "tunnel_open_timeout"). This rollback is the
 *       *synchronous feedback* half of the contract — the user can always
 *       recreate or Reconnect via the explicit endpoints.
 *    8. return 201 with {id, name, ssh, tunnelPort, tunnelStatus: "ready"}.
 *       The token is NEVER echoed in the response body.
 *
 * `requireLoopback` is applied as route-level middleware so a remote-
 * token-holder cannot create a new remote from another machine (the
 * token would never reach their browser; only the local UI has it). In
 * local-only mode (no remote auth configured) the gate is a no-op.
 */
metaRoutes.post("/remote-servers", requireLoopback, async (c) => {
  // ---- Step 1: zod validation -------------------------------------------
  const result = await parseRemoteServerBody(c, remoteServerCreateSchema);
  if (!result.ok) {
    return c.json(
      {
        errorCode: result.errorCode,
        error: result.message,
        message: result.message,
      },
      400,
    );
  }

  // ---- Step 2: assign id + step 3: derive label -------------------------
  const id = randomUUID();
  const label = `flockctl-local-${remoteServersPostDeps.hostname()}`;
  const serverShape: TunnelRemoteServerConfig = {
    id,
    name: result.data.name,
    ssh: { ...result.data.ssh },
  };

  // ---- Step 4: ssh-exec the remote bootstrap ----------------------------
  //
  // The argv is fixed and validated downstream (`buildExecArgv` rejects
  // control chars in every element). sshExec returns `{stdout, stderr,
  // exitCode}` on any child exit — we only classify on a non-zero exit.
  // A thrown SshExecTimeout / ValidationError / spawn error is mapped to
  // 502 with errorCode=unknown; the user retries.
  let execResult: SshExecResult;
  try {
    execResult = await remoteServersPostDeps.sshExec(
      serverShape,
      [
        "flockctl",
        "remote-bootstrap",
        "--print-token",
        "--label",
        label,
      ],
      { timeoutMs: BOOTSTRAP_EXEC_TIMEOUT_MS },
    );
  } catch (err) {
    // Validation error from the ssh-exec argv builder (bad identityFile,
    // bad user, bad port) is the caller's fault — map to 400 with the
    // schema errorCode. Every other error (SshExecTimeout, spawn error)
    // is a 502: we tried and couldn't talk to the remote.
    if (err instanceof AppValidationError) {
      return c.json(
        {
          errorCode: "invalid_ssh_config",
          error: err.message,
          message: err.message,
        },
        400,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    const code: TunnelErrorCode =
      err instanceof SshExecTimeout ? "connect_refused" : "unknown";
    return c.json(
      {
        errorCode: code,
        error: `bootstrap exec failed: ${msg}`,
      },
      502,
    );
  }

  if (execResult.exitCode !== 0) {
    const classified = classifyStderr(execResult.stderr, execResult.exitCode);
    return c.json(
      {
        errorCode: classified.errorCode,
        error: `bootstrap failed (exit ${execResult.exitCode})`,
        rawStderr: classified.rawStderr,
      },
      502,
    );
  }

  // ---- Step 5: validate the token shape ---------------------------------
  const token = execResult.stdout.trim();
  if (!TOKEN_REGEX.test(token)) {
    return c.json(
      {
        errorCode: "bootstrap_bad_output",
        error: "remote bootstrap returned unexpected output",
      },
      502,
    );
  }

  // ---- Step 6: persist the rc entry -------------------------------------
  //
  // Token and tokenLabel are written inline with the SSH config so there
  // is exactly ONE 0o600 write for the full create. On throw we return
  // 500 persistence_failed — disk-full / EACCES / etc.
  try {
    remoteServersPostDeps.saveServer({
      id,
      name: serverShape.name,
      ssh: serverShape.ssh,
      token,
      tokenLabel: label,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        errorCode: "persistence_failed",
        error: `failed to persist remote server: ${msg}`,
      },
      500,
    );
  }

  // ---- Fault-injection seam for crash-simulation tests ------------------
  //
  // A throw from this hook intentionally escapes the handler WITHOUT
  // rolling back the rc entry — that's the forward-recovery contract for
  // a real daemon crash between saveRc and manager.start: autostart on
  // next boot retries the tunnel. Production callers leave this unset.
  if (remoteServersPostDeps.afterSaveBeforeStart) {
    remoteServersPostDeps.afterSaveBeforeStart(id);
  }

  // ---- Step 7: bring the tunnel up --------------------------------------
  let handle: SshTunnelHandle;
  try {
    handle = await remoteServersPostDeps.manager.start(serverShape);
  } catch (err) {
    // Any throw from manager.start is a synchronous failure (port alloc,
    // argv validation) — rollback and report. We intentionally do NOT
    // use a broad try/catch around the saveServer call above, because a
    // throw there already prevented the rc write.
    remoteServersPostDeps.deleteServer(id);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        errorCode: "tunnel_open_timeout",
        error: `tunnel failed to open: ${msg}`,
      },
      502,
    );
  }

  if (handle.status !== "ready") {
    remoteServersPostDeps.deleteServer(id);
    // Distinguish "probe timed out" (rawStderr === 'ready-gate timeout',
    // errorCode === 'unknown' per manager.start) from a classified child
    // exit. Both map to 502 but the errorCode surfaced to the UI differs.
    const isTimeout =
      handle.rawStderr === "ready-gate timeout" || handle.status === "starting";
    const errorCode: TunnelErrorCode = isTimeout
      ? ("tunnel_open_timeout" as TunnelErrorCode)
      : (handle.errorCode ?? "unknown");
    return c.json(
      {
        errorCode,
        error:
          handle.rawStderr ??
          `tunnel did not reach 'ready' (status=${handle.status})`,
      },
      502,
    );
  }

  // ---- Step 8: success shape — no token, no tokenLabel ------------------
  return c.json(
    {
      id,
      name: serverShape.name,
      ssh: serverShape.ssh,
      tunnelPort: handle.localPort,
      tunnelStatus: "ready" as const,
    },
    201,
  );
});

/**
 * PATCH /meta/remote-servers/:id — update name and/or ssh config.
 *
 * Change-detection discriminates two paths with very different side effects:
 *
 *   • Name-only (or no-op) change → just `saveRc`. The tunnel is NOT
 *     restarted; rename is purely cosmetic so there's no reason to disturb
 *     a ready tunnel.
 *   • Any `ssh.*` field changed → stop the existing tunnel, persist the
 *     new config, start a fresh tunnel, wait for `ready`. Error mapping
 *     mirrors the POST pipeline exactly — a classified manager error
 *     surfaces its `errorCode`; a timeout / synchronous throw maps to
 *     `tunnel_open_timeout`.
 *
 * The stop → saveRc → start ordering is deliberate:
 *   - stop first so the old ssh child is reaped before we mutate the rc
 *     (autostart on a hypothetical crash in the middle wouldn't observe
 *     a stale config against a live tunnel).
 *   - saveRc second so the rc always reflects the desired state, even if
 *     the subsequent start fails (consistent with the forward-recovery
 *     contract in POST).
 *   - start last, with the updated config.
 *
 * `requireLoopback` matches the POST handler: a remote token holder must
 * not be able to hijack somebody else's tunnel by swapping the SSH target.
 */
metaRoutes.patch("/remote-servers/:id", requireLoopback, async (c) => {
  const { id } = c.req.param();

  // ---- Step 1: validate body (same error-mapping as POST) ---------------
  const result = await parseRemoteServerBody(c, remoteServerUpdateSchema);
  if (!result.ok) {
    return c.json(
      {
        errorCode: result.errorCode,
        error: result.message,
        message: result.message,
      },
      400,
    );
  }
  const body = result.data;

  // ---- Step 2: confirm the target exists --------------------------------
  const current = remoteServersPostDeps
    .listServers()
    .find((s) => s.id === id);
  if (!current) throw new NotFoundError("Server", id);

  // ---- Step 3: change detection -----------------------------------------
  //
  // Any of the five ssh fields differing from `current.ssh` counts as an
  // ssh change. We deliberately compare against the CURRENT value (not
  // "key present in body") so a caller who PATCHes with the same host
  // they already have doesn't trigger a tunnel restart.
  const SSH_KEYS = ["host", "user", "port", "identityFile", "remotePort"] as const;
  const sshChanged =
    !!body.ssh &&
    SSH_KEYS.some(
      (k) => body.ssh![k] !== undefined && body.ssh![k] !== current.ssh[k],
    );
  const nameChanged = body.name !== undefined && body.name !== current.name;

  if (!sshChanged) {
    // ---- Name-only or no-op path: just update the rc, no tunnel churn -
    if (nameChanged) {
      remoteServersPostDeps.updateServer(id, { name: body.name });
    }
    const updated =
      remoteServersPostDeps.listServers().find((s) => s.id === id) ?? current;
    const handle =
      remoteServersPostDeps.manager.getByServerId?.(id) ?? null;
    return c.json(toEnriched(updated, handle));
  }

  // ---- Step 4: stop the existing tunnel before mutating the rc ----------
  //
  // Stop failures are logged but don't abort the PATCH. A dead ssh child
  // we can't signal is already "stopped" from the user's perspective, and
  // the user's intent is a reconfiguration — we shouldn't block it on the
  // old tunnel's corpse.
  try {
    await remoteServersPostDeps.manager.stop?.(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[flockctl] manager.stop failed during PATCH for ${id}: ${msg}`,
    );
  }

  // ---- Step 5: persist the new config -----------------------------------
  const updated = remoteServersPostDeps.updateServer(id, {
    name: body.name,
    ssh: body.ssh,
  });
  if (!updated) {
    // Defensive — another caller deleted the entry between our initial
    // lookup and the update. Surface 404 rather than a misleading 500.
    throw new NotFoundError("Server", id);
  }

  // ---- Step 6: start a fresh tunnel with the updated config -------------
  const tunnelConfig: TunnelRemoteServerConfig = {
    id: updated.id,
    name: updated.name,
    ssh: { ...updated.ssh },
  };

  let handle: SshTunnelHandle;
  try {
    handle = await remoteServersPostDeps.manager.start(tunnelConfig);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        errorCode: "tunnel_open_timeout",
        error: `tunnel failed to open: ${msg}`,
      },
      502,
    );
  }

  if (handle.status !== "ready") {
    // Same discriminator as the POST handler: probe timeout vs classified
    // child exit. Both are 502; the errorCode surfaced to the UI differs.
    const isTimeout =
      handle.rawStderr === "ready-gate timeout" || handle.status === "starting";
    const errorCode: TunnelErrorCode = isTimeout
      ? ("tunnel_open_timeout" as TunnelErrorCode)
      : (handle.errorCode ?? "unknown");
    return c.json(
      {
        errorCode,
        error:
          handle.rawStderr ??
          `tunnel did not reach 'ready' (status=${handle.status})`,
      },
      502,
    );
  }

  // ---- Step 7: success — return the enriched shape ---------------------
  return c.json(toEnriched(updated, handle));
});

/**
 * DELETE /meta/remote-servers/:id — stop tunnel, then remove the rc entry.
 *
 * Call order is stop → deleteServer → 204. A stop throw is logged and
 * swallowed — the rc entry still gets removed so the UI-level "delete"
 * gesture is idempotent from the user's perspective. If we returned an
 * error here the UI would be stuck with a row it can't dismiss every time
 * ssh is in a bad state.
 *
 * `requireLoopback` gate matches POST/PATCH: a remote-token holder should
 * never be able to tear down their own tunnel from the remote side.
 */
metaRoutes.delete("/remote-servers/:id", requireLoopback, async (c) => {
  const { id } = c.req.param();
  const exists = remoteServersPostDeps
    .listServers()
    .some((s) => s.id === id);
  if (!exists) throw new NotFoundError("Server", id);

  try {
    await remoteServersPostDeps.manager.stop?.(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[flockctl] manager.stop failed during DELETE for ${id}: ${msg}`,
    );
  }

  remoteServersPostDeps.deleteServer(id);
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Tunnel lifecycle — GET /status, POST /start, /stop, /restart
//
// Every route is loopback-only: these endpoints mutate (or expose the
// stderr of) a long-running ssh child, which is not something a remote
// bearer-token holder should be able to do — even a legitimate one. The
// local UI owns the lifecycle.
//
// The canonical manager instance is shared with the POST /remote-servers
// create pipeline (see `remoteServersPostDeps.manager`) so a tunnel opened
// by create can be stopped/restarted by these routes later. Tests swap out
// `tunnelLifecycleDeps.manager` independently.
//
// `rawStderrTail` is capped at 4KB regardless of what the manager holds —
// log-bomb protection so a misbehaving sshd or remote shell that spews
// tens of megabytes of stderr can't blow up the UI's response size.
// ---------------------------------------------------------------------------

/** Max bytes of stderr we echo back in the status response. */
const RAW_STDERR_TAIL_BYTES = 4096;

interface TunnelLifecycleManager {
  start(server: TunnelRemoteServerConfig): Promise<SshTunnelHandle>;
  stop(serverId: string): Promise<void>;
  restart(serverId: string): Promise<SshTunnelHandle>;
  getByServerId(serverId: string): SshTunnelHandle | null;
}

/**
 * Injectable deps for the tunnel lifecycle routes.
 *
 * In production this points at the same {@link SshTunnelManager} instance
 * as `remoteServersPostDeps.manager` — a tunnel opened by create must be
 * observable / stoppable / restartable here. Tests replace the field with
 * a stub that returns synthetic handles so no real ssh children run.
 */
export const tunnelLifecycleDeps: {
  manager: TunnelLifecycleManager;
} = {
  manager: remoteServersPostDeps.manager as TunnelLifecycleManager,
};

function tailStderr(raw: string | undefined | null): string {
  if (!raw) return "";
  if (raw.length <= RAW_STDERR_TAIL_BYTES) return raw;
  return raw.slice(raw.length - RAW_STDERR_TAIL_BYTES);
}

/**
 * Serialize a canonical handle for the four lifecycle routes. When no
 * handle exists (server configured but tunnel never started), we emit a
 * "stopped" shell with null port / readyAt so the UI always gets the same
 * five keys and can render without a special case.
 */
function tunnelStatusResponse(handle: SshTunnelHandle | null) {
  if (!handle) {
    return {
      status: "stopped" as const,
      errorCode: null,
      tunnelPort: null,
      lastReadyAt: null,
      rawStderrTail: "",
    };
  }
  return {
    status: handle.status,
    errorCode: handle.errorCode ?? null,
    tunnelPort: handle.localPort,
    lastReadyAt: handle.readyAt ?? null,
    rawStderrTail: tailStderr(handle.rawStderr),
  };
}

/**
 * Look up the persisted server config, 404 if missing, and return the
 * {@link TunnelRemoteServerConfig} shape the manager expects. Keeps the
 * four routes from repeating the same lookup + not-found dance.
 */
function resolveServerConfig(id: string): TunnelRemoteServerConfig {
  const server = getRemoteServers().find((s) => s.id === id);
  if (!server) throw new NotFoundError("Server", id);
  return {
    id: server.id,
    name: server.name,
    ssh: { ...server.ssh },
  };
}

// GET /meta/remote-servers/:id/tunnel/status
metaRoutes.get("/remote-servers/:id/tunnel/status", requireLoopback, (c) => {
  const { id } = c.req.param();
  // Validate the server exists so clients get 404 for a bad id rather
  // than a "stopped" mirage for a server that never existed.
  resolveServerConfig(id);
  const handle = tunnelLifecycleDeps.manager.getByServerId(id);
  return c.json(tunnelStatusResponse(handle));
});

// POST /meta/remote-servers/:id/tunnel/start
metaRoutes.post("/remote-servers/:id/tunnel/start", requireLoopback, async (c) => {
  const { id } = c.req.param();
  const server = resolveServerConfig(id);
  // manager.start awaits the ready-gate internally (10s default budget),
  // so we simply await its resolution. On error it returns a handle with
  // status="error" rather than throwing — we forward that verbatim.
  const handle = await tunnelLifecycleDeps.manager.start(server);
  return c.json(tunnelStatusResponse(handle));
});

// POST /meta/remote-servers/:id/tunnel/stop
metaRoutes.post("/remote-servers/:id/tunnel/stop", requireLoopback, async (c) => {
  const { id } = c.req.param();
  // Validate but don't hold onto the config — stop() only needs the id.
  resolveServerConfig(id);
  await tunnelLifecycleDeps.manager.stop(id);
  // stop() evicts the canonical entry; there is nothing to echo back.
  // Return the minimal shape promised by the slice spec.
  return c.json({ status: "stopped" as const });
});

// POST /meta/remote-servers/:id/tunnel/restart
metaRoutes.post("/remote-servers/:id/tunnel/restart", requireLoopback, async (c) => {
  const { id } = c.req.param();
  // Validating the server exists here lets us 404 cleanly for a missing
  // server. The manager itself throws on "no canonical entry" — that's
  // a different error (tunnel was never started) and we want to let it
  // surface via the default error mapper.
  resolveServerConfig(id);
  const handle = await tunnelLifecycleDeps.manager.restart(id);
  return c.json(tunnelStatusResponse(handle));
});

// POST /meta/remote-servers/:id/proxy-token — hand token to the local UI
metaRoutes.post("/remote-servers/:id/proxy-token", (c) => {
  const { id } = c.req.param();
  const server = getRemoteServers().find((s) => s.id === id);
  if (!server) throw new NotFoundError("Server", id);
  return c.json({ token: server.token ?? null });
});

// GET /meta — available agents and models
metaRoutes.get("/", (c) => {
  const agents: Array<{ id: string; name: string; available: boolean }> = [];
  const models: Array<{ id: string; name: string; agent: string }> = [];

  for (const provider of listAgents()) {
    const ready = provider.checkReadiness().ready;
    agents.push({ id: provider.id, name: provider.displayName, available: ready });
    if (ready) {
      for (const m of provider.listModels()) {
        models.push({ id: m.id, name: m.name, agent: provider.id });
      }
    }
  }

  // AI Provider Keys from DB
  const db = getDb();
  const allKeys = db.select().from(aiProviderKeys).orderBy(desc(aiProviderKeys.priority)).all();
  const keys = allKeys.map(k => ({
    id: k.id,
    name: k.label || `Key #${k.id}`,
    provider: k.provider,
    isActive: k.isActive ?? true,
  }));

  return c.json({
    agents,
    models,
    keys,
    defaults: {
      model: getDefaultModel(),
      planningModel: getPlanningModel(),
      agent: getDefaultAgent(),
      keyId: getDefaultKeyId(),
    },
  });
});

// PATCH /meta/defaults — update global defaults in ~/.flockctlrc
const defaultsUpdateSchema = z.object({
  defaultModel: z.union([z.string(), z.null()]).optional(),
  defaultKeyId: z.union([z.number().int().positive(), z.null()]).optional(),
});

metaRoutes.patch("/defaults", async (c) => {
  const data = await parseBody(c, defaultsUpdateSchema);

  const update: { defaultModel?: string | null; defaultKeyId?: number | null } = {};

  if (data.defaultModel !== undefined) {
    update.defaultModel = data.defaultModel === "" ? null : data.defaultModel;
  }

  if (data.defaultKeyId !== undefined) {
    if (data.defaultKeyId === null) {
      update.defaultKeyId = null;
    } else {
      const db = getDb();
      const key = db
        .select()
        .from(aiProviderKeys)
        .where(eq(aiProviderKeys.id, data.defaultKeyId))
        .get();
      if (!key) throw new NotFoundError("Provider key", data.defaultKeyId);
      update.defaultKeyId = data.defaultKeyId;
    }
  }

  if (Object.keys(update).length === 0) {
    throw new BadRequestError("No valid fields to update");
  }

  setGlobalDefaults(update);
  return c.json({
    model: getDefaultModel(),
    planningModel: getPlanningModel(),
    agent: getDefaultAgent(),
    keyId: getDefaultKeyId(),
  });
});
