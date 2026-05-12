/// <reference types="node" />
/**
 * palette-css-vars.test.ts — M22 slice 00 / T02
 *
 * Asserts every shadcn semantic variable defined in `ui/src/index.css`
 * resolves to the prototype zinc/indigo value documented in the slice's
 * normative mapping table.
 *
 * Why we read the CSS file directly instead of mounting `<div className="bg-x" />`
 * and reading `getComputedStyle`:
 *
 *   - `vitest.config.ts` sets `css: false`, so jsdom never processes the
 *     `@import "tailwindcss"` directive at the top of `index.css`. Without
 *     the Tailwind utility layer, `bg-card` (etc.) doesn't generate a rule,
 *     and `getComputedStyle(div).backgroundColor` returns `""` regardless
 *     of which palette the file declares.
 *   - The real failure modes we want to catch are (a) a variable getting
 *     dropped, renamed, or pointed at the wrong palette anchor and (b) the
 *     light/dark blocks drifting out of sync with the slice spec. Parsing
 *     the file catches both deterministically.
 *
 * The mapping table below is copy-pasted from the comment block in
 * `ui/src/index.css`. If the two diverge, this test is wrong — re-sync.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../..");
const indexCssPath = path.resolve(repoRoot, "src/index.css");
const indexCss = readFileSync(indexCssPath, "utf8");

/** Pull a `selector { … }` block out of the css source. */
function extractBlock(css: string, selector: string): string {
  // Match the first `selector` followed by an optional gap then the next `{ … }`.
  // The body is balanced-brace-free for our blocks (no nested `{}`).
  const re = new RegExp(
    `(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "m",
  );
  const m = css.match(re);
  if (!m || m[1] === undefined) {
    throw new Error(`block "${selector}" not found in index.css`);
  }
  return m[1];
}

/** Parse `--name: value;` declarations from a block body into a Map. */
function parseVars(blockBody: string): Map<string, string> {
  const out = new Map<string, string>();
  // Split on `;` and pull `--name: value` pairs.
  for (const decl of blockBody.split(";")) {
    const m = decl.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+?)\s*$/i);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    out.set(m[1], m[2].trim());
  }
  return out;
}

const lightVars = parseVars(extractBlock(indexCss, ":root"));
const darkVars = parseVars(extractBlock(indexCss, "\\.dark"));

/**
 * Normative mapping table — light + dark expected values for every variable
 * the slice's T02 mapping table covers. Derived rows ("matches X") resolve
 * to their anchor's value.
 */
const HSL_INDIGO_500 = "hsl(239 84% 60%)";
const HSL_RED_500 = "hsl(0 84% 60%)";
const HSL_WHITE = "hsl(0 0% 100%)";
const HSL_ZINC_50 = "hsl(0 0% 98%)";
const HSL_ZINC_100_FG = "hsl(0 0% 95%)"; // foreground anchor (dark mode text)
const HSL_ZINC_100_SURF = "hsl(240 5% 96%)"; // surface anchor (light secondary/muted/accent)
const HSL_ZINC_200 = "hsl(240 6% 90%)";
const HSL_ZINC_400 = "hsl(240 5% 65%)";
const HSL_ZINC_500 = "hsl(240 4% 46%)";
const HSL_ZINC_800 = "hsl(240 4% 16%)";
const HSL_ZINC_900_TEXT = "hsl(240 6% 10%)"; // foreground anchor (light mode text)
const HSL_ZINC_900_SURF = "hsl(240 6% 11%)"; // surface anchor (dark card/sidebar)
const HSL_ZINC_950 = "hsl(240 10% 4%)";

interface Row {
  variable: string;
  light: string;
  dark: string;
  /** Human-readable note kept alongside the row to make failure messages legible. */
  note: string;
}

const TABLE: Row[] = [
  { variable: "--background", light: HSL_ZINC_50, dark: HSL_ZINC_950, note: "body surface" },
  { variable: "--foreground", light: HSL_ZINC_900_TEXT, dark: HSL_ZINC_100_FG, note: "body text" },
  { variable: "--card", light: HSL_WHITE, dark: HSL_ZINC_900_SURF, note: "card surface" },
  { variable: "--card-foreground", light: HSL_ZINC_900_TEXT, dark: HSL_ZINC_100_FG, note: "matches foreground" },
  { variable: "--popover", light: HSL_WHITE, dark: HSL_ZINC_900_SURF, note: "matches card" },
  { variable: "--popover-foreground", light: HSL_ZINC_900_TEXT, dark: HSL_ZINC_100_FG, note: "matches foreground" },
  { variable: "--primary", light: HSL_INDIGO_500, dark: HSL_INDIGO_500, note: "primary accent" },
  { variable: "--primary-foreground", light: HSL_WHITE, dark: HSL_WHITE, note: "white on indigo" },
  { variable: "--secondary", light: HSL_ZINC_100_SURF, dark: HSL_ZINC_800, note: "secondary surface" },
  { variable: "--secondary-foreground", light: HSL_ZINC_900_TEXT, dark: HSL_ZINC_100_FG, note: "matches foreground" },
  { variable: "--muted", light: HSL_ZINC_100_SURF, dark: HSL_ZINC_800, note: "muted surface (skeleton pulse)" },
  { variable: "--muted-foreground", light: HSL_ZINC_500, dark: HSL_ZINC_400, note: "muted text" },
  { variable: "--accent", light: HSL_ZINC_100_SURF, dark: HSL_ZINC_800, note: "accent surface" },
  { variable: "--accent-foreground", light: HSL_ZINC_900_TEXT, dark: HSL_ZINC_100_FG, note: "matches foreground" },
  { variable: "--destructive", light: HSL_RED_500, dark: HSL_RED_500, note: "danger" },
  { variable: "--border", light: HSL_ZINC_200, dark: HSL_ZINC_800, note: "hairlines" },
  { variable: "--input", light: HSL_ZINC_200, dark: HSL_ZINC_800, note: "matches border" },
  { variable: "--ring", light: HSL_INDIGO_500, dark: HSL_INDIGO_500, note: "matches primary (focus)" },
  { variable: "--sidebar", light: HSL_WHITE, dark: HSL_ZINC_900_SURF, note: "sidebar bg" },
  { variable: "--sidebar-foreground", light: HSL_ZINC_900_TEXT, dark: HSL_ZINC_100_FG, note: "matches foreground" },
];

describe("M22 slice 00 / T02 — palette CSS variables", () => {
  describe(":root (light) — every variable resolves to the prototype value", () => {
    for (const row of TABLE) {
      it(`${row.variable} = ${row.light} (${row.note})`, () => {
        expect(
          lightVars.get(row.variable),
          `:root must declare ${row.variable}`,
        ).toBeDefined();
        expect(lightVars.get(row.variable)).toBe(row.light);
      });
    }
  });

  describe(".dark — every variable resolves to the prototype value", () => {
    for (const row of TABLE) {
      it(`${row.variable} = ${row.dark} (${row.note})`, () => {
        expect(
          darkVars.get(row.variable),
          `.dark must declare ${row.variable}`,
        ).toBeDefined();
        expect(darkVars.get(row.variable)).toBe(row.dark);
      });
    }
  });

  describe("variable names — must not be renamed by this slice", () => {
    it("every variable referenced by @theme inline is still defined in :root", () => {
      // Sample the critical aliases. The @theme block aliases bg-card →
      // var(--card), so if --card disappeared, every shadcn primitive would
      // break silently. This guard catches accidental renames before the
      // visual tests in T03 do.
      const required = TABLE.map((r) => r.variable);
      for (const v of required) {
        expect(
          lightVars.has(v),
          `:root must still declare ${v} (no renames allowed in T02)`,
        ).toBe(true);
        expect(
          darkVars.has(v),
          `.dark must still declare ${v} (no renames allowed in T02)`,
        ).toBe(true);
      }
    });
  });

  describe("skeleton pulse contrast — --muted must differ from --card in both modes", () => {
    // Edge case from the slice: `<Skeleton>` uses --muted and sits on --card.
    // If --muted ever equals --card the skeleton becomes invisible.
    it("light: --muted ≠ --card", () => {
      expect(lightVars.get("--muted")).not.toBe(lightVars.get("--card"));
    });
    it("dark: --muted ≠ --card", () => {
      expect(darkVars.get("--muted")).not.toBe(darkVars.get("--card"));
    });
  });

  describe("focus ring — --ring must equal --primary in both modes", () => {
    // T03 axe scan asserts the ring is visibly indigo; this is the
    // structural pre-condition.
    it("light: --ring === --primary", () => {
      expect(lightVars.get("--ring")).toBe(lightVars.get("--primary"));
    });
    it("dark: --ring === --primary", () => {
      expect(darkVars.get("--ring")).toBe(darkVars.get("--primary"));
    });
  });

  describe("comment block — mapping table is preserved above the variables", () => {
    // Future readers should be able to grep for the table without diving
    // into the slice doc. If somebody strips the comment we want to know.
    it("index.css contains the normative mapping comment", () => {
      expect(indexCss).toMatch(/Normative mapping table/);
      expect(indexCss).toMatch(/zinc-950/);
      expect(indexCss).toMatch(/indigo/);
    });
  });
});
