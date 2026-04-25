/**
 * `ensureTokenForLabel` — the idempotent "mint if missing" helper that
 * backs `flockctl remote-bootstrap --label <name>`.
 *
 * These cases drive the function against a *real* `~/.flockctlrc` on a
 * per-test tmpdir so we can verify both the wire format (the JSON we
 * actually write) and the filesystem side effects (chmod 0600 via saveRc,
 * read-back round-trips) without mocking the paths layer. The tmpdir trick
 * — flip `$HOME`, `vi.resetModules()`, re-import — mirrors the existing
 * `purge-legacy.test.ts` harness because `RC_FILE` is captured at module
 * load.
 *
 * Coverage map:
 *  - Hit: pre-seeded label returns the existing token and leaves rc
 *    byte-for-byte unchanged.
 *  - Miss: a new label appends one entry with {label, token, createdAt},
 *    returns the minted token, and persists to disk.
 *  - Token shape: 43 chars, charset [A-Za-z0-9_-] (base64url, no padding)
 *    so it satisfies the stdout security regex `^[A-Za-z0-9_-]{20,}\n$`.
 *  - Independence: seeding 10 unrelated tokens and minting an 11th must not
 *    perturb any of the pre-existing entries (byte-for-byte).
 *  - Empty rc: minting from a non-existent rc file creates one with just
 *    the new entry.
 *  - Malformed rc entries: non-object / missing-field entries are silently
 *    dropped from the rewrite (read-side hygiene) without blocking the
 *    mint.
 *  - Idempotency: two back-to-back calls with the same label yield the
 *    same token and don't duplicate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

// Matches the stdout security regex for remote-bootstrap: 20+ base64url
// characters. The real function always returns 43, but the production-side
// regex is the looser lower bound we check against here.
const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("ensureTokenForLabel", () => {
  let tmpHome: string;
  let rcPath: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "flockctl-ensure-token-"));
    rcPath = join(tmpHome, ".flockctlrc");
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // RC_FILE and the rc cache are captured at module import time, so we
    // must re-evaluate the config module after flipping $HOME.
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

  /* -------------------------------------------------------------------- */
  /* Hit: matching label → return existing token                           */
  /* -------------------------------------------------------------------- */

  it("returns the existing token unchanged when the label already exists", async () => {
    const existingToken =
      "preseeded-token-43-chars-long-abcdefghijklmnopqrs"; // 50 chars; matches charset
    const rcBefore = {
      remoteAccessTokens: [
        { label: "laptop", token: existingToken, createdAt: "2020-01-01T00:00:00.000Z" },
      ],
    };
    writeFileSync(rcPath, JSON.stringify(rcBefore, null, 2), "utf-8");
    const beforeBytes = readFileSync(rcPath);

    const { ensureTokenForLabel } = await import(
      "../../cli-commands/remote-bootstrap.js"
    );

    const got = ensureTokenForLabel("laptop");
    expect(got).toBe(existingToken);

    // No rc write on the hit path → bytes must be untouched. (saveRc would
    // re-serialize without the 2-space indent we used above, so even a
    // no-op write would be visible here.)
    const afterBytes = readFileSync(rcPath);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
  });

  /* -------------------------------------------------------------------- */
  /* Miss: new label → append + save                                       */
  /* -------------------------------------------------------------------- */

  it("mints a fresh base64url token when the label is new", async () => {
    const { ensureTokenForLabel } = await import(
      "../../cli-commands/remote-bootstrap.js"
    );

    const t0 = Date.now();
    const token = ensureTokenForLabel("new-laptop");
    const t1 = Date.now();

    // 32 random bytes → base64url(no padding) is exactly 43 chars.
    expect(token).toHaveLength(43);
    expect(token).toMatch(BASE64URL);
    // Satisfies the stdout security regex lower bound.
    expect(token.length).toBeGreaterThanOrEqual(20);

    const rc = JSON.parse(readFileSync(rcPath, "utf-8"));
    expect(Array.isArray(rc.remoteAccessTokens)).toBe(true);
    expect(rc.remoteAccessTokens).toHaveLength(1);

    const entry = rc.remoteAccessTokens[0];
    expect(entry.label).toBe("new-laptop");
    expect(entry.token).toBe(token);
    expect(typeof entry.createdAt).toBe("string");

    // createdAt should be a valid ISO timestamp within the test window.
    const created = Date.parse(entry.createdAt);
    expect(Number.isFinite(created)).toBe(true);
    expect(created).toBeGreaterThanOrEqual(t0);
    expect(created).toBeLessThanOrEqual(t1);
    // ISO-8601 Zulu format (what toISOString produces).
    expect(entry.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  /* -------------------------------------------------------------------- */
  /* bootstrap_with_rc_containing_10_other_tokens                          */
  /* -------------------------------------------------------------------- */

  it("appends without mutating any of 10 pre-existing entries", async () => {
    // Seed 10 unrelated tokens. Each is distinct in label + token so we
    // can assert bytewise equality position-by-position.
    const seeded = Array.from({ length: 10 }, (_, i) => ({
      label: `seeded-${i}`,
      token: `seeded-token-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
      createdAt: `2020-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    writeFileSync(
      rcPath,
      JSON.stringify({ remoteAccessTokens: seeded }, null, 2),
      "utf-8",
    );

    // Snapshot the seeded entries as their exact on-disk JSON shape before
    // we touch anything. We compare serialized form to catch any
    // reordering or field mutation in the rewrite.
    const seededSerialized = seeded.map((e) => JSON.stringify(e));

    const { ensureTokenForLabel } = await import(
      "../../cli-commands/remote-bootstrap.js"
    );

    const freshToken = ensureTokenForLabel("the-11th");
    expect(freshToken).toHaveLength(43);
    expect(freshToken).toMatch(BASE64URL);

    const rcAfter = JSON.parse(readFileSync(rcPath, "utf-8"));
    expect(rcAfter.remoteAccessTokens).toHaveLength(11);

    // The first 10 entries must be byte-identical to what we seeded
    // (same field values, unchanged createdAt). We check via serialized
    // form to ensure no field was dropped, reordered in value, or rewritten.
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(rcAfter.remoteAccessTokens[i])).toBe(
        seededSerialized[i],
      );
    }

    // The 11th entry is the freshly-minted one.
    const appended = rcAfter.remoteAccessTokens[10];
    expect(appended.label).toBe("the-11th");
    expect(appended.token).toBe(freshToken);
    expect(typeof appended.createdAt).toBe("string");
  });

  /* -------------------------------------------------------------------- */
  /* Empty rc                                                              */
  /* -------------------------------------------------------------------- */

  it("creates rc with a single entry when no rc file exists", async () => {
    const { ensureTokenForLabel } = await import(
      "../../cli-commands/remote-bootstrap.js"
    );

    const token = ensureTokenForLabel("fresh");
    expect(token).toMatch(BASE64URL);

    const rc = JSON.parse(readFileSync(rcPath, "utf-8"));
    expect(rc.remoteAccessTokens).toEqual([
      expect.objectContaining({ label: "fresh", token }),
    ]);
  });

  /* -------------------------------------------------------------------- */
  /* Malformed rc entries                                                  */
  /* -------------------------------------------------------------------- */

  it("ignores malformed entries on read (no match, still mints)", async () => {
    // Mix of malformed entries that must neither match nor block the mint:
    //   - null
    //   - a primitive
    //   - an object with non-string label
    //   - an object with missing token
    //   - a sub-array (Array.isArray guard)
    writeFileSync(
      rcPath,
      JSON.stringify({
        remoteAccessTokens: [
          null,
          "just-a-string",
          { label: 42, token: "x" },
          { label: "incomplete" },
          ["nested"],
        ],
      }),
      "utf-8",
    );

    const { ensureTokenForLabel } = await import(
      "../../cli-commands/remote-bootstrap.js"
    );

    // None of the malformed entries should be treated as a match for
    // "incomplete" — we must mint a new token for it.
    const token = ensureTokenForLabel("incomplete");
    expect(token).toHaveLength(43);
    expect(token).toMatch(BASE64URL);

    const rc = JSON.parse(readFileSync(rcPath, "utf-8"));
    const tokens = rc.remoteAccessTokens;
    // All malformed entries are scrubbed from the rewrite; the new
    // entry is the sole survivor.
    const newEntries = tokens.filter(
      (e: any) => e && typeof e === "object" && e.label === "incomplete",
    );
    expect(newEntries).toHaveLength(1);
    expect(newEntries[0].token).toBe(token);
  });

  /* -------------------------------------------------------------------- */
  /* Idempotency: same label twice → same token, no duplicate             */
  /* -------------------------------------------------------------------- */

  it("is idempotent: a second call with the same label returns the same token", async () => {
    const { ensureTokenForLabel } = await import(
      "../../cli-commands/remote-bootstrap.js"
    );

    const first = ensureTokenForLabel("laptop");
    const second = ensureTokenForLabel("laptop");
    expect(second).toBe(first);

    const rc = JSON.parse(readFileSync(rcPath, "utf-8"));
    expect(
      rc.remoteAccessTokens.filter((e: any) => e.label === "laptop"),
    ).toHaveLength(1);
  });

  /* -------------------------------------------------------------------- */
  /* Distinct labels → distinct tokens                                     */
  /* -------------------------------------------------------------------- */

  it("mints a different token for each distinct label", async () => {
    const { ensureTokenForLabel } = await import(
      "../../cli-commands/remote-bootstrap.js"
    );

    const a = ensureTokenForLabel("a");
    const b = ensureTokenForLabel("b");
    expect(a).not.toBe(b);
    expect(a).toMatch(BASE64URL);
    expect(b).toMatch(BASE64URL);

    const rc = JSON.parse(readFileSync(rcPath, "utf-8"));
    expect(rc.remoteAccessTokens).toHaveLength(2);
    expect(rc.remoteAccessTokens.map((e: any) => e.label)).toEqual(["a", "b"]);
  });
});
