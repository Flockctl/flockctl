/**
 * Tunnel lifecycle routes — GET /status, POST /start, /stop, /restart.
 *
 * The four routes operate on a canonical {@link SshTunnelHandle} keyed by
 * serverId. They are loopback-only so a remote bearer-token holder cannot
 * drive the ssh child lifecycle of the local daemon from off-box.
 *
 * Every test here stubs `tunnelLifecycleDeps.manager` with a synthetic
 * implementation so no real ssh spawn happens. A per-test in-memory rc
 * store stands in for the real `getRemoteServers()` — we swap out
 * `$HOME` to an isolated tmp dir before any test runs so a stray write
 * can't mutate the developer's rc.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { tunnelLifecycleDeps } from "../../routes/meta.js";
import { _resetRcCache } from "../../config/paths.js";
import { addRemoteServerWithToken } from "../../config/remote-servers.js";
import { _resetRateLimiter } from "../../middleware/remote-auth.js";
import * as config from "../../config/index.js";
import type { SshTunnelHandle } from "../../services/ssh-tunnels/types.js";
import type { RemoteServerConfig as TunnelRemoteServerConfig } from "../../services/ssh-tunnels/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "0123456789abcdef0123456789abcdef0123";

function remoteEnv(ip = "203.0.113.7") {
  return {
    incoming: { socket: { remoteAddress: ip } },
  } as unknown as Record<string, unknown>;
}

function localhostEnv() {
  return {
    incoming: { socket: { remoteAddress: "127.0.0.1" } },
  } as unknown as Record<string, unknown>;
}

// Mutable handle map the synthetic manager reads from. Each test case
// resets it in `beforeEach` so handles don't leak across tests.
const handleById = new Map<string, SshTunnelHandle>();

// Call-log for assertions on manager.stop / manager.restart arguments.
let startCalls: Array<TunnelRemoteServerConfig> = [];
let stopCalls: string[] = [];
let restartCalls: string[] = [];

// Per-test overrides — default to "resolve with the current handle",
// test swaps in a bespoke implementation to exercise error paths.
let startImpl: (s: TunnelRemoteServerConfig) => Promise<SshTunnelHandle> =
  async (s) => handleById.get(s.id) ?? readyHandle(s.id, 52078);
let stopImpl: (serverId: string) => Promise<void> = async (serverId) => {
  handleById.delete(serverId);
};
let restartImpl: (serverId: string) => Promise<SshTunnelHandle> = async (
  serverId,
) => handleById.get(serverId) ?? readyHandle(serverId, 52079);

const origDeps = tunnelLifecycleDeps.manager;

// ---------------------------------------------------------------------------
// Lifecycle setup
// ---------------------------------------------------------------------------

let db: FlockctlDb;
let sqlite: Database.Database;
let tmpHome: string;
const origHome = process.env.HOME;

beforeAll(() => {
  // Isolate `$HOME` so rc writes from `addRemoteServerWithToken` below
  // can't touch the developer's real ~/.flockctlrc. os.homedir() re-reads
  // $HOME on every call, and _resetRcCache clears the cached load.
  tmpHome = mkdtempSync(join(tmpdir(), "flockctl-tunnel-lifecycle-"));
  process.env.HOME = tmpHome;
  _resetRcCache();

  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  _resetRcCache();
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  tunnelLifecycleDeps.manager = origDeps;
  sqlite.close();
});

beforeEach(() => {
  _resetRateLimiter();
  vi.restoreAllMocks();

  handleById.clear();
  startCalls = [];
  stopCalls = [];
  restartCalls = [];

  // Reset the per-test overrides to the defaults (see declarations above).
  startImpl = async (s) => handleById.get(s.id) ?? readyHandle(s.id, 52078);
  stopImpl = async (serverId) => {
    handleById.delete(serverId);
  };
  restartImpl = async (serverId) =>
    handleById.get(serverId) ?? readyHandle(serverId, 52079);

  tunnelLifecycleDeps.manager = {
    start: async (s) => {
      startCalls.push(s);
      const h = await startImpl(s);
      handleById.set(s.id, h);
      return h;
    },
    stop: async (serverId) => {
      stopCalls.push(serverId);
      await stopImpl(serverId);
    },
    restart: async (serverId) => {
      restartCalls.push(serverId);
      const h = await restartImpl(serverId);
      handleById.set(serverId, h);
      return h;
    },
    getByServerId: (serverId) => handleById.get(serverId) ?? null,
  };

  // Fresh rc file for every test. `_resetRcCache` forces the next
  // loadRc() to re-read from disk.
  rmSync(join(tmpHome, ".flockctlrc"), { force: true });
  _resetRcCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function readyHandle(
  serverId: string,
  localPort: number,
  overrides: Partial<SshTunnelHandle> = {},
): SshTunnelHandle {
  return {
    serverId,
    localPort,
    status: "ready",
    readyAt: 1_700_000_000_000,
    ...overrides,
  };
}

function errorHandle(
  serverId: string,
  localPort: number,
  errorCode: SshTunnelHandle["errorCode"],
  rawStderr: string,
): SshTunnelHandle {
  return {
    serverId,
    localPort,
    status: "error",
    errorCode,
    rawStderr,
  };
}

/**
 * Seed a server in the rc file so the routes' config lookup succeeds.
 * Returns the assigned id for use in the request URL.
 */
function seedServer(
  name = "prod",
  sshHost = "web01",
): { id: string } {
  const id = `srv-${name}-${Math.random().toString(36).slice(2, 8)}`;
  addRemoteServerWithToken({
    id,
    name,
    ssh: { host: sshHost },
    token: "A".repeat(43),
    tokenLabel: "flockctl-local-test",
  });
  return { id };
}

// ---------------------------------------------------------------------------
// GET /meta/remote-servers/:id/tunnel/status
// ---------------------------------------------------------------------------

describe("GET /meta/remote-servers/:id/tunnel/status", () => {
  it("returns a 'stopped' shell when the server has no live tunnel", async () => {
    const { id } = seedServer();

    const res = await app.request(`/meta/remote-servers/${id}/tunnel/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "stopped",
      errorCode: null,
      tunnelPort: null,
      lastReadyAt: null,
      rawStderrTail: "",
    });
  });

  it("returns the ready handle shape for a live tunnel", async () => {
    const { id } = seedServer();
    handleById.set(id, readyHandle(id, 54321));

    const res = await app.request(`/meta/remote-servers/${id}/tunnel/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "ready",
      errorCode: null,
      tunnelPort: 54321,
      lastReadyAt: 1_700_000_000_000,
      rawStderrTail: "",
    });
  });

  it("surfaces errorCode + rawStderrTail for a handle in error state", async () => {
    const { id } = seedServer();
    handleById.set(
      id,
      errorHandle(id, 52078, "auth_failed", "Permission denied (publickey)."),
    );

    const res = await app.request(`/meta/remote-servers/${id}/tunnel/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.errorCode).toBe("auth_failed");
    expect(body.tunnelPort).toBe(52078);
    expect(body.lastReadyAt).toBeNull();
    expect(body.rawStderrTail).toBe("Permission denied (publickey).");
  });

  it("caps rawStderrTail at 4KB — never echoes the full buffer (log-bomb protection)", async () => {
    const { id } = seedServer();
    // 20KB of stderr — way above the 4096-byte tail cap. If the route
    // forwards the whole buffer verbatim a log-bomb sshd can OOM the UI.
    const huge = "X".repeat(20_000);
    handleById.set(id, errorHandle(id, 52078, "unknown", huge));

    const res = await app.request(`/meta/remote-servers/${id}/tunnel/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rawStderrTail.length).toBe(4096);
    // The tail is the LAST 4KB, not the first — the most recent bytes
    // are where the interesting diagnostic lives.
    expect(body.rawStderrTail).toBe(huge.slice(huge.length - 4096));
  });

  it("returns 404 when the server id is not in the rc file", async () => {
    const res = await app.request(
      `/meta/remote-servers/does-not-exist/tunnel/status`,
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /meta/remote-servers/:id/tunnel/start
// ---------------------------------------------------------------------------

describe("POST /meta/remote-servers/:id/tunnel/start", () => {
  it("calls manager.start with the persisted server config and returns the ready shape", async () => {
    const { id } = seedServer("prod", "prod.example.com");
    startImpl = async (s) => readyHandle(s.id, 60001);

    const res = await app.request(
      `/meta/remote-servers/${id}/tunnel/start`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "ready",
      errorCode: null,
      tunnelPort: 60001,
      lastReadyAt: 1_700_000_000_000,
      rawStderrTail: "",
    });
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]).toMatchObject({
      id,
      name: "prod",
      ssh: { host: "prod.example.com" },
    });
  });

  it("forwards an error-state handle verbatim when the tunnel fails to open", async () => {
    const { id } = seedServer();
    startImpl = async (s) =>
      errorHandle(s.id, 60002, "connect_refused", "Connection refused");

    const res = await app.request(
      `/meta/remote-servers/${id}/tunnel/start`,
      { method: "POST" },
    );
    // The route forwards whatever the manager returns — the manager
    // never throws for a classified-error handle, so this is a 200 with
    // status='error' in the body. The UI distinguishes the two states.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.errorCode).toBe("connect_refused");
    expect(body.rawStderrTail).toBe("Connection refused");
  });

  it("returns 404 for an unknown server id without calling manager.start", async () => {
    const res = await app.request(
      `/meta/remote-servers/no-such-server/tunnel/start`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(startCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /meta/remote-servers/:id/tunnel/stop
// ---------------------------------------------------------------------------

describe("POST /meta/remote-servers/:id/tunnel/stop", () => {
  it("calls manager.stop(id) and returns {status:'stopped'}", async () => {
    const { id } = seedServer();
    handleById.set(id, readyHandle(id, 52078));

    const res = await app.request(
      `/meta/remote-servers/${id}/tunnel/stop`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "stopped" });
    expect(stopCalls).toEqual([id]);
    // Our stub deletes the handle — verify the post-stop state via status.
    expect(handleById.has(id)).toBe(false);
  });

  it("is idempotent — a second stop call succeeds even when no tunnel is live", async () => {
    const { id } = seedServer();

    const first = await app.request(
      `/meta/remote-servers/${id}/tunnel/stop`,
      { method: "POST" },
    );
    const second = await app.request(
      `/meta/remote-servers/${id}/tunnel/stop`,
      { method: "POST" },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(stopCalls).toEqual([id, id]);
  });

  it("returns 404 for an unknown server id without calling manager.stop", async () => {
    const res = await app.request(
      `/meta/remote-servers/no-such-server/tunnel/stop`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(stopCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /meta/remote-servers/:id/tunnel/restart
// ---------------------------------------------------------------------------

describe("POST /meta/remote-servers/:id/tunnel/restart", () => {
  it("calls manager.restart(id) and returns the ready shape", async () => {
    const { id } = seedServer();
    restartImpl = async (serverId) => readyHandle(serverId, 60003);

    const res = await app.request(
      `/meta/remote-servers/${id}/tunnel/restart`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "ready",
      tunnelPort: 60003,
      lastReadyAt: 1_700_000_000_000,
    });
    expect(restartCalls).toEqual([id]);
  });

  it("returns 404 for an unknown server id without calling manager.restart", async () => {
    const res = await app.request(
      `/meta/remote-servers/unknown/tunnel/restart`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(restartCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Loopback-only gate — the named test from the slice spec
// ---------------------------------------------------------------------------

describe("tunnel_lifecycle_routes_are_loopback_only", () => {
  // When remote access is ON, every tunnel lifecycle route must reject a
  // caller whose socket.remoteAddress is not loopback — even if they hold
  // a valid bearer token. The token grants other endpoints; these four are
  // carved out so off-box clients can never drive the ssh child's life.
  const routes: Array<{ method: "GET" | "POST"; suffix: string }> = [
    { method: "GET", suffix: "status" },
    { method: "POST", suffix: "start" },
    { method: "POST", suffix: "stop" },
    { method: "POST", suffix: "restart" },
  ];

  for (const { method, suffix } of routes) {
    it(`${method} /tunnel/${suffix} returns 403 to a remote caller with a valid bearer token`, async () => {
      // Turn on remote auth so `requireLoopback` is no longer a no-op,
      // and accept the supplied bearer token so the remote-auth layer
      // passes — we want the loopback gate to be the thing that rejects.
      vi.spyOn(config, "hasRemoteAuth").mockReturnValue(true);
      vi.spyOn(config, "findMatchingToken").mockImplementation((provided) =>
        provided === VALID_TOKEN ? { label: "phone" } : null,
      );

      const { id } = seedServer();
      const url = `/meta/remote-servers/${id}/tunnel/${suffix}`;

      const res = await app.request(
        url,
        {
          method,
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
        },
        remoteEnv(),
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toEqual({ error: "endpoint is loopback-only" });

      // And the gate runs BEFORE the manager dependency — a rejected
      // request must not have invoked any lifecycle method.
      expect(startCalls).toEqual([]);
      expect(stopCalls).toEqual([]);
      expect(restartCalls).toEqual([]);
    });

    it(`${method} /tunnel/${suffix} still serves localhost callers when remote auth is on`, async () => {
      vi.spyOn(config, "hasRemoteAuth").mockReturnValue(true);
      vi.spyOn(config, "findMatchingToken").mockReturnValue({ label: "default" });

      const { id } = seedServer();
      const url = `/meta/remote-servers/${id}/tunnel/${suffix}`;

      // Seed a ready handle so every route returns a 200 shape rather
      // than a "manager hasn't been called yet" edge case for /status.
      handleById.set(id, readyHandle(id, 52078));

      const res = await app.request(url, { method }, localhostEnv());
      expect(res.status).toBe(200);
    });
  }
});
