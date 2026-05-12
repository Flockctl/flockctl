/// <reference types="node" />
/**
 * fonts.test.ts — M22 typography slice
 *
 * Asserts that the variable-font packages we depend on for the body
 * (`@fontsource-variable/inter`) and the mono utility
 * (`@fontsource-variable/jetbrains-mono`) are vendored on disk and
 * declare the expected `font-family` names. Together with the body
 * rule in `index.css` (`'Inter Variable', Inter, system-ui, …`) and
 * the `.mono` utility (`'JetBrains Mono Variable', …`), this is what
 * resolves at runtime.
 *
 * Why we read the package CSS instead of `document.fonts`:
 *
 *   - `vitest.config.ts` sets `css: false`, so jsdom never processes
 *     `@import` statements. `document.fonts` would be empty regardless
 *     of whether the packages are installed.
 *   - The real failure modes we want to catch are (a) package missing
 *     from `node_modules` and (b) the family name in the package CSS
 *     drifting away from what `index.css` references. Reading the
 *     vendored CSS catches both.
 *
 * The companion test `no-google-fonts-fetches.test.ts` guards against
 * a regression to a CDN-loaded font.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../..");

function readFontCss(pkg: string): string {
  const file = path.resolve(repoRoot, "node_modules", pkg, "index.css");
  expect(existsSync(file), `${pkg} must be installed at ${file}`).toBe(true);
  return readFileSync(file, "utf8");
}

describe("M22 typography — variable font packages", () => {
  it("@fontsource-variable/inter is vendored and declares 'Inter Variable'", () => {
    const css = readFontCss("@fontsource-variable/inter");
    expect(css).toMatch(/font-family:\s*'Inter Variable'/);
    // Sanity: the @font-face must reference local woff2 files (no CDN url).
    expect(css).toMatch(/url\(\.\/files\/[^)]+\.woff2\)/);
    expect(css).not.toMatch(/https?:\/\//);
  });

  it("@fontsource-variable/jetbrains-mono is vendored and declares 'JetBrains Mono Variable'", () => {
    const css = readFontCss("@fontsource-variable/jetbrains-mono");
    expect(css).toMatch(/font-family:\s*'JetBrains Mono Variable'/);
    expect(css).toMatch(/url\(\.\/files\/[^)]+\.woff2\)/);
    expect(css).not.toMatch(/https?:\/\//);
  });

  it("ui/src/index.css imports both new fonts and binds the body to 'Inter Variable'", () => {
    const indexCss = readFileSync(
      path.resolve(repoRoot, "src/index.css"),
      "utf8",
    );
    expect(indexCss).toMatch(/@import\s+"@fontsource-variable\/inter"/);
    expect(indexCss).toMatch(
      /@import\s+"@fontsource-variable\/jetbrains-mono"/,
    );
    // Body rule names Inter Variable as the primary family.
    expect(indexCss).toMatch(/font-family:\s*'Inter Variable'/);
    // .mono utility names JetBrains Mono Variable as the primary family.
    expect(indexCss).toMatch(/font-family:\s*'JetBrains Mono Variable'/);
  });
});
