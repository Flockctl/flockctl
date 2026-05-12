import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CI guard against re-introduction of the retired `flockctl.ui.next`
 * feature flag and its companion `useUiFlag` hook.
 *
 * Background
 * ----------
 * `flockctl.ui.next` was the M21 localStorage feature flag that gated
 * the new shell rollout, and `useUiFlag` was the React hook that read
 * it. Both were retired when the new shell became the unconditional
 * chrome — keeping them around invites a "let me just check the flag
 * one more time" branch creeping back into the codebase, which would
 * resurrect a forking UI and the bugs that come with it.
 *
 * Why a Vitest test (not just an ESLint rule)?
 * --------------------------------------------
 * Same logic as the M22 slice-02 sibling guard
 * (`no-shadcn-card-on-page.test.ts`):
 *
 *   1. ESLint flat-config can be edited unrelated; a dedicated, named
 *      test fails loudly the moment the invariant is broken.
 *   2. The string check catches both the import (`useUiFlag`) and the
 *      raw storage key (`"flockctl.ui.next"`), which an
 *      `import/no-restricted-paths`-style ESLint rule cannot easily do
 *      together.
 *
 * What it does
 * ------------
 * Walks every `.ts` / `.tsx` file under `ui/src/` (skipping the
 * `__tests__/` subtree) and asserts no file mentions `useUiFlag` or
 * `flockctl.ui.next` — *except* the small
 * allowlist below, which captures the one-shot localStorage cleanup
 * migration that legitimately needs to read the legacy key by name to
 * remove it.
 *
 * The allowlist is meant to **shrink monotonically**. When the cleanup
 * branch in `main.tsx` is removed (after enough time has passed that
 * stale localStorage entries are negligible), drop the entry here too.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// `ui/src/__tests__/lint/` → up three to reach `ui/`.
const UI_ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC_ROOT = path.join(UI_ROOT, "src");

/**
 * Files that are permitted to mention the retired flag strings because
 * they implement the cleanup-migration that removes residual state on
 * machines that flipped the flag during the M21 rollout.
 *
 * Paths are relative to `ui/src/` and use POSIX separators.
 */
const LEGACY_ALLOWLIST: ReadonlySet<string> = new Set([
  // One-shot localStorage cleanup migration — see the comment in
  // `main.tsx` immediately above the `localStorage.removeItem(...)`
  // call. Dropping this entry is fine *only* once the cleanup branch
  // itself is removed.
  "main.tsx",
]);

/**
 * Banned strings. Either substring in a file is enough to flag it.
 *
 * - `useUiFlag` — the retired hook name. Matching as a bare substring
 *   intentionally catches imports, calls, and re-exports together.
 * - `flockctl.ui.next` — the retired localStorage key. Matching the
 *   raw string catches both `localStorage.getItem("flockctl.ui.next")`
 *   and any constant that holds the literal.
 */
const BANNED_PATTERNS: ReadonlyArray<{ name: string; needle: string }> = [
  { name: "useUiFlag", needle: "useUiFlag" },
  { name: "flockctl.ui.next", needle: "flockctl.ui.next" },
];

async function* walkSource(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip the test tree — tests legitimately reference the retired
    // names to assert they stay gone (this very file is one such test).
    if (entry.isDirectory() && entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSource(full);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      yield full;
    }
  }
}

function relPosix(absPath: string): string {
  return path.relative(SRC_ROOT, absPath).split(path.sep).join("/");
}

describe("no retired ui-feature-flag references", () => {
  it("no src/**/*.{ts,tsx} file (excluding __tests__) mentions useUiFlag or flockctl.ui.next", async () => {
    const offenders: Array<{ file: string; pattern: string }> = [];

    for await (const file of walkSource(SRC_ROOT)) {
      const rel = relPosix(file);
      if (LEGACY_ALLOWLIST.has(rel)) continue;

      const source = await fs.readFile(file, "utf8");
      for (const { name, needle } of BANNED_PATTERNS) {
        if (source.includes(needle)) {
          offenders.push({ file: rel, pattern: name });
        }
      }
    }

    expect(
      offenders,
      `\nThe following files re-introduced retired UI feature-flag references:\n` +
        offenders.map((o) => `  - src/${o.file}  →  ${o.pattern}`).join("\n") +
        `\n\nThe \`flockctl.ui.next\` localStorage flag and the \`useUiFlag\` ` +
        `hook were retired when the new shell became unconditional. Re-adding ` +
        `either resurrects a forking UI surface. If you genuinely need the ` +
        `cleanup-migration exception, add the path to LEGACY_ALLOWLIST in ` +
        `src/__tests__/lint/no-feature-flag-imports.test.ts — but the better ` +
        `answer is almost always to delete the offending reference.\n`,
    ).toEqual([]);
  });

  it("LEGACY_ALLOWLIST does not contain entries that no longer reference the retired strings (allowlist shrinks monotonically)", async () => {
    const stale: string[] = [];

    for (const rel of LEGACY_ALLOWLIST) {
      const full = path.join(SRC_ROOT, rel);
      let source: string;
      try {
        source = await fs.readFile(full, "utf8");
      } catch {
        // File deleted entirely → entry is stale.
        stale.push(rel);
        continue;
      }
      const stillReferences = BANNED_PATTERNS.some(({ needle }) =>
        source.includes(needle),
      );
      if (!stillReferences) {
        stale.push(rel);
      }
    }

    expect(
      stale,
      `\nThe following entries in LEGACY_ALLOWLIST no longer mention any ` +
        `retired flag string (or no longer exist) — please remove them from ` +
        `the allowlist in src/__tests__/lint/no-feature-flag-imports.test.ts:\n` +
        stale.map((p) => `  - ${p}`).join("\n") +
        `\n`,
    ).toEqual([]);
  });
});
