/**
 * Branch-coverage tests for `config/remote-servers.ts`.
 *
 * Fills the gaps left by the existing suites:
 *   - addRemoteServerWithToken id-collision guard
 *   - updateRemoteServer empty-host fallback
 *   - updateRemoteServer token/tokenLabel set-to-null (erase) branch
 *   - purgeLegacyRemoteServers non-object entries in the array
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("remote-servers — branch gaps", () => {
  let tmpHome: string;
  let rcPath: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "flockctl-remoteservers-branches-"));
    rcPath = join(tmpHome, ".flockctlrc");
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it("addRemoteServerWithToken throws on id collision", async () => {
    const mod = await import("../../config/remote-servers.js");
    mod.addRemoteServerWithToken({
      id: "fixed-id",
      name: "first",
      ssh: { host: "a.example" },
      token: "t1",
      tokenLabel: "label-1",
    });
    expect(() =>
      mod.addRemoteServerWithToken({
        id: "fixed-id",
        name: "dup",
        ssh: { host: "b.example" },
        token: "t2",
        tokenLabel: "label-2",
      }),
    ).toThrow(/remote server id collision/);
  });

  it("updateRemoteServer returns null for unknown id", async () => {
    const mod = await import("../../config/remote-servers.js");
    expect(mod.updateRemoteServer("missing", { name: "x" })).toBeNull();
  });

  it("updateRemoteServer retains original host when input clears it to empty string", async () => {
    // Exercises the `if (!merged.host || typeof merged.host !== 'string')`
    // guard that preserves the original non-empty host.
    const mod = await import("../../config/remote-servers.js");
    const created = mod.addRemoteServer({
      name: "srv",
      ssh: { host: "kept.example", port: 22 },
    });
    const updated = mod.updateRemoteServer(created.id, {
      // Intentionally clearing host for test — exercises the empty-host fallback.
      ssh: { host: "" },
    });
    expect(updated?.ssh.host).toBe("kept.example");
  });

  it("updateRemoteServer erases token/tokenLabel when passed null", async () => {
    // Exercises the ternary `input.token === null ? undefined : …` branch.
    const mod = await import("../../config/remote-servers.js");
    const created = mod.addRemoteServerWithToken({
      id: "explicit-id",
      name: "withtok",
      ssh: { host: "h.example" },
      token: "old-token",
      tokenLabel: "old-label",
    });
    const updated = mod.updateRemoteServer(created.id, {
      token: null,
      tokenLabel: null,
    });
    expect(updated?.token).toBeUndefined();
    expect(updated?.tokenLabel).toBeUndefined();
  });

  it("updateRemoteServer falls back to undefined when token is empty string", async () => {
    // Exercises `input.token || undefined` — the "" branch.
    const mod = await import("../../config/remote-servers.js");
    const created = mod.addRemoteServerWithToken({
      id: "explicit-id-2",
      name: "withtok2",
      ssh: { host: "h2.example" },
      token: "old",
      tokenLabel: "lbl",
    });
    const updated = mod.updateRemoteServer(created.id, {
      token: "",
      tokenLabel: "",
    });
    expect(updated?.token).toBeUndefined();
    expect(updated?.tokenLabel).toBeUndefined();
  });

  it("deleteRemoteServer returns false when id is absent", async () => {
    const mod = await import("../../config/remote-servers.js");
    expect(mod.deleteRemoteServer("nonexistent")).toBe(false);
  });

  it("purgeLegacyRemoteServers drops non-object entries", async () => {
    // Exercises the `if (!e || typeof e !== 'object') return false` branch.
    writeFileSync(
      rcPath,
      JSON.stringify({
        remoteServers: [
          "not-an-object-string",
          null,
          42,
          { id: "valid", name: "good", ssh: { host: "user@host" } },
        ],
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("../../config/remote-servers.js");
    const result = mod.purgeLegacyRemoteServers();
    warnSpy.mockRestore();
    // The three non-object entries are removed; "(unnamed)" label is used
    // because they have no `.name` string.
    expect(result.removed).toEqual(["(unnamed)", "(unnamed)", "(unnamed)"]);
    const servers = mod.getRemoteServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe("good");
  });
});
