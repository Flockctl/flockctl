import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";

import {
  getClaudeIdentity,
  keychainServiceFor,
  KeychainAclError,
} from "../../services/claude/identity.js";

// ─── keychainServiceFor ──────────────────────────────────────────────────

describe("keychainServiceFor", () => {
  it("returns the bare service name for the default ~/.claude dir", () => {
    expect(keychainServiceFor(join(homedir(), ".claude"))).toBe("Claude Code-credentials");
  });

  it("returns sha256-first-8-hex suffix for a custom absolute config dir", () => {
    const dir = join(homedir(), ".claude-work");
    const expectedHash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
    expect(keychainServiceFor(dir)).toBe(`Claude Code-credentials-${expectedHash}`);
  });

  it("is deterministic — same input, same service name", () => {
    const dir = "/etc/claude-code/custom";
    expect(keychainServiceFor(dir)).toBe(keychainServiceFor(dir));
  });
});

// ─── getClaudeIdentity — happy path ──────────────────────────────────────

const PROFILE_JSON = {
  account: {
    uuid: "2133fc87-5a8a-4c7e-aad3-ad3d746efd3e",
    email: "user@example.com",
    has_claude_max: true,
    has_claude_pro: false,
  },
  organization: {
    uuid: "28d38e39-a1cd-42c9-8016-ffa0a5a133d9",
    name: "user@example.com's Organization",
    organization_type: "claude_max",
    rate_limit_tier: "default_claude_max_20x",
    subscription_status: "active",
  },
};

describe("getClaudeIdentity", () => {
  it("resolves the profile via Anthropic API when a token is present", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => PROFILE_JSON,
    }) as unknown as typeof fetch;

    const identity = await getClaudeIdentity("~/.claude-work", {
      fetchImpl,
      readToken: async () => "sk-ant-oat01-fake-token",
    });

    expect(identity).toEqual({
      loggedIn: true,
      email: "user@example.com",
      accountUuid: "2133fc87-5a8a-4c7e-aad3-ad3d746efd3e",
      organizationUuid: "28d38e39-a1cd-42c9-8016-ffa0a5a133d9",
      organizationName: "user@example.com's Organization",
      organizationType: "claude_max",
      rateLimitTier: "default_claude_max_20x",
      hasClaudeMax: true,
      hasClaudePro: false,
      subscriptionStatus: "active",
    });

    // Verify the Authorization header was sent
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = (fetchImpl as any).mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer sk-ant-oat01-fake-token");
  });

  it("expands ~ and passes the absolute dir to the token reader", async () => {
    const readToken = vi.fn().mockResolvedValue("tok");
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => PROFILE_JSON,
    }) as unknown as typeof fetch;

    await getClaudeIdentity("~/.claude-work", { fetchImpl, readToken });

    expect(readToken).toHaveBeenCalledWith(join(homedir(), ".claude-work"), process.platform);
  });

  it("defaults null configDir to ~/.claude", async () => {
    const readToken = vi.fn().mockResolvedValue("tok");
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => PROFILE_JSON,
    }) as unknown as typeof fetch;

    await getClaudeIdentity(null, { fetchImpl, readToken });

    expect(readToken).toHaveBeenCalledWith(join(homedir(), ".claude"), process.platform);
  });

  it("returns loggedIn:false with a helpful message when no token is found (darwin)", async () => {
    const result = await getClaudeIdentity("/opt/fake", {
      readToken: async () => null,
      platform: "darwin",
    });
    expect(result.loggedIn).toBe(false);
    expect(result.error).toContain("Keychain");
    expect(result.error).toContain("Claude Code-credentials-"); // suffix for non-default dir
  });

  it("returns loggedIn:false with file-based hint on linux when no token is found", async () => {
    const result = await getClaudeIdentity("/opt/fake", {
      readToken: async () => null,
      platform: "linux",
    });
    expect(result.loggedIn).toBe(false);
    expect(result.error).toContain(".credentials.json");
    expect(result.error).toContain("/opt/fake");
  });

  it("returns loggedIn:false when Anthropic returns non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "unauthorized" }),
    }) as unknown as typeof fetch;

    const result = await getClaudeIdentity("~/.claude", {
      fetchImpl,
      readToken: async () => "stale-token",
    });
    expect(result.loggedIn).toBe(false);
    expect(result.error).toBe("anthropic returned HTTP 401");
  });

  it("returns loggedIn:false on network / fetch error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await getClaudeIdentity("~/.claude", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readToken: async () => "tok",
    });
    expect(result.loggedIn).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("returns loggedIn:false with a 'failed to read token' message when the reader throws", async () => {
    const result = await getClaudeIdentity("~/.claude", {
      readToken: async () => { throw new Error("keychain locked"); },
    });
    expect(result.loggedIn).toBe(false);
    expect(result.error).toBe("failed to read token: keychain locked");
  });

  it("returns the ACL-specific error when the reader throws KeychainAclError", async () => {
    // Simulates the headless-daemon scenario where `security` exits because
    // it cannot prompt for ACL permission. The UI needs a distinct message
    // ("grant Always Allow") rather than the generic "not logged in".
    const result = await getClaudeIdentity("~/.claude", {
      readToken: async () => {
        throw new KeychainAclError("security: User interaction is not allowed.");
      },
    });
    expect(result.loggedIn).toBe(false);
    expect(result.error).toContain("Always Allow");
    expect(result.error).toContain("keychain access denied");
  });

  it("passes the effective platform through to the token reader", async () => {
    const readToken = vi.fn().mockResolvedValue("tok");
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => PROFILE_JSON,
    }) as unknown as typeof fetch;

    await getClaudeIdentity("/etc/claude", { fetchImpl, readToken, platform: "linux" });
    expect(readToken).toHaveBeenCalledWith("/etc/claude", "linux");
  });

  it("expands a bare '~' to the home directory", async () => {
    // Exercises expandDir's `configDir === "~"` branch (distinct from "~/…").
    const readToken = vi.fn().mockResolvedValue("tok");
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => PROFILE_JSON,
    }) as unknown as typeof fetch;

    await getClaudeIdentity("~", { fetchImpl, readToken, platform: "linux" });
    expect(readToken).toHaveBeenCalledWith(homedir(), "linux");
  });

  it("handles a profile response missing account/organization keys", async () => {
    // Exercises the falsy limb of every j.account?.* and j.organization?.*
    // optional chain — the remote could in principle drop these top-level
    // keys entirely (observed during account-in-migration states).
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({}),
    }) as unknown as typeof fetch;
    const result = await getClaudeIdentity("~/.claude", {
      fetchImpl,
      readToken: async () => "tok",
      platform: "linux",
    });
    expect(result).toEqual({
      loggedIn: true,
      email: undefined,
      accountUuid: undefined,
      organizationUuid: undefined,
      organizationName: undefined,
      organizationType: undefined,
      rateLimitTier: undefined,
      hasClaudeMax: undefined,
      hasClaudePro: undefined,
      subscriptionStatus: undefined,
    });
  });

  it("stringifies non-Error throwables from the token reader", async () => {
    // Exercises errMsg's fallback branch (e instanceof Error ? ... : String(e))
    // when the reader rejects with a plain string.
    const result = await getClaudeIdentity("~/.claude", {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      readToken: async () => { throw "disk-gone"; },
    });
    expect(result.loggedIn).toBe(false);
    expect(result.error).toContain("failed to read token: disk-gone");
  });
});

// ─── Default token reader (file-based fallback) ──────────────────────────
//
// Exercises the real `defaultReadToken` by pointing it at a tmp dir with a
// hand-written `.credentials.json`. Forcing `platform: "linux"` skips the
// macOS Keychain branch so the test is deterministic on any host.

describe("getClaudeIdentity — default reader (file fallback)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flockctl-identity-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the token from <absDir>/.credentials.json on linux", async () => {
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-from-file" } }),
    );

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => PROFILE_JSON,
    }) as unknown as typeof fetch;

    const identity = await getClaudeIdentity(dir, { fetchImpl, platform: "linux" });

    expect(identity.loggedIn).toBe(true);
    expect(identity.email).toBe("user@example.com");
    const [, init] = (fetchImpl as any).mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer tok-from-file");
  });

  it("returns loggedIn:false when the credentials file is absent", async () => {
    const missing = join(dir, "definitely-missing");
    mkdirSync(missing);
    const identity = await getClaudeIdentity(missing, { platform: "linux" });
    expect(identity.loggedIn).toBe(false);
    expect(identity.error).toContain(".credentials.json");
  });

  it("returns loggedIn:false on malformed credentials JSON", async () => {
    writeFileSync(join(dir, ".credentials.json"), "{ not valid json");
    const identity = await getClaudeIdentity(dir, { platform: "linux" });
    expect(identity.loggedIn).toBe(false);
    expect(identity.error).toContain(".credentials.json");
  });

  it("returns loggedIn:false when the JSON lacks claudeAiOauth.accessToken", async () => {
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ somethingElse: true }));
    const identity = await getClaudeIdentity(dir, { platform: "linux" });
    expect(identity.loggedIn).toBe(false);
    expect(identity.error).toContain(".credentials.json");
  });
});
