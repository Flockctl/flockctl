/**
 * GET / PATCH / DELETE /meta/remote-servers — slice-03 CRUD behaviour.
 *
 * The POST pipeline (create → bootstrap → saveRc → start) lives in its
 * own file (remote-servers-post.test.ts); this file covers the remaining
 * three verbs:
 *
 *   • GET list       — enrichment with live tunnel state, no token leak
 *   • GET /:id       — 404 on unknown, enriched shape on hit
 *   • PATCH /:id     — validation, 404, name-only short-circuit, ssh
 *                      change → stop → updateRc → start → ready, error
 *                      mapping mirrors POST
 *   • DELETE /:id    — 404 on unknown, stop-before-remove ordering,
 *                      best-effort semantics when stop throws
 *
 * The rc is backed by an in-memory Map stubbed at the dep boundary — the
 * same pattern used by remote-servers-post.test.ts. Real persistence is
 * covered by config/*.test.ts.
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
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { remoteServersPostDeps } from "../../routes/meta.js";
import type { RemoteServerConfig } from "../../config/remote-servers.js";
import type { SshTunnelHandle } from "../../services/ssh-tunnels/types.js";

const rcStore = new Map<string, RemoteServerConfig>();
const origDeps = { ...remoteServersPostDeps };
let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => {
  sqlite.close();
});

beforeEach(() => {
  rcStore.clear();

  remoteServersPostDeps.listServers = () =>
    [...rcStore.values()].map((s) => ({ ...s, ssh: { ...s.ssh } }));

  remoteServersPostDeps.saveServer = (input) => {
    if (rcStore.has(input.id)) {
      throw new Error(`duplicate id ${input.id}`);
    }
    const stored: RemoteServerConfig = {
      id: input.id,
      name: input.name,
      ssh: { ...input.ssh },
      token: input.token,
      tokenLabel: input.tokenLabel,
    };
    rcStore.set(input.id, stored);
    return stored;
  };

  remoteServersPostDeps.updateServer = (id, input) => {
    const cur = rcStore.get(id);
    if (!cur) return null;
    const next: RemoteServerConfig = {
      id: cur.id,
      name: input.name !== undefined ? input.name : cur.name,
      ssh:
        input.ssh !== undefined ? { ...cur.ssh, ...input.ssh } : { ...cur.ssh },
      token: cur.token,
      tokenLabel: cur.tokenLabel,
    };
    rcStore.set(id, next);
    return next;
  };

  remoteServersPostDeps.deleteServer = (id) => rcStore.delete(id);

  // Default manager: start should never be called unless the test opts in.
  // stop is a no-op; getByServerId returns null until a test installs a
  // handle.
  remoteServersPostDeps.manager = {
    async start() {
      throw new Error("unexpected manager.start in CRUD test — override it");
    },
    async stop() {
      /* no-op */
    },
    getByServerId: () => null,
  };
});

afterEach(() => {
  Object.assign(remoteServersPostDeps, origDeps);
  delete remoteServersPostDeps.afterSaveBeforeStart;
  rcStore.clear();
});

function seed(server: RemoteServerConfig) {
  rcStore.set(server.id, { ...server, ssh: { ...server.ssh } });
}

function get(path: string) {
  return app.request(path);
}

function patchJson(id: string, body: unknown) {
  return app.request(`/meta/remote-servers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function del(id: string) {
  return app.request(`/meta/remote-servers/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// GET /meta/remote-servers — list with live tunnel state
// ---------------------------------------------------------------------------
describe("GET /meta/remote-servers — list", () => {
  it("returns an empty array when no servers are configured", async () => {
    const res = await get("/meta/remote-servers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns the enriched shape with live tunnel state", async () => {
    seed({
      id: "s1",
      name: "Home",
      ssh: { host: "home.example", user: "alice", port: 22 },
      token: "tok",
      tokenLabel: "label",
    });
    seed({
      id: "s2",
      name: "Prod",
      ssh: { host: "prod.example" },
      token: "tok2",
      tokenLabel: "label2",
    });

    remoteServersPostDeps.manager.getByServerId = (id) => {
      if (id === "s1") {
        return {
          serverId: "s1",
          localPort: 52500,
          status: "ready",
          readyAt: Date.now(),
        } satisfies SshTunnelHandle;
      }
      if (id === "s2") {
        return {
          serverId: "s2",
          localPort: 52501,
          status: "error",
          errorCode: "auth_failed",
          rawStderr: "Permission denied (publickey).",
        } satisfies SshTunnelHandle;
      }
      return null;
    };

    const res = await get("/meta/remote-servers");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      {
        id: "s1",
        name: "Home",
        ssh: { host: "home.example", user: "alice", port: 22 },
        tunnelStatus: "ready",
        tunnelPort: 52500,
        tunnelLastError: null,
        errorCode: null,
      },
      {
        id: "s2",
        name: "Prod",
        ssh: { host: "prod.example" },
        tunnelStatus: "error",
        tunnelPort: 52501,
        tunnelLastError: "Permission denied (publickey).",
        errorCode: "auth_failed",
      },
    ]);
  });

  it("reports tunnelStatus='stopped' and null port/error when no handle exists", async () => {
    seed({ id: "s1", name: "Cold", ssh: { host: "cold.example" } });
    // getByServerId already returns null from the default stub.
    const res = await get("/meta/remote-servers");
    const body = await res.json();
    expect(body).toEqual([
      {
        id: "s1",
        name: "Cold",
        ssh: { host: "cold.example" },
        tunnelStatus: "stopped",
        tunnelPort: null,
        tunnelLastError: null,
        errorCode: null,
      },
    ]);
  });

  it("never leaks the token or tokenLabel in the list response", async () => {
    seed({
      id: "s1",
      name: "Home",
      ssh: { host: "home.example" },
      token: "SECRET-TOKEN-XYZ",
      tokenLabel: "flockctl-local-mybox",
    });
    const res = await get("/meta/remote-servers");
    const text = await res.text();
    expect(text).not.toContain("SECRET-TOKEN-XYZ");
    expect(text).not.toContain("tokenLabel");
    expect(text).not.toContain("flockctl-local-mybox");
  });
});

// ---------------------------------------------------------------------------
// GET /meta/remote-servers/:id — single-server fetch
// ---------------------------------------------------------------------------
describe("GET /meta/remote-servers/:id", () => {
  it("returns 404 when the id is unknown", async () => {
    const res = await get("/meta/remote-servers/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns the enriched shape when the server exists", async () => {
    seed({ id: "s1", name: "Home", ssh: { host: "home.example" } });
    remoteServersPostDeps.manager.getByServerId = (id) =>
      id === "s1"
        ? ({
            serverId: "s1",
            localPort: 52500,
            status: "ready",
            readyAt: Date.now(),
          } satisfies SshTunnelHandle)
        : null;

    const res = await get("/meta/remote-servers/s1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "s1",
      name: "Home",
      ssh: { host: "home.example" },
      tunnelStatus: "ready",
      tunnelPort: 52500,
      tunnelLastError: null,
      errorCode: null,
    });
  });

  it("never includes the token in the single-server response", async () => {
    seed({
      id: "s1",
      name: "Home",
      ssh: { host: "home.example" },
      token: "SECRET-ABC",
      tokenLabel: "some-label",
    });
    const res = await get("/meta/remote-servers/s1");
    const text = await res.text();
    expect(text).not.toContain("SECRET-ABC");
    expect(text).not.toContain("tokenLabel");
  });
});

// ---------------------------------------------------------------------------
// PATCH /meta/remote-servers/:id — validation, name-only, ssh changes
// ---------------------------------------------------------------------------
describe("PATCH /meta/remote-servers/:id — validation + 404", () => {
  it("returns 404 when the id is unknown", async () => {
    const res = await patchJson("nope", { name: "Renamed" });
    expect(res.status).toBe(404);
  });

  it("returns 400 invalid_ssh_config for a malformed ssh update", async () => {
    seed({ id: "s1", name: "Home", ssh: { host: "home.example" } });
    const res = await patchJson("s1", { ssh: { port: 70000 } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe("invalid_ssh_config");
  });

  it("returns 400 legacy_transport_rejected for a top-level `token` key", async () => {
    seed({ id: "s1", name: "Home", ssh: { host: "home.example" } });
    const res = await patchJson("s1", { token: "abc" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe("legacy_transport_rejected");
  });
});

describe("PATCH /meta/remote-servers/:id — name-only change", () => {
  it("name_only_change_calls_saveRc_without_manager_interaction", async () => {
    seed({ id: "s1", name: "Old", ssh: { host: "h" } });
    const stopSpy = vi.fn(async () => {});
    const startSpy = vi.fn(async () => {
      throw new Error("start must not be called for a name-only PATCH");
    });
    remoteServersPostDeps.manager = {
      start: startSpy,
      stop: stopSpy,
      getByServerId: () => ({
        serverId: "s1",
        localPort: 52500,
        status: "ready",
      }),
    };

    const res = await patchJson("s1", { name: "New" });
    expect(res.status).toBe(200);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(rcStore.get("s1")?.name).toBe("New");

    // Response reflects the existing tunnel state (ready) so the UI keeps
    // the green indicator without a reload.
    const body = await res.json();
    expect(body).toMatchObject({
      id: "s1",
      name: "New",
      ssh: { host: "h" },
      tunnelStatus: "ready",
      tunnelPort: 52500,
    });
  });

  it("treats an empty-body PATCH as a no-op and does not touch the manager", async () => {
    seed({ id: "s1", name: "Same", ssh: { host: "h" } });
    const startSpy = vi.fn();
    const stopSpy = vi.fn();
    remoteServersPostDeps.manager = {
      start: startSpy,
      stop: stopSpy,
      getByServerId: () => null,
    };
    const res = await patchJson("s1", {});
    expect(res.status).toBe(200);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(rcStore.get("s1")?.name).toBe("Same");
  });

  it("does NOT restart the tunnel when ssh fields are present but unchanged", async () => {
    seed({ id: "s1", name: "Old", ssh: { host: "h", port: 22 } });
    const startSpy = vi.fn();
    const stopSpy = vi.fn();
    remoteServersPostDeps.manager = {
      start: startSpy,
      stop: stopSpy,
      getByServerId: () => null,
    };
    const res = await patchJson("s1", {
      name: "Renamed",
      ssh: { host: "h", port: 22 },
    });
    expect(res.status).toBe(200);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(rcStore.get("s1")?.name).toBe("Renamed");
  });
});

describe("PATCH /meta/remote-servers/:id — ssh change", () => {
  it("ssh_change_stops_tunnel_then_updates_rc_then_starts_new_tunnel", async () => {
    seed({ id: "s1", name: "Host", ssh: { host: "old.host" } });

    const events: string[] = [];
    const stopSpy = vi.fn(async () => {
      // rc must still reflect the OLD ssh at stop() time (update happens
      // after stop per the slice contract).
      events.push(`stop:${rcStore.get("s1")?.ssh.host}`);
    });
    const startSpy = vi.fn(async (server) => {
      // By the time start() sees the config, the rc must already reflect
      // the NEW ssh values.
      events.push(`start:${server.ssh.host}`);
      expect(rcStore.get("s1")?.ssh.host).toBe("new.host");
      return {
        serverId: server.id,
        localPort: 52100,
        status: "ready",
        readyAt: Date.now(),
      } satisfies SshTunnelHandle;
    });

    remoteServersPostDeps.manager = {
      start: startSpy,
      stop: stopSpy,
      getByServerId: () => null,
    };

    const res = await patchJson("s1", { ssh: { host: "new.host" } });
    expect(res.status).toBe(200);
    expect(events).toEqual(["stop:old.host", "start:new.host"]);
    expect(rcStore.get("s1")?.ssh.host).toBe("new.host");

    const body = await res.json();
    expect(body).toMatchObject({
      id: "s1",
      ssh: { host: "new.host" },
      tunnelStatus: "ready",
      tunnelPort: 52100,
    });
  });

  it("detects ssh change when only ssh.port differs", async () => {
    seed({ id: "s1", name: "Host", ssh: { host: "h", port: 22 } });
    const startSpy = vi.fn(async (server) => ({
      serverId: server.id,
      localPort: 52100,
      status: "ready",
      readyAt: Date.now(),
    } satisfies SshTunnelHandle));
    const stopSpy = vi.fn(async () => {});
    remoteServersPostDeps.manager = {
      start: startSpy,
      stop: stopSpy,
      getByServerId: () => null,
    };

    const res = await patchJson("s1", { ssh: { port: 2222 } });
    expect(res.status).toBe(200);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(rcStore.get("s1")?.ssh.port).toBe(2222);
  });

  it("maps a classified tunnel error to 502 with the same errorCode as POST", async () => {
    seed({ id: "s1", name: "Host", ssh: { host: "old.host" } });
    remoteServersPostDeps.manager = {
      async start(server) {
        return {
          serverId: server.id,
          localPort: 52100,
          status: "error",
          errorCode: "auth_failed",
          rawStderr: "Permission denied (publickey).",
        } satisfies SshTunnelHandle;
      },
      async stop() {},
      getByServerId: () => null,
    };

    const res = await patchJson("s1", { ssh: { host: "new.host" } });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.errorCode).toBe("auth_failed");
    // rc reflects the attempted new config, not the old one — the user
    // has to Reconnect explicitly once they fix the underlying problem.
    expect(rcStore.get("s1")?.ssh.host).toBe("new.host");
  });

  it("maps a probe timeout to 502 tunnel_open_timeout", async () => {
    seed({ id: "s1", name: "Host", ssh: { host: "old.host" } });
    remoteServersPostDeps.manager = {
      async start(server) {
        return {
          serverId: server.id,
          localPort: 52100,
          status: "error",
          errorCode: "unknown",
          rawStderr: "ready-gate timeout",
        } satisfies SshTunnelHandle;
      },
      async stop() {},
      getByServerId: () => null,
    };
    const res = await patchJson("s1", { ssh: { host: "new.host" } });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.errorCode).toBe("tunnel_open_timeout");
  });

  it("maps a synchronous manager.start throw to 502 tunnel_open_timeout", async () => {
    seed({ id: "s1", name: "Host", ssh: { host: "old.host" } });
    remoteServersPostDeps.manager = {
      async start() {
        throw new RangeError("port alloc failed");
      },
      async stop() {},
      getByServerId: () => null,
    };
    const res = await patchJson("s1", { ssh: { host: "new.host" } });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.errorCode).toBe("tunnel_open_timeout");
  });

  it("swallows a stop() failure and continues with the update (best-effort)", async () => {
    seed({ id: "s1", name: "Host", ssh: { host: "old.host" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    remoteServersPostDeps.manager = {
      async stop() {
        throw new Error("child signal failed");
      },
      async start(server) {
        return {
          serverId: server.id,
          localPort: 52100,
          status: "ready",
          readyAt: Date.now(),
        } satisfies SshTunnelHandle;
      },
      getByServerId: () => null,
    };

    const res = await patchJson("s1", { ssh: { host: "new.host" } });
    expect(res.status).toBe(200);
    expect(rcStore.get("s1")?.ssh.host).toBe("new.host");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// DELETE /meta/remote-servers/:id — stop → remove, best-effort semantics
// ---------------------------------------------------------------------------
describe("DELETE /meta/remote-servers/:id", () => {
  it("returns 404 when the id is unknown", async () => {
    const res = await del("nope");
    expect(res.status).toBe(404);
  });

  it("delete_handler_stops_tunnel_before_removing_rc", async () => {
    seed({ id: "s1", name: "Home", ssh: { host: "h" } });
    const events: string[] = [];

    const stopSpy = vi.fn(async () => {
      // Key assertion: stop is invoked while the rc entry is still present.
      expect(rcStore.has("s1")).toBe(true);
      events.push("stop");
    });
    remoteServersPostDeps.manager = {
      async start() {
        throw new Error("start must not be called from DELETE");
      },
      stop: stopSpy,
      getByServerId: () => null,
    };

    // Wrap deleteServer to capture ordering.
    const origDelete = remoteServersPostDeps.deleteServer;
    remoteServersPostDeps.deleteServer = (id) => {
      events.push("delete");
      return origDelete(id);
    };

    const res = await del("s1");
    expect(res.status).toBe(204);
    expect(events).toEqual(["stop", "delete"]);
    expect(rcStore.has("s1")).toBe(false);
  });

  it("awaits manager.stop before calling deleteServer (not fire-and-forget)", async () => {
    seed({ id: "s1", name: "Home", ssh: { host: "h" } });
    let stopResolved = false;
    let deletedBeforeStopResolved = false;

    remoteServersPostDeps.manager = {
      async start() {
        throw new Error("unused");
      },
      async stop() {
        // Yield twice so the handler has to actually await us. If it
        // didn't, deleteServer would run before `stopResolved` flips.
        await Promise.resolve();
        await Promise.resolve();
        stopResolved = true;
      },
      getByServerId: () => null,
    };
    const origDelete = remoteServersPostDeps.deleteServer;
    remoteServersPostDeps.deleteServer = (id) => {
      if (!stopResolved) deletedBeforeStopResolved = true;
      return origDelete(id);
    };

    const res = await del("s1");
    expect(res.status).toBe(204);
    expect(deletedBeforeStopResolved).toBe(false);
  });

  it("still removes the rc entry and returns 204 when stop throws (best-effort)", async () => {
    seed({ id: "s1", name: "Home", ssh: { host: "h" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    remoteServersPostDeps.manager = {
      async start() {
        throw new Error("unused");
      },
      async stop() {
        throw new Error("ssh child unreachable");
      },
      getByServerId: () => null,
    };

    const res = await del("s1");
    expect(res.status).toBe(204);
    expect(rcStore.has("s1")).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
