#!/usr/bin/env tsx
/**
 * CLI-docker coverage for `flockctl token {generate,list,revoke}`.
 *
 * These tests drive src/cli.ts lines 59–135 (the `tokenCmd` block) and
 * indirectly exercise addRemoteAccessToken / getConfiguredTokens /
 * removeRemoteAccessToken. Each case is self-contained: the `resetRc`
 * helper wipes `/root/.flockctlrc` (the container root's RC file,
 * since `RC_FILE = homedir() + "/.flockctlrc"`) so state cannot leak
 * between cases.
 *
 * Verification:
 *   npm run test:cli-docker -- --grep token
 */
import { assert, withCliDocker, type CliDockerContext } from "./_harness.js";

/** URL-safe base64 alphabet. Used to validate generated token charset. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Strip ANSI escapes so regex assertions don't accidentally straddle them. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

async function resetRc(ctx: CliDockerContext): Promise<void> {
  const r = await ctx.exec(["sh", "-c", "rm -f /root/.flockctlrc"], {
    raw: true,
    timeoutMs: 5_000,
  });
  assert(r.code === 0, `rm -f /root/.flockctlrc failed: ${r.stderr}`);
}

async function readRc(
  ctx: CliDockerContext,
): Promise<{ present: boolean; contents: string; mode: string | null }> {
  const r = await ctx.exec(
    [
      "sh",
      "-c",
      "if [ -f /root/.flockctlrc ]; then " +
        "printf 'PRESENT\\n'; " +
        "stat -c '%a' /root/.flockctlrc; " +
        "cat /root/.flockctlrc; " +
        "else printf 'ABSENT\\n'; fi",
    ],
    { raw: true, timeoutMs: 5_000 },
  );
  assert(r.code === 0, `read rc failed: ${r.stderr}`);
  const [head, ...rest] = r.stdout.split("\n");
  if (head === "ABSENT") {
    return { present: false, contents: "", mode: null };
  }
  const mode = rest[0] ?? null;
  const contents = rest.slice(1).join("\n");
  return { present: true, contents, mode };
}

interface TokenEntry {
  label: string;
  token: string;
}

function parseTokens(rcJson: string): TokenEntry[] {
  const parsed = JSON.parse(rcJson) as Record<string, unknown>;
  const arr = parsed.remoteAccessTokens;
  if (!Array.isArray(arr)) return [];
  const out: TokenEntry[] = [];
  for (const e of arr) {
    if (e && typeof e === "object") {
      const { label, token } = e as { label?: unknown; token?: unknown };
      if (typeof label === "string" && typeof token === "string") {
        out.push({ label, token });
      }
    }
  }
  return out;
}

/** Extract the 43-char base64url token from `generate` (no --save) output. */
function extractToken(stdout: string): string {
  const lines = stripAnsi(stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const l of lines) {
    if (l.length === 43 && BASE64URL_RE.test(l)) return l;
  }
  throw new Error(
    `no 43-char base64url token found in output: ${JSON.stringify(stdout)}`,
  );
}

await withCliDocker(async (ctx) => {
  // ─────────────────────────────────────────────────────────────────────
  // 1. Generate without --save
  // ─────────────────────────────────────────────────────────────────────
  await resetRc(ctx);
  {
    const r = await ctx.exec(["token", "generate"], { timeoutMs: 15_000 });
    assert(r.code === 0, `generate (no --save) should exit 0, got ${r.code}; stderr=${r.stderr}`);

    const out = stripAnsi(r.stdout);
    const token = extractToken(out);
    assert(
      token.length === 43 && BASE64URL_RE.test(token),
      `expected 43-char base64url token, got ${JSON.stringify(token)}`,
    );
    assert(
      /To save it:/.test(out),
      `expected "To save it:" hint in output, got ${JSON.stringify(out)}`,
    );
    assert(
      /flockctl token generate --label default --save/.test(out),
      `expected --save hint in output, got ${JSON.stringify(out)}`,
    );
    assert(
      /Or add it manually to ~\/\.flockctlrc:/.test(out),
      `expected manual-edit hint in output, got ${JSON.stringify(out)}`,
    );

    // RC file must NOT have been touched.
    const rc = await readRc(ctx);
    assert(
      !rc.present,
      `~/.flockctlrc must not exist after generate without --save, but found: ${rc.contents}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 2. Generate --save (default label) — RC written, chmod 600
  // ─────────────────────────────────────────────────────────────────────
  await resetRc(ctx);
  {
    const r = await ctx.exec(["token", "generate", "--save"], { timeoutMs: 15_000 });
    assert(
      r.code === 0,
      `generate --save should exit 0, got ${r.code}; stderr=${r.stderr}`,
    );
    const out = stripAnsi(r.stdout);
    assert(
      /Token saved to ~\/\.flockctlrc \(label: default\)/.test(out),
      `expected "Token saved… (label: default)" line, got ${JSON.stringify(out)}`,
    );
    assert(
      /This is the only time the full token will be shown/.test(out),
      `expected one-time disclosure hint, got ${JSON.stringify(out)}`,
    );

    const rc = await readRc(ctx);
    assert(rc.present, `~/.flockctlrc should exist after --save`);
    assert(
      rc.mode === "600",
      `~/.flockctlrc should be chmod 600, got ${JSON.stringify(rc.mode)}`,
    );
    const tokens = parseTokens(rc.contents);
    assert(
      tokens.length === 1,
      `expected exactly 1 token in RC, got ${tokens.length}: ${rc.contents}`,
    );
    assert(
      tokens[0].label === "default",
      `expected remoteAccessTokens[0].label === "default", got ${JSON.stringify(tokens[0].label)}`,
    );
    assert(
      tokens[0].token.length === 43 && BASE64URL_RE.test(tokens[0].token),
      `persisted token should be 43-char base64url, got ${JSON.stringify(tokens[0].token)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 3. Generate --save with a duplicate label → exit 1 + uniqueness err
  // ─────────────────────────────────────────────────────────────────────
  await resetRc(ctx);
  {
    const first = await ctx.exec(["token", "generate", "--save"], {
      timeoutMs: 15_000,
    });
    assert(first.code === 0, `first generate --save should exit 0`);

    const second = await ctx.exec(["token", "generate", "--save"], {
      timeoutMs: 15_000,
    });
    assert(
      second.code === 1,
      `duplicate-label generate should exit 1, got ${second.code}; stdout=${second.stdout}; stderr=${second.stderr}`,
    );
    const err = stripAnsi(second.stderr);
    assert(
      /already exists/i.test(err),
      `stderr should mention uniqueness ("already exists"), got ${JSON.stringify(err)}`,
    );
    assert(
      /default/.test(err),
      `stderr should mention the conflicting label, got ${JSON.stringify(err)}`,
    );

    // RC still has exactly one token — second call must not have
    // partially overwritten anything.
    const rc = await readRc(ctx);
    const tokens = parseTokens(rc.contents);
    assert(
      tokens.length === 1 && tokens[0].label === "default",
      `RC should still hold exactly the original "default" token, got ${rc.contents}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 4. Generate --save --label <custom>
  // ─────────────────────────────────────────────────────────────────────
  await resetRc(ctx);
  {
    const r = await ctx.exec(
      ["token", "generate", "--label", "ci", "--save"],
      { timeoutMs: 15_000 },
    );
    assert(
      r.code === 0,
      `generate --label ci --save should exit 0, got ${r.code}; stderr=${r.stderr}`,
    );
    const out = stripAnsi(r.stdout);
    assert(
      /Token saved to ~\/\.flockctlrc \(label: ci\)/.test(out),
      `expected "(label: ci)" in output, got ${JSON.stringify(out)}`,
    );

    const rc = await readRc(ctx);
    const tokens = parseTokens(rc.contents);
    assert(
      tokens.length === 1 && tokens[0].label === "ci",
      `expected single token with label "ci", got ${rc.contents}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 5. List empty
  // ─────────────────────────────────────────────────────────────────────
  await resetRc(ctx);
  {
    const r = await ctx.exec(["token", "list"], { timeoutMs: 15_000 });
    assert(r.code === 0, `token list (empty) should exit 0, got ${r.code}; stderr=${r.stderr}`);
    const out = stripAnsi(r.stdout);
    assert(
      /No remote access tokens configured\./.test(out),
      `expected "No remote access tokens configured." message, got ${JSON.stringify(out)}`,
    );
    assert(
      /Generate one with: flockctl token generate --save/.test(out),
      `expected generate hint, got ${JSON.stringify(out)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 6. List populated — two labels of different length, check padding +
  //    fingerprint shape
  // ─────────────────────────────────────────────────────────────────────
  await resetRc(ctx);
  {
    const g1 = await ctx.exec(
      ["token", "generate", "--label", "a", "--save"],
      { timeoutMs: 15_000 },
    );
    assert(g1.code === 0, `generate label=a should succeed`);
    const g2 = await ctx.exec(
      ["token", "generate", "--label", "thelongerone", "--save"],
      { timeoutMs: 15_000 },
    );
    assert(g2.code === 0, `generate label=thelongerone should succeed`);

    const r = await ctx.exec(["token", "list"], { timeoutMs: 15_000 });
    assert(r.code === 0, `token list should exit 0, got ${r.code}; stderr=${r.stderr}`);

    const out = stripAnsi(r.stdout);
    const lines = out.split("\n").filter((l) => l.length > 0);
    assert(lines.length >= 3, `expected at least 3 lines (header + 2 rows), got ${JSON.stringify(lines)}`);

    // Header: LABEL padded to the width of "thelongerone" (12) then "  FINGERPRINT".
    // Math.max(5, 1, 12) === 12. So expected header: "LABEL       " + "  FINGERPRINT".
    const [header, ...rows] = lines;
    assert(
      /^LABEL\s+FINGERPRINT$/.test(header),
      `header should match /^LABEL\\s+FINGERPRINT$/, got ${JSON.stringify(header)}`,
    );
    const labelWidth = 12; // Math.max(5, len("a")=1, len("thelongerone")=12) = 12
    const expectedHeader = "LABEL".padEnd(labelWidth) + "  FINGERPRINT";
    assert(
      header === expectedHeader,
      `header should be exactly ${JSON.stringify(expectedHeader)}, got ${JSON.stringify(header)}`,
    );

    // Find each row and confirm the fingerprint is 8 hex chars.
    const rowA = rows.find((l) => /^a\s/.test(l));
    const rowLong = rows.find((l) => /^thelongerone\s/.test(l));
    assert(rowA !== undefined, `expected a row starting with "a ", got ${JSON.stringify(rows)}`);
    assert(
      rowLong !== undefined,
      `expected a row starting with "thelongerone", got ${JSON.stringify(rows)}`,
    );

    const fpRe = /\s([0-9a-f]{8})$/;
    const mA = rowA.match(fpRe);
    const mLong = rowLong.match(fpRe);
    assert(mA !== null, `row for "a" should end with 8-hex fingerprint: ${JSON.stringify(rowA)}`);
    assert(
      mLong !== null,
      `row for "thelongerone" should end with 8-hex fingerprint: ${JSON.stringify(rowLong)}`,
    );

    // Padding: "a" row is 'a' + (labelWidth-1) spaces + "  " + 8 hex chars.
    const expectedRowA = "a".padEnd(labelWidth) + "  " + mA![1];
    assert(
      rowA === expectedRowA,
      `row for "a" should be padded to label-width ${labelWidth}; expected ${JSON.stringify(expectedRowA)}, got ${JSON.stringify(rowA)}`,
    );
    const expectedRowLong =
      "thelongerone".padEnd(labelWidth) + "  " + mLong![1];
    assert(
      rowLong === expectedRowLong,
      `row for "thelongerone" should be padded to label-width ${labelWidth}; expected ${JSON.stringify(expectedRowLong)}, got ${JSON.stringify(rowLong)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 7. Revoke existing
  // ─────────────────────────────────────────────────────────────────────
  await resetRc(ctx);
  {
    const gen = await ctx.exec(
      ["token", "generate", "--label", "dropme", "--save"],
      { timeoutMs: 15_000 },
    );
    assert(gen.code === 0, `setup: generate --label dropme --save should succeed`);

    const rev = await ctx.exec(["token", "revoke", "dropme"], {
      timeoutMs: 15_000,
    });
    assert(
      rev.code === 0,
      `revoke existing should exit 0, got ${rev.code}; stderr=${rev.stderr}`,
    );
    assert(
      /^Revoked token: dropme\b/m.test(stripAnsi(rev.stdout)),
      `expected "Revoked token: dropme", got ${JSON.stringify(rev.stdout)}`,
    );

    // List should no longer show "dropme".
    const list = await ctx.exec(["token", "list"], { timeoutMs: 15_000 });
    assert(list.code === 0, `post-revoke list should exit 0`);
    const listOut = stripAnsi(list.stdout);
    assert(
      !/\bdropme\b/.test(listOut),
      `list output should not mention "dropme" after revoke, got ${JSON.stringify(listOut)}`,
    );

    // Also assert the RC file no longer has that entry.
    const rc = await readRc(ctx);
    if (rc.present) {
      const tokens = parseTokens(rc.contents);
      assert(
        !tokens.some((t) => t.label === "dropme"),
        `RC should no longer list the "dropme" token, got ${rc.contents}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 8. Revoke missing
  // ─────────────────────────────────────────────────────────────────────
  await resetRc(ctx);
  {
    const r = await ctx.exec(["token", "revoke", "ghost"], {
      timeoutMs: 15_000,
    });
    assert(
      r.code === 1,
      `revoke missing label should exit 1, got ${r.code}; stdout=${r.stdout}; stderr=${r.stderr}`,
    );
    const err = stripAnsi(r.stderr);
    assert(
      /No token found with label: ghost/.test(err),
      `stderr should say "No token found with label: ghost", got ${JSON.stringify(err)}`,
    );
  }

  // Final cleanup — leave a clean RC behind so coverage extraction and any
  // follow-up tests see a pristine state.
  await resetRc(ctx);
});

console.log("token: ok");
