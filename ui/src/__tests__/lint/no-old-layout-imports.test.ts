import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CI guard against re-introduction of `OldLayout` and `ShellSwitch`.
 *
 * Background
 * ----------
 * `OldLayout` and `ShellSwitch` were the legacy chrome and the
 * conditional layout-picker that selected between old and new shells
 * during the new-shell rollout. Both were retired when the new shell
 * became the unconditional chrome. Keeping any reference to either
 * symbol invites a "let me just check the flag one more time" branch
 * creeping back in, which would resurrect a forking UI surface and the
 * bugs that come with it.
 *
 * What it does
 * ------------
 * Walks every `.ts` / `.tsx` file under `ui/src/` (skipping the
 * `__tests__/` subtree, including this very file) and asserts no file
 * mentions the strings `OldLayout` or `ShellSwitch`.
 *
 * Why a Vitest test (not just an ESLint rule)?
 * --------------------------------------------
 * Same logic as the sibling `no-feature-flag-imports.test.ts` and
 * `no-shadcn-card-on-page.test.ts`:
 *
 *   1. ESLint flat-config can be edited unrelated; a dedicated, named
 *      test fails loudly the moment the invariant is broken.
 *   2. The string check catches imports, type references, and string
 *      literals together, which an `import/no-restricted-paths`-style
 *      ESLint rule cannot easily do.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// `ui/src/__tests__/lint/` → up three to reach `ui/`.
const UI_ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC_ROOT = path.join(UI_ROOT, "src");

/**
 * Banned strings. Either substring in a file is enough to flag it.
 *
 * - `OldLayout` — the retired legacy chrome component name.
 * - `ShellSwitch` — the retired conditional shell picker.
 */
const BANNED_PATTERNS: ReadonlyArray<{ name: string; needle: string }> = [
  { name: "OldLayout", needle: "OldLayout" },
  { name: "ShellSwitch", needle: "ShellSwitch" },
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

describe("no OldLayout / ShellSwitch references", () => {
  it("no src/**/*.{ts,tsx} file (excluding __tests__) mentions OldLayout or ShellSwitch", async () => {
    const offenders: Array<{ file: string; pattern: string }> = [];

    for await (const file of walkSource(SRC_ROOT)) {
      const rel = relPosix(file);
      const source = await fs.readFile(file, "utf8");
      for (const { name, needle } of BANNED_PATTERNS) {
        if (source.includes(needle)) {
          offenders.push({ file: rel, pattern: name });
        }
      }
    }

    expect(
      offenders,
      `\nThe following files re-introduced retired layout/shell references:\n` +
        offenders.map((o) => `  - src/${o.file}  →  ${o.pattern}`).join("\n") +
        `\n\nThe \`OldLayout\` legacy chrome and the \`ShellSwitch\` ` +
        `conditional layout picker were retired when the new shell ` +
        `became unconditional. Re-adding either resurrects a forking UI ` +
        `surface. The fix is almost always to delete the offending ` +
        `reference, not to expand this guard.\n`,
    ).toEqual([]);
  });
});
