import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This suite drives `purgeLegacyRemoteServers` against a real filesystem so
// that `chmod 0o600` enforcement by saveRc() is actually verifiable. We
// isolate HOME to a per-test tmp dir — os.homedir() reads $HOME on Unix, and
// the RC_FILE constant is recomputed when the module is freshly imported
// after `vi.resetModules()`.

const LONG_TOKEN = "SECRET-TOKEN-123-do-not-leak-this-value-ever!!!";

describe("purgeLegacyRemoteServers", () => {
  let tmpHome: string;
  let rcPath: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "flockctl-purge-"));
    rcPath = join(tmpHome, ".flockctlrc");
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Ensure a fresh module graph — RC_FILE and the rc cache are captured
    // at module load, so we must re-import after flipping HOME.
    vi.resetModules();
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("returns no removals when rc file does not exist", async () => {
    const { purgeLegacyRemoteServers } = await import(
      "../../config/remote-servers.js"
    );
    expect(purgeLegacyRemoteServers().removed).toEqual([]);
  });

  it("returns no removals when remoteServers key is missing", async () => {
    writeFileSync(rcPath, JSON.stringify({ home: "/x" }));
    const { purgeLegacyRemoteServers } = await import(
      "../../config/remote-servers.js"
    );
    expect(purgeLegacyRemoteServers().removed).toEqual([]);
  });

  it("leaves the rc file untouched when every entry is valid", async () => {
    writeFileSync(
      rcPath,
      JSON.stringify({
        remoteServers: [
          { id: "1", name: "prod", ssh: { host: "user@prod.example" } },
          { id: "2", name: "dev", ssh: { host: "dev.example" } },
        ],
      }),
    );
    const before = readFileSync(rcPath, "utf-8");
    const { purgeLegacyRemoteServers } = await import(
      "../../config/remote-servers.js"
    );
    expect(purgeLegacyRemoteServers().removed).toEqual([]);
    expect(readFileSync(rcPath, "utf-8")).toBe(before);
  });

  it("drops entries without ssh.host and keeps valid ones", async () => {
    writeFileSync(
      rcPath,
      JSON.stringify({
        remoteServers: [
          // legacy direct-HTTP shape — missing ssh entirely
          { id: "a", name: "legacy-http", url: "https://old.example", token: "abc" },
          // structurally malformed — ssh.host is empty
          { id: "b", name: "no-host", ssh: { host: "" } },
          // valid SSH entry
          { id: "c", name: "modern", ssh: { host: "user@new.example" } },
        ],
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { purgeLegacyRemoteServers } = await import(
      "../../config/remote-servers.js"
    );

    const result = purgeLegacyRemoteServers();

    expect(result.removed).toEqual(["legacy-http", "no-host"]);
    const saved = JSON.parse(readFileSync(rcPath, "utf-8"));
    expect(saved.remoteServers).toHaveLength(1);
    expect(saved.remoteServers[0].name).toBe("modern");
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("purge_logs_do_not_leak_tokens", async () => {
    writeFileSync(
      rcPath,
      JSON.stringify({
        remoteServers: [
          {
            id: "x",
            name: "leaky",
            url: "https://leaky.example",
            token: LONG_TOKEN,
          },
          {
            // legacy variant with tokenLabel but still missing ssh.host
            id: "y",
            name: "also-leaky",
            token: LONG_TOKEN,
            tokenLabel: "default",
          },
        ],
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { purgeLegacyRemoteServers } = await import(
      "../../config/remote-servers.js"
    );
    purgeLegacyRemoteServers();

    expect(warnSpy).toHaveBeenCalled();
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("leaky");
    expect(logged).toContain("also-leaky");
    // Critical: the token value must NEVER appear in the log output.
    expect(logged).not.toContain(LONG_TOKEN);
    warnSpy.mockRestore();
  });

  it("rc_file_mode_0o600_after_purge", async () => {
    writeFileSync(
      rcPath,
      JSON.stringify({
        remoteServers: [
          { id: "a", name: "legacy", url: "https://old.example" },
        ],
      }),
    );
    // Start from an explicitly insecure mode so we can observe saveRc()
    // tightening it back to 0o600 as part of the purge write.
    chmodSync(rcPath, 0o644);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { purgeLegacyRemoteServers } = await import(
      "../../config/remote-servers.js"
    );
    const result = purgeLegacyRemoteServers();
    warnSpy.mockRestore();

    expect(result.removed).toEqual(["legacy"]);
    const mode = statSync(rcPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("labels nameless entries as (unnamed)", async () => {
    writeFileSync(
      rcPath,
      JSON.stringify({
        remoteServers: [
          { id: "nameless", url: "https://x.example" },
          { id: "c", name: "modern", ssh: { host: "host" } },
        ],
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { purgeLegacyRemoteServers } = await import(
      "../../config/remote-servers.js"
    );
    const result = purgeLegacyRemoteServers();
    warnSpy.mockRestore();
    expect(result.removed).toEqual(["(unnamed)"]);
  });
});
