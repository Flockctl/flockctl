/**
 * Branch-coverage tests for `config/remote-auth.ts`.
 *
 * Fills:
 *   - remoteAccessTokens array with non-object entries (string, null)
 *   - entries missing label or token fields
 *   - entries with non-string label/token values
 *   - short-token warn path
 *   - legacy remoteAccessToken empty string (length > 0 false)
 *   - legacy token skipped when "default" already present in new array
 *   - findMatchingToken with non-string provided
 *   - addRemoteAccessToken: legacy token migration skipped when default already in array
 *   - removeRemoteAccessToken: no changes → does NOT save
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("remote-auth — branch gaps", () => {
  let tmpHome: string;
  let rcPath: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "flockctl-remote-auth-branches-"));
    rcPath = join(tmpHome, ".flockctlrc");
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    vi.resetModules();
    const paths = await import("../../config/paths.js");
    paths._resetRcCache();
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it("getConfiguredTokens skips non-object entries in the array", async () => {
    writeFileSync(
      rcPath,
      JSON.stringify({
        remoteAccessTokens: [
          "not-an-object",
          null,
          { label: "ok", token: "x".repeat(40) },
        ],
      }),
    );
    const { getConfiguredTokens } = await import("../../config/remote-auth.js");
    const out = getConfiguredTokens();
    expect(out).toEqual([{ label: "ok", token: "x".repeat(40) }]);
  });

  it("skips entries with non-string label or token", async () => {
    writeFileSync(
      rcPath,
      JSON.stringify({
        remoteAccessTokens: [
          { label: 123, token: "x".repeat(40) },
          { label: "no-token", token: null },
          { label: "ok", token: "x".repeat(40) },
        ],
      }),
    );
    const { getConfiguredTokens } = await import("../../config/remote-auth.js");
    const out = getConfiguredTokens();
    expect(out).toEqual([{ label: "ok", token: "x".repeat(40) }]);
  });

  it("warns and skips short array tokens", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(
      rcPath,
      JSON.stringify({
        remoteAccessTokens: [{ label: "short", token: "tiny" }],
      }),
    );
    const { getConfiguredTokens } = await import("../../config/remote-auth.js");
    expect(getConfiguredTokens()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("deduplicates same-label array entries (keeps first)", async () => {
    writeFileSync(
      rcPath,
      JSON.stringify({
        remoteAccessTokens: [
          { label: "a", token: "x".repeat(40) },
          { label: "a", token: "y".repeat(40) },
        ],
      }),
    );
    const { getConfiguredTokens } = await import("../../config/remote-auth.js");
    const out = getConfiguredTokens();
    expect(out).toHaveLength(1);
    expect(out[0].token).toBe("x".repeat(40));
  });

  it("legacy remoteAccessToken: empty string → skip silently (no warn)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(rcPath, JSON.stringify({ remoteAccessToken: "" }));
    const { getConfiguredTokens } = await import("../../config/remote-auth.js");
    expect(getConfiguredTokens()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("legacy remoteAccessToken: short non-empty → warn and skip", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(rcPath, JSON.stringify({ remoteAccessToken: "short" }));
    const { getConfiguredTokens } = await import("../../config/remote-auth.js");
    expect(getConfiguredTokens()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("legacy token suppressed when array already contains 'default'", async () => {
    writeFileSync(
      rcPath,
      JSON.stringify({
        remoteAccessToken: "y".repeat(40),
        remoteAccessTokens: [{ label: "default", token: "x".repeat(40) }],
      }),
    );
    const { getConfiguredTokens } = await import("../../config/remote-auth.js");
    const out = getConfiguredTokens();
    expect(out).toHaveLength(1);
    expect(out[0].token).toBe("x".repeat(40));
  });

  it("findMatchingToken returns null when provided is not a string", async () => {
    writeFileSync(
      rcPath,
      JSON.stringify({ remoteAccessTokens: [{ label: "ok", token: "x".repeat(40) }] }),
    );
    const { findMatchingToken } = await import("../../config/remote-auth.js");
    expect(findMatchingToken(undefined as unknown as string)).toBeNull();
    expect(findMatchingToken(null as unknown as string)).toBeNull();
  });

  it("addRemoteAccessToken: legacy token migration skipped when default already present in array", async () => {
    writeFileSync(
      rcPath,
      JSON.stringify({
        remoteAccessToken: "y".repeat(40),
        remoteAccessTokens: [{ label: "default", token: "x".repeat(40) }],
      }),
    );
    const { addRemoteAccessToken } = await import("../../config/remote-auth.js");
    addRemoteAccessToken("new-label", "z".repeat(40));
    const after = JSON.parse(readFileSync(rcPath, "utf-8"));
    expect(after.remoteAccessToken).toBeUndefined(); // legacy was still deleted
    const labels = after.remoteAccessTokens.map((e: { label: string }) => e.label);
    expect(labels).toContain("default");
    expect(labels).toContain("new-label");
    // No duplicate 'default' pushed.
    expect(labels.filter((l: string) => l === "default").length).toBe(1);
  });

  it("removeRemoteAccessToken: no matching label → does not save, returns false", async () => {
    const initial = {
      remoteAccessTokens: [{ label: "keep", token: "x".repeat(40) }],
    };
    writeFileSync(rcPath, JSON.stringify(initial));
    // Snapshot mtime before
    const mtimeBefore = statSync(rcPath).mtimeMs;
    const { removeRemoteAccessToken } = await import("../../config/remote-auth.js");
    const result = removeRemoteAccessToken("nonexistent");
    expect(result).toBe(false);
    // File wasn't rewritten
    const mtimeAfter = statSync(rcPath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("removeRemoteAccessToken('default') removes legacy remoteAccessToken too", async () => {
    writeFileSync(
      rcPath,
      JSON.stringify({ remoteAccessToken: "x".repeat(40) }),
    );
    const { removeRemoteAccessToken } = await import("../../config/remote-auth.js");
    expect(removeRemoteAccessToken("default")).toBe(true);
    const after = JSON.parse(readFileSync(rcPath, "utf-8"));
    expect(after.remoteAccessToken).toBeUndefined();
  });
});
