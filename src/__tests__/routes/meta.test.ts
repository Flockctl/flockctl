import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { aiProviderKeys } from "../../db/schema.js";
import Database from "better-sqlite3";
import * as config from "../../config/index.js";
import * as pkgVersion from "../../lib/package-version.js";
import { resetUpdateState, setUpdateState } from "../../services/update-state.js";

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

describe("/meta/defaults", () => {
  let stored: { defaultModel?: string | null; defaultKeyId?: number | null };

  beforeEach(() => {
    stored = {};
    vi.spyOn(config, "getDefaultModel").mockImplementation(
      () => (stored.defaultModel as string | undefined) ?? "claude-sonnet-4-6",
    );
    vi.spyOn(config, "getDefaultKeyId").mockImplementation(
      () => (typeof stored.defaultKeyId === "number" ? stored.defaultKeyId : null),
    );
    vi.spyOn(config, "setGlobalDefaults").mockImplementation((input) => {
      if (input.defaultModel !== undefined) {
        if (input.defaultModel === null || input.defaultModel === "") {
          delete stored.defaultModel;
        } else {
          stored.defaultModel = input.defaultModel;
        }
      }
      if (input.defaultKeyId !== undefined) {
        if (input.defaultKeyId === null) {
          delete stored.defaultKeyId;
        } else {
          stored.defaultKeyId = input.defaultKeyId;
        }
      }
    });
  });

  it("GET /meta exposes keyId in defaults block", async () => {
    const res = await app.request("/meta");
    const body = await res.json();
    expect(body.defaults.keyId).toBeNull();
  });

  it("PATCH updates defaultModel", async () => {
    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: "claude-opus-4-7" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe("claude-opus-4-7");
    expect(stored.defaultModel).toBe("claude-opus-4-7");
  });

  it("PATCH clears defaultModel when set to null", async () => {
    stored.defaultModel = "claude-opus-4-7";
    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: null }),
    });
    expect(res.status).toBe(200);
    expect(stored.defaultModel).toBeUndefined();
  });

  it("PATCH validates defaultKeyId exists", async () => {
    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultKeyId: 999 }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH accepts existing keyId", async () => {
    const inserted = db.insert(aiProviderKeys).values({
      provider: "anthropic", providerType: "api_key", label: "default-key", priority: 0,
    } as any).returning().get()!;

    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultKeyId: inserted.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keyId).toBe(inserted.id);
    expect(stored.defaultKeyId).toBe(inserted.id);
  });

  it("PATCH rejects non-integer defaultKeyId", async () => {
    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultKeyId: "abc" }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects empty body", async () => {
    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects malformed JSON", async () => {
    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{ broken",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /meta", () => {
  it("returns agents array with claude-code entry", async () => {
    const res = await app.request("/meta");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.agents)).toBe(true);
    const claude = body.agents.find((a: any) => a.id === "claude-code");
    expect(claude).toBeDefined();
    expect(claude.name).toBe("Claude Code");
    expect(typeof claude.available).toBe("boolean");
  });

  it("returns defaults with model, planningModel, agent", async () => {
    const res = await app.request("/meta");
    const body = await res.json();
    expect(body.defaults).toBeDefined();
    expect(typeof body.defaults.model).toBe("string");
    expect(typeof body.defaults.planningModel).toBe("string");
    expect(typeof body.defaults.agent).toBe("string");
  });

  it("returns keys array from DB, sorted by priority desc", async () => {
    db.insert(aiProviderKeys).values([
      { provider: "anthropic", providerType: "api_key", label: "A", priority: 1 },
      { provider: "openai", providerType: "api_key", label: "B", priority: 5 },
    ] as any).run();

    const res = await app.request("/meta");
    const body = await res.json();
    expect(body.keys).toHaveLength(2);
    // High priority first
    expect(body.keys[0].name).toBe("B");
    expect(body.keys[1].name).toBe("A");
  });

  it("falls back to 'Key #<id>' label when label empty", async () => {
    const inserted = db.insert(aiProviderKeys).values({
      provider: "anthropic", providerType: "api_key", label: null, priority: 0,
    } as any).returning().get()!;

    const res = await app.request("/meta");
    const body = await res.json();
    expect(body.keys[0].name).toBe(`Key #${inserted.id}`);
    expect(body.keys[0].isActive).toBe(true);
  });

  it("returns models array (may be empty if claude-code unavailable)", async () => {
    const res = await app.request("/meta");
    const body = await res.json();
    expect(Array.isArray(body.models)).toBe(true);
    // If models present, validate shape. Accept any registered agent —
    // multi-agent support means models can belong to claude-code or copilot.
    for (const m of body.models) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.name).toBe("string");
      expect(["claude-code", "copilot"]).toContain(m.agent);
    }
  });
});

// NOTE: the /meta/remote-servers describe block lived here but was
// removed when slices 01+03 migrated the endpoint from the legacy
// `{name, url, token}` shape to SSH-only `{name, ssh:{host,...}}`.
// Current coverage lives in:
//   - src/__tests__/routes/meta-remote-servers.test.ts  (slice 01 schema)
//   - src/__tests__/routes/remote-servers-post.test.ts  (slice 03 pipeline)

describe("/meta/version", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("reports updateAvailable=true when registry 'latest' is newer", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("0.0.1");
    vi.spyOn(pkgVersion, "getPackageName").mockReturnValue("flockctl");
    vi.spyOn(pkgVersion, "getInstallInfo").mockReturnValue({ mode: "global", root: "/usr/local/lib" });
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ "dist-tags": { latest: "0.0.2", next: "0.0.3-rc.1" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as typeof fetch;

    const res = await app.request("/meta/version");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.current).toBe("0.0.1");
    expect(body.latest).toBe("0.0.2");
    expect(body.updateAvailable).toBe(true);
    expect(body.installMode).toBe("global");
  });

  it("prefers 'next' tag when current version is a prerelease", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("0.0.1-rc.1");
    vi.spyOn(pkgVersion, "getPackageName").mockReturnValue("flockctl");
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ "dist-tags": { latest: "0.0.0", next: "0.0.1-rc.2" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as typeof fetch;

    const res = await app.request("/meta/version");
    const body = await res.json();
    expect(body.latest).toBe("0.0.1-rc.2");
    expect(body.updateAvailable).toBe(true);
  });

  it("reports updateAvailable=false when local is at or above registry", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("1.2.3");
    vi.spyOn(pkgVersion, "getPackageName").mockReturnValue("flockctl");
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ "dist-tags": { latest: "1.2.3" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as typeof fetch;

    const res = await app.request("/meta/version");
    const body = await res.json();
    expect(body.updateAvailable).toBe(false);
  });

  it("returns error field when the registry is unreachable", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("0.0.1");
    vi.spyOn(pkgVersion, "getPackageName").mockReturnValue("flockctl");
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const res = await app.request("/meta/version");
    const body = await res.json();
    expect(body.latest).toBeNull();
    expect(body.updateAvailable).toBe(false);
    expect(body.error).toMatch(/network down/);
  });
});

describe("POST /meta/update (async)", () => {
  beforeEach(() => {
    execaMock.mockReset();
    resetUpdateState();
    vi.spyOn(pkgVersion, "getPackageName").mockReturnValue("flockctl");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetUpdateState();
  });

  // Wait for the fire-and-forget IIFE in the route to settle.
  const flushMicrotasks = async () => {
    await new Promise((r) => setImmediate(r));
  };

  it("returns 202 immediately and later transitions to success", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("1.0.0");
    vi.spyOn(pkgVersion, "getInstallInfo").mockReturnValue({ mode: "global", root: "/usr/local/lib" });
    execaMock.mockResolvedValue({ failed: false, exitCode: 0, stdout: "+ flockctl@1.0.1", stderr: "" });

    const res = await app.request("/meta/update", { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.triggered).toBe(true);
    expect(body.installMode).toBe("global");
    expect(body.targetVersion).toBe("latest");
    expect(execaMock).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "flockctl@latest"],
      expect.objectContaining({ reject: false }),
    );

    await flushMicrotasks();
    const state = await (await app.request("/meta/update")).json();
    expect(state.status).toBe("success");
  });

  it("runs npm install without -g in the project root for local installs", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("1.0.0");
    vi.spyOn(pkgVersion, "getInstallInfo").mockReturnValue({ mode: "local", root: "/home/x/proj" });
    execaMock.mockResolvedValue({ failed: false, exitCode: 0, stdout: "", stderr: "" });

    const res = await app.request("/meta/update", { method: "POST" });
    expect(res.status).toBe(202);
    expect(execaMock).toHaveBeenCalledWith(
      "npm",
      ["install", "flockctl@latest"],
      expect.objectContaining({ cwd: "/home/x/proj" }),
    );
  });

  it("uses @next tag when current version is a prerelease", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("0.0.1-rc.1");
    vi.spyOn(pkgVersion, "getInstallInfo").mockReturnValue({ mode: "global", root: "/usr/local/lib" });
    execaMock.mockResolvedValue({ failed: false, exitCode: 0, stdout: "", stderr: "" });

    await app.request("/meta/update", { method: "POST" });
    expect(execaMock).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "flockctl@next"],
      expect.anything(),
    );
  });

  it("refuses with 400 (no state mutation) when install mode is unknown", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("1.0.0");
    vi.spyOn(pkgVersion, "getInstallInfo").mockReturnValue({ mode: "unknown" });

    const res = await app.request("/meta/update", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details?.installMode).toBe("unknown");
    expect(execaMock).not.toHaveBeenCalled();
    const state = await (await app.request("/meta/update")).json();
    expect(state.status).toBe("idle");
  });

  it("returns 409 when an install is already running", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("1.0.0");
    vi.spyOn(pkgVersion, "getInstallInfo").mockReturnValue({ mode: "global", root: "/usr/local/lib" });
    setUpdateState({ status: "running", targetVersion: "latest" });

    const res = await app.request("/meta/update", { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already in progress/i);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("records error state with stderr when npm install fails", async () => {
    vi.spyOn(pkgVersion, "getPackageVersion").mockReturnValue("1.0.0");
    vi.spyOn(pkgVersion, "getInstallInfo").mockReturnValue({ mode: "global", root: "/usr/local/lib" });
    execaMock.mockResolvedValue({
      failed: true,
      exitCode: 1,
      stdout: "",
      stderr: "EACCES: permission denied",
    });

    const res = await app.request("/meta/update", { method: "POST" });
    expect(res.status).toBe(202);

    await flushMicrotasks();
    const state = await (await app.request("/meta/update")).json();
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/EACCES/);
    expect(state.exitCode).toBe(1);
  });

  it("GET /meta/update returns idle by default", async () => {
    const res = await app.request("/meta/update");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("idle");
  });
});

describe("semver helper", () => {
  it("handles release vs prerelease ordering", async () => {
    const { semverGt } = await import("../../lib/package-version.js");
    expect(semverGt("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(semverGt("1.0.0-rc.1", "1.0.0")).toBe(false);
    expect(semverGt("1.0.1", "1.0.0")).toBe(true);
    expect(semverGt("1.0.0-rc.2", "1.0.0-rc.1")).toBe(true);
    expect(semverGt("1.0.0", "1.0.0")).toBe(false);
  });
});
