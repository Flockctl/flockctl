/**
 * Branch-coverage top-up for src/routes/meta.ts.
 *
 * Target the branches not hit by meta.test.ts / meta-remote-servers.test.ts
 * / remote-servers-{post,crud}.test.ts / tunnel-lifecycle.test.ts:
 *
 *   - GET /meta/version non-200 registry response branch (!res.ok)
 *   - GET /meta/version non-Error throw (String(e) fallback)
 *   - GET /meta/version when current === "unknown" (updateAvailable stays false)
 *   - GET /meta/version with preferNext=true but no tags.next (fallback chain)
 *   - POST /meta/update error-state branches: stderr trimmed empty →
 *     fallback "exited with code N"; stdout/stderr not strings
 *   - POST /meta/update fire-and-forget catch(err) — execa rejects outright
 *   - POST /meta/update catch with non-Error throw (String(err))
 *   - POST /meta/remote-servers PATCH / POST — "tunnel did not reach ready"
 *     fallback message when rawStderr is null and errorCode is null
 *   - POST / PATCH — "starting" status discriminator → tunnel_open_timeout
 *   - GET /meta — keys listing where isActive explicitly 0 (not nullish)
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
import { aiProviderKeys } from "../../db/schema.js";
import * as pkgVersion from "../../lib/package-version.js";
import {
  resetUpdateState,
  setUpdateState,
} from "../../services/update-state.js";
import { remoteServersPostDeps } from "../../routes/meta.js";
import type { RemoteServerConfig } from "../../config/remote-servers.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));
import { execa } from "execa";
const execaMock = execa as unknown as ReturnType<typeof vi.fn>;

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
  sqlite.exec("DELETE FROM ai_provider_keys;");
});

// ---------------------------------------------------------------------------
// GET /meta/version — extra registry / fallback branches
// ---------------------------------------------------------------------------
describe("GET /meta/version — extra branches", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sets error when the npm registry returns a non-ok response", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("0.0.1");
    vi.spyOn(pkgVersion, "getPackageName").mockReturnValue("flockctl");
    globalThis.fetch = vi.fn(
      async () => new Response("not found", { status: 404 }),
    ) as typeof fetch;

    const res = await app.request("/meta/version");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.latest).toBeNull();
    expect(body.updateAvailable).toBe(false);
    expect(body.error).toMatch(/404/);
  });

  it("converts a non-Error fetch throw via String(e)", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("0.0.1");
    vi.spyOn(pkgVersion, "getPackageName").mockReturnValue("flockctl");
    // Throw a plain string — hits the `String(e)` branch of the ternary.
    globalThis.fetch = vi.fn(async () => {
      throw "registry exploded";
    }) as typeof fetch;

    const res = await app.request("/meta/version");
    const body = await res.json();
    expect(body.error).toBe("registry exploded");
  });

  it("keeps updateAvailable=false when current is the sentinel 'unknown'", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("unknown");
    vi.spyOn(pkgVersion, "getPackageName").mockReturnValue("flockctl");
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ "dist-tags": { latest: "99.0.0" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;
    const res = await app.request("/meta/version");
    const body = await res.json();
    expect(body.current).toBe("unknown");
    // Even though latest is way ahead, the guard `current !== "unknown"`
    // short-circuits and updateAvailable stays false.
    expect(body.updateAvailable).toBe(false);
  });

  it("falls back to tags.latest when current is prerelease but tags.next is missing", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("0.0.1-rc.1");
    vi.spyOn(pkgVersion, "getPackageName").mockReturnValue("flockctl");
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ "dist-tags": { latest: "1.0.0" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;
    const res = await app.request("/meta/version");
    const body = await res.json();
    expect(body.latest).toBe("1.0.0");
  });

  it("returns latest=null when the registry returns an empty dist-tags object", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("0.0.1");
    vi.spyOn(pkgVersion, "getPackageName").mockReturnValue("flockctl");
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;
    const res = await app.request("/meta/version");
    const body = await res.json();
    expect(body.latest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /meta/update — fallback branches in the fire-and-forget IIFE
// ---------------------------------------------------------------------------
describe("POST /meta/update — fire-and-forget error branches", () => {
  const flushMicrotasks = async () => {
    await new Promise((r) => setImmediate(r));
  };

  beforeEach(() => {
    execaMock.mockReset();
    resetUpdateState();
    vi.spyOn(pkgVersion, "getPackageName").mockReturnValue("flockctl");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetUpdateState();
  });

  it("uses 'exited with code N' when failed=true and stderr is blank", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("1.0.0");
    vi.spyOn(pkgVersion, "getInstallInfo").mockReturnValue({
      mode: "global",
      root: "/usr/local/lib",
    });
    execaMock.mockResolvedValue({
      failed: true,
      exitCode: 42,
      stdout: "some stdout",
      stderr: "   \n  ",
    });

    const res = await app.request("/meta/update", { method: "POST" });
    expect(res.status).toBe(202);
    await flushMicrotasks();
    const state = await (await app.request("/meta/update")).json();
    expect(state.status).toBe("error");
    expect(state.error).toBe("npm install exited with code 42");
    expect(state.exitCode).toBe(42);
    // Blank stderr still gets echoed verbatim (the `|| ""` branch stays
    // on the left-hand-side because result.stderr IS a string).
    expect(state.stderr).toBe("   \n  ");
  });

  it("coerces non-string stdout/stderr to empty in the error-state branch", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("1.0.0");
    vi.spyOn(pkgVersion, "getInstallInfo").mockReturnValue({
      mode: "global",
      root: "/usr/local/lib",
    });
    execaMock.mockResolvedValue({
      failed: true,
      exitCode: 7,
      stdout: undefined,
      stderr: Buffer.from("not a string"),
    });

    const res = await app.request("/meta/update", { method: "POST" });
    expect(res.status).toBe(202);
    await flushMicrotasks();
    const state = await (await app.request("/meta/update")).json();
    expect(state.status).toBe("error");
    expect(state.stdout).toBe("");
    expect(state.stderr).toBe("");
  });

  it("coerces non-string stdout/stderr to empty in the success branch", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("1.0.0");
    vi.spyOn(pkgVersion, "getInstallInfo").mockReturnValue({
      mode: "global",
      root: "/usr/local/lib",
    });
    execaMock.mockResolvedValue({
      failed: false,
      exitCode: 0,
      stdout: undefined,
      stderr: 0,
    });

    await app.request("/meta/update", { method: "POST" });
    await flushMicrotasks();
    const state = await (await app.request("/meta/update")).json();
    expect(state.status).toBe("success");
    expect(state.stdout).toBe("");
    expect(state.stderr).toBe("");
  });

  it("sets status='error' when execa rejects outright (catch path)", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("1.0.0");
    vi.spyOn(pkgVersion, "getInstallInfo").mockReturnValue({
      mode: "global",
      root: "/usr/local/lib",
    });
    execaMock.mockRejectedValue(new Error("spawn ENOENT"));

    await app.request("/meta/update", { method: "POST" });
    await flushMicrotasks();
    const state = await (await app.request("/meta/update")).json();
    expect(state.status).toBe("error");
    expect(state.error).toBe("spawn ENOENT");
  });

  it("coerces non-Error throws via String(err) in the catch path", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("1.0.0");
    vi.spyOn(pkgVersion, "getInstallInfo").mockReturnValue({
      mode: "global",
      root: "/usr/local/lib",
    });
    execaMock.mockRejectedValue("exploded mid-install");

    await app.request("/meta/update", { method: "POST" });
    await flushMicrotasks();
    const state = await (await app.request("/meta/update")).json();
    expect(state.status).toBe("error");
    expect(state.error).toBe("exploded mid-install");
  });

  it("local install without an install.root is invoked from cwd=undefined", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("1.0.0");
    // mode=local but root not set — hits the spread-branch where
    // (install.mode==='local' && install.root) is falsy.
    vi.spyOn(pkgVersion, "getInstallInfo").mockReturnValue({
      mode: "local",
    } as any);
    execaMock.mockResolvedValue({
      failed: false,
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    await app.request("/meta/update", { method: "POST" });
    // No `cwd` override — just the default execa options.
    const call = execaMock.mock.calls[0];
    expect(call?.[2] ?? {}).not.toHaveProperty("cwd");
  });
});

// ---------------------------------------------------------------------------
// GET /meta — keys with explicit isActive=0 value
// ---------------------------------------------------------------------------
describe("GET /meta — keys branches", () => {
  it("reports isActive=false when the column is 0 (not null)", async () => {
    db.insert(aiProviderKeys)
      .values({
        provider: "anthropic",
        providerType: "api_key",
        label: "disabled-key",
        priority: 0,
        isActive: false,
      } as any)
      .run();
    const res = await app.request("/meta");
    const body = await res.json();
    expect(body.keys[0].name).toBe("disabled-key");
    expect(body.keys[0].isActive).toBe(false);
  });

  it("PATCH /meta/defaults clears defaultKeyId when set to null", async () => {
    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultKeyId: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keyId).toBeNull();
  });

  it("falls back to isActive=true when the column is NULL", async () => {
    // Drizzle normally forbids nulling a column with a default, but we can
    // drop the value directly via the underlying sqlite connection.
    sqlite
      .prepare(
        "INSERT INTO ai_provider_keys (provider, provider_type, label, is_active) VALUES (?, ?, ?, NULL)",
      )
      .run("anthropic", "api_key", "null-flag");
    const res = await app.request("/meta");
    const body = await res.json();
    const entry = body.keys.find((k: any) => k.name === "null-flag");
    expect(entry).toBeDefined();
    expect(entry.isActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST / PATCH /meta/remote-servers — fallback message + "starting" status
// ---------------------------------------------------------------------------
describe("POST /meta/remote-servers — tunnel-not-ready fallback branches", () => {
  const origDeps = { ...remoteServersPostDeps };
  const rcStore = new Map<string, RemoteServerConfig>();

  beforeEach(() => {
    rcStore.clear();
    remoteServersPostDeps.saveServer = (input) => {
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
    remoteServersPostDeps.deleteServer = (id) => rcStore.delete(id);
    remoteServersPostDeps.listServers = () =>
      [...rcStore.values()] as RemoteServerConfig[];
    remoteServersPostDeps.hostname = () => "branches-host";
    remoteServersPostDeps.sshExec = async () => ({
      stdout: "A".repeat(43),
      stderr: "",
      exitCode: 0,
    });
  });

  afterEach(() => {
    Object.assign(remoteServersPostDeps, origDeps);
    rcStore.clear();
  });

  it("falls back to 'tunnel did not reach ready (status=X)' message when rawStderr is null", async () => {
    remoteServersPostDeps.manager = {
      async start(s) {
        return {
          serverId: s.id,
          localPort: 52099,
          status: "error",
          errorCode: "auth_failed",
          // rawStderr intentionally undefined → hits the `??` fallback.
        };
      },
    };
    const res = await app.request("/meta/remote-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", ssh: { host: "h" } }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.errorCode).toBe("auth_failed");
    expect(body.error).toBe("tunnel did not reach 'ready' (status=error)");
  });

  it("maps status='starting' to tunnel_open_timeout via isTimeout discriminator", async () => {
    remoteServersPostDeps.manager = {
      async start(s) {
        return {
          serverId: s.id,
          localPort: 52099,
          status: "starting" as const,
        };
      },
    };
    const res = await app.request("/meta/remote-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", ssh: { host: "h" } }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.errorCode).toBe("tunnel_open_timeout");
  });

  it("falls back to 'unknown' errorCode when non-timeout handle has no errorCode", async () => {
    remoteServersPostDeps.manager = {
      async start(s) {
        return {
          serverId: s.id,
          localPort: 52099,
          status: "error" as const,
          rawStderr: "something blew up",
        };
      },
    };
    const res = await app.request("/meta/remote-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", ssh: { host: "h" } }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.errorCode).toBe("unknown");
    expect(body.error).toBe("something blew up");
  });

  it("coerces a non-Error saveServer throw via String(err)", async () => {
    remoteServersPostDeps.saveServer = () => {
      // Throwing a plain string exercises the `String(err)` branch.
      throw "disk-full string throw";
    };
    remoteServersPostDeps.manager = {
      async start() {
        throw new Error("manager.start must not run");
      },
    };
    const res = await app.request("/meta/remote-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", ssh: { host: "h" } }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.errorCode).toBe("persistence_failed");
    expect(body.error).toContain("disk-full string throw");
  });

  it("coerces a non-Error manager.start throw via String(err)", async () => {
    remoteServersPostDeps.manager = {
      async start() {
        throw "start exploded as a plain string";
      },
    };
    const res = await app.request("/meta/remote-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", ssh: { host: "h" } }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.errorCode).toBe("tunnel_open_timeout");
    expect(body.error).toContain("start exploded as a plain string");
    // Rollback ran.
    expect(rcStore.size).toBe(0);
  });
});

describe("PATCH /meta/remote-servers — tunnel-not-ready fallback branches", () => {
  const origDeps = { ...remoteServersPostDeps };
  const rcStore = new Map<string, RemoteServerConfig>();

  beforeEach(() => {
    rcStore.clear();
    remoteServersPostDeps.saveServer = (input) => {
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
    remoteServersPostDeps.deleteServer = (id) => rcStore.delete(id);
    remoteServersPostDeps.listServers = () =>
      [...rcStore.values()] as RemoteServerConfig[];
    remoteServersPostDeps.updateServer = ((id: string, update: Partial<RemoteServerConfig> & { ssh?: Partial<RemoteServerConfig["ssh"]> }) => {
      const existing = rcStore.get(id);
      if (!existing) return null;
      const merged: RemoteServerConfig = {
        ...existing,
        ...(update.name ? { name: update.name } : {}),
        ssh: { ...existing.ssh, ...(update.ssh ?? {}) },
      };
      rcStore.set(id, merged);
      return merged;
    }) as any;
  });

  afterEach(() => {
    Object.assign(remoteServersPostDeps, origDeps);
    rcStore.clear();
  });

  function seed(server: Partial<RemoteServerConfig> & { id: string; name: string; ssh: any }) {
    const entry: RemoteServerConfig = {
      id: server.id,
      name: server.name,
      ssh: { ...server.ssh },
      token: "t",
      tokenLabel: "lbl",
    };
    rcStore.set(server.id, entry);
  }

  it("maps status='starting' on PATCH-ssh change to tunnel_open_timeout", async () => {
    seed({ id: "patch1", name: "x", ssh: { host: "old.host" } });
    remoteServersPostDeps.manager = {
      async start(s) {
        return {
          serverId: s.id,
          localPort: 52100,
          status: "starting" as const,
        };
      },
      async stop() {},
      getByServerId: () => null,
    };
    const res = await app.request("/meta/remote-servers/patch1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssh: { host: "new.host" } }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.errorCode).toBe("tunnel_open_timeout");
  });

  it("PATCH falls back to 'unknown' errorCode when non-timeout handle has no errorCode", async () => {
    seed({ id: "patch2", name: "x", ssh: { host: "old.host" } });
    remoteServersPostDeps.manager = {
      async start(s) {
        return {
          serverId: s.id,
          localPort: 52100,
          status: "error" as const,
          rawStderr: "generic fail",
        };
      },
      async stop() {},
      getByServerId: () => null,
    };
    const res = await app.request("/meta/remote-servers/patch2", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssh: { host: "new.host" } }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.errorCode).toBe("unknown");
    expect(body.error).toBe("generic fail");
  });

  it("PATCH falls back to 'tunnel did not reach ready' message when rawStderr is null", async () => {
    seed({ id: "patch3", name: "x", ssh: { host: "old.host" } });
    remoteServersPostDeps.manager = {
      async start(s) {
        return {
          serverId: s.id,
          localPort: 52100,
          status: "error",
          errorCode: "auth_failed",
          // rawStderr left unset
        };
      },
      async stop() {},
      getByServerId: () => null,
    };
    const res = await app.request("/meta/remote-servers/patch3", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssh: { host: "new.host" } }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.errorCode).toBe("auth_failed");
    expect(body.error).toBe("tunnel did not reach 'ready' (status=error)");
  });

  it("PATCH swallows a non-Error stop throw via String(err)", async () => {
    seed({ id: "patchStopStr", name: "x", ssh: { host: "old.host" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    remoteServersPostDeps.manager = {
      async stop() {
        throw "stop exploded as a plain string";
      },
      async start(s) {
        return {
          serverId: s.id,
          localPort: 52100,
          status: "ready",
          readyAt: Date.now(),
        };
      },
      getByServerId: () => null,
    };
    const res = await app.request("/meta/remote-servers/patchStopStr", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssh: { host: "new.host" } }),
    });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    expect((warn.mock.calls[0][0] as string)).toContain(
      "stop exploded as a plain string",
    );
    warn.mockRestore();
  });

  it("PATCH coerces non-Error manager.start throw via String(err)", async () => {
    seed({ id: "patchStartStr", name: "x", ssh: { host: "old.host" } });
    remoteServersPostDeps.manager = {
      async stop() {},
      async start() {
        throw "start exploded as a plain string";
      },
      getByServerId: () => null,
    };
    const res = await app.request("/meta/remote-servers/patchStartStr", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssh: { host: "new.host" } }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.errorCode).toBe("tunnel_open_timeout");
    expect(body.error).toContain("start exploded as a plain string");
  });

  it("DELETE swallows a non-Error stop throw via String(err)", async () => {
    seed({ id: "delStopStr", name: "x", ssh: { host: "h" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    remoteServersPostDeps.manager = {
      async stop() {
        throw "delete stop exploded as a plain string";
      },
      async start() {
        throw new Error("start must not run");
      },
      getByServerId: () => null,
    } as any;
    const res = await app.request("/meta/remote-servers/delStopStr", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalled();
    expect((warn.mock.calls[0][0] as string)).toContain(
      "delete stop exploded as a plain string",
    );
    warn.mockRestore();
    expect(rcStore.has("delStopStr")).toBe(false);
  });

  it("PATCH with no ssh change AND no name change falls through to no-op 200 with current handle", async () => {
    seed({ id: "patch4", name: "same", ssh: { host: "h" } });
    remoteServersPostDeps.manager = {
      async start() {
        throw new Error("start must not be called");
      },
      async stop() {
        throw new Error("stop must not be called");
      },
      getByServerId: () => ({
        serverId: "patch4",
        localPort: 52178,
        status: "ready",
        readyAt: Date.now(),
      }),
    } as any;
    const res = await app.request("/meta/remote-servers/patch4", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "same", ssh: { host: "h" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tunnelStatus).toBe("ready");
    expect(body.tunnelPort).toBe(52178);
  });

  it("PATCH returns 404 when updateServer returns null (race between lookup and update)", async () => {
    seed({ id: "race1", name: "race", ssh: { host: "h" } });
    remoteServersPostDeps.updateServer = (() => null) as any;
    remoteServersPostDeps.manager = {
      async start() {
        throw new Error("start must not run");
      },
      async stop() {},
      getByServerId: () => null,
    } as any;
    const res = await app.request("/meta/remote-servers/race1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssh: { host: "new.host" } }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH no-op falls back to `current` when the rc entry vanishes between reads", async () => {
    seed({ id: "patch5", name: "race", ssh: { host: "h" } });
    // Replace listServers so the first call sees the entry and the
    // second (post-PATCH) returns an empty array — the `?? current`
    // fallback is what the handler uses to build the response.
    let callCount = 0;
    remoteServersPostDeps.listServers = (() => {
      callCount++;
      if (callCount === 1) return [...rcStore.values()];
      return [];
    }) as any;
    remoteServersPostDeps.manager = {
      async start() {
        throw new Error("unused");
      },
      async stop() {
        throw new Error("unused");
      },
      getByServerId: () => null,
    } as any;

    const res = await app.request("/meta/remote-servers/patch5", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // Name matches current → no ssh change, no name change → no-op
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Body reflects `current` (the first listServers snapshot) since the
    // second call returned empty.
    expect(body.id).toBe("patch5");
    expect(body.name).toBe("race");
  });
});

// ---------------------------------------------------------------------------
// GET /meta — ready=true branch (covers model fan-out loop at L997-1001)
// ---------------------------------------------------------------------------
describe("GET /meta — agent readiness branches", () => {
  it("enumerates provider.listModels when provider is ready", async () => {
    const { registerAgent, unregisterAgent } = await import(
      "../../services/agents/registry.js"
    );
    const fakeId = "fake-ready-agent-branch";
    registerAgent(
      {
        id: fakeId,
        displayName: "Fake Ready",
        listModels: () => [
          { id: "m1", name: "Model 1" },
          { id: "m2", name: "Model 2" },
        ],
        checkReadiness: () => ({
          installed: true,
          authenticated: true,
          ready: true,
        }),
        chat: async () => ({ text: "" }),
        streamChat: async function* () {},
        estimateCost: () => null,
      } as any,
      { asDefault: false },
    );

    try {
      const res = await app.request("/meta");
      expect(res.status).toBe(200);
      const body = await res.json();
      const entry = body.agents.find((a: any) => a.id === fakeId);
      expect(entry?.available).toBe(true);
      const modelIds = body.models.map((m: any) => m.id);
      expect(modelIds).toContain("m1");
      expect(modelIds).toContain("m2");
    } finally {
      unregisterAgent(fakeId);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /meta/remote-servers/:id/proxy-token — success branch (server.token)
// ---------------------------------------------------------------------------
describe("POST /meta/remote-servers/:id/proxy-token — token resolution", () => {
  afterEach(() => {
    // Restore whatever getRemoteServers returns in isolation.
    vi.restoreAllMocks();
  });

  it("returns the server token when one is stored", async () => {
    const cfgMod = await import("../../config/remote-servers.js");
    const srv: RemoteServerConfig = {
      id: "tok-yes",
      name: "Tok Yes",
      host: "h",
      user: "u",
      sshPort: 22,
      remotePort: 52077,
      token: "secret-token",
      sshKeyPath: undefined,
    } as any;
    vi.spyOn(cfgMod, "getRemoteServers").mockReturnValue([srv]);
    const res = await app.request("/meta/remote-servers/tok-yes/proxy-token", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe("secret-token");
  });

  it("returns null when the stored server has no token", async () => {
    const cfgMod = await import("../../config/remote-servers.js");
    const srv: RemoteServerConfig = {
      id: "tok-no",
      name: "Tok No",
      host: "h",
      user: "u",
      sshPort: 22,
      remotePort: 52077,
      token: undefined,
      sshKeyPath: undefined,
    } as any;
    vi.spyOn(cfgMod, "getRemoteServers").mockReturnValue([srv]);
    const res = await app.request("/meta/remote-servers/tok-no/proxy-token", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeNull();
  });
});
