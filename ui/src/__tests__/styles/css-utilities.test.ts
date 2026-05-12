/// <reference types="node" />
/**
 * css-utilities.test.ts — M22 slice 02 / T05
 *
 * Asserts the prototype's code-editor utilities (.editor-line, .ln, .tok-*,
 * .diff-*) ship verbatim from `ui/src/index.css`. The values are normative
 * — Monaco theme overlays in M23 will reference the exact same hex codes,
 * and the slice 03 visual baselines hash them. If somebody tweaks a colour
 * here without coordinating with M23, this test catches it.
 *
 * Why we read the CSS file directly (same reasoning as palette-css-vars.test.ts):
 *   - `vitest.config.ts` sets `css: false`, so jsdom never processes the
 *     `@import "tailwindcss"` directive, and `getComputedStyle` returns
 *     empty strings for these custom utility classes regardless of what
 *     the file declares. Parsing the source is the deterministic check.
 *   - The failure modes worth catching are (a) a class getting renamed or
 *     dropped and (b) a colour value drifting from the prototype palette.
 *     Both surface in the source string.
 *
 * The expected declarations below are copy-pasted from the prototype
 * (docs/prototypes/*.html lines 33–43). If the two diverge, this test is
 * wrong — re-sync.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../..");
const indexCssPath = path.resolve(repoRoot, "src/index.css");
const indexCss = readFileSync(indexCssPath, "utf8");

/** Pull a `selector { … }` block out of the css source. Selector is matched
 *  literally — pass `.tok-kw` not `tok-kw`. */
function extractBlock(css: string, selector: string): string {
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

/** Parse `name: value;` declarations from a block body into a Map. */
function parseDecls(blockBody: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of blockBody.split(";")) {
    const m = decl.match(/^\s*([a-z-]+)\s*:\s*([^;]+?)\s*$/i);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    out.set(m[1].toLowerCase(), m[2].trim());
  }
  return out;
}

describe("M22 slice 02 / T05 — code-editor CSS utilities", () => {
  describe(".editor-line — 56px gutter + 1fr content row", () => {
    const decls = parseDecls(extractBlock(indexCss, "\\.editor-line"));

    it("uses CSS grid", () => {
      expect(decls.get("display")).toBe("grid");
    });
    it("declares a 56px gutter column followed by 1fr content", () => {
      expect(decls.get("grid-template-columns")).toBe("56px 1fr");
    });
    it("pins line-height to 22px", () => {
      expect(decls.get("line-height")).toBe("22px");
    });
  });

  describe(".editor-line:hover — indigo-tinted background", () => {
    const decls = parseDecls(extractBlock(indexCss, "\\.editor-line:hover"));
    it("paints the indigo-500 / 5% wash on hover", () => {
      expect(decls.get("background")).toBe("rgba(99,102,241,.05)");
    });
  });

  describe(".ln — line-number gutter cell", () => {
    const decls = parseDecls(extractBlock(indexCss, "\\.ln"));
    it("colours zinc-500 in light mode", () => {
      expect(decls.get("color")).toBe("rgb(113 113 122)");
    });
    it("right-aligns the digit", () => {
      expect(decls.get("text-align")).toBe("right");
    });
    it("pads 18px to keep the line number off the content edge", () => {
      expect(decls.get("padding-right")).toBe("18px");
    });
    it("disables text selection so copy-paste of the editor area excludes line numbers", () => {
      expect(decls.get("user-select")).toBe("none");
    });
    it("uses 12px so the gutter reads smaller than the content", () => {
      expect(decls.get("font-size")).toBe("12px");
    });
  });

  describe(".dark .ln — dimmed zinc-600 in dark mode", () => {
    const decls = parseDecls(extractBlock(indexCss, "\\.dark \\.ln"));
    it("colours zinc-600", () => {
      expect(decls.get("color")).toBe("rgb(82 82 91)");
    });
  });

  describe(".tok-* — syntax-highlight token colours", () => {
    const cases: Array<{ cls: string; color: string; note: string; extra?: Record<string, string> }> = [
      { cls: "\\.tok-kw", color: "#c084fc", note: "keyword — purple" },
      { cls: "\\.tok-fn", color: "#60a5fa", note: "function name — blue" },
      { cls: "\\.tok-str", color: "#86efac", note: "string literal — green" },
      {
        cls: "\\.tok-com",
        color: "#71717a",
        note: "comment — zinc, italic",
        extra: { "font-style": "italic" },
      },
      { cls: "\\.tok-num", color: "#fbbf24", note: "numeric literal — amber" },
      { cls: "\\.tok-type", color: "#f472b6", note: "type — pink" },
    ];
    for (const c of cases) {
      describe(c.cls.replace(/\\\./, "."), () => {
        const decls = parseDecls(extractBlock(indexCss, c.cls));
        it(`colour = ${c.color} (${c.note})`, () => {
          expect(decls.get("color")).toBe(c.color);
        });
        if (c.extra) {
          for (const [k, v] of Object.entries(c.extra)) {
            it(`${k} = ${v}`, () => {
              expect(decls.get(k)).toBe(v);
            });
          }
        }
      });
    }
  });

  describe(".diff-add — green-tinted added line", () => {
    const decls = parseDecls(extractBlock(indexCss, "\\.diff-add"));
    it("paints a 10% green-500 wash", () => {
      expect(decls.get("background")).toBe("rgba(34,197,94,.10)");
    });
    it("draws a 2px green-500 / 50% left border", () => {
      expect(decls.get("border-left")).toBe("2px solid rgba(34,197,94,.5)");
    });
  });

  describe(".diff-rem — red-tinted removed line", () => {
    const decls = parseDecls(extractBlock(indexCss, "\\.diff-rem"));
    it("paints a 10% red-500 wash", () => {
      expect(decls.get("background")).toBe("rgba(239,68,68,.10)");
    });
    it("draws a 2px red-500 / 50% left border", () => {
      expect(decls.get("border-left")).toBe("2px solid rgba(239,68,68,.5)");
    });
  });

  describe(".diff-add-marker / .diff-rem-marker — gutter markers", () => {
    it(".diff-add-marker is green-500", () => {
      const decls = parseDecls(extractBlock(indexCss, "\\.diff-add-marker"));
      expect(decls.get("color")).toBe("rgb(34 197 94)");
    });
    it(".diff-rem-marker is red-500", () => {
      const decls = parseDecls(extractBlock(indexCss, "\\.diff-rem-marker"));
      expect(decls.get("color")).toBe("rgb(239 68 68)");
    });
  });

  describe("contract — the utilities ship verbatim", () => {
    // The prototype declares a single-line definition for each class. We
    // assert the exact source line is present so a future "tidy-up" that
    // splits the rule across multiple lines (and silently changes a value
    // along the way) gets caught by the structural test as well as the
    // declaration-level tests above.
    const expected = [
      ".editor-line { display: grid; grid-template-columns: 56px 1fr; line-height: 22px; }",
      ".editor-line:hover { background: rgba(99,102,241,.05); }",
      ".ln { color: rgb(113 113 122); text-align: right; padding-right: 18px; user-select: none; font-size: 12px; }",
      ".dark .ln { color: rgb(82 82 91); }",
      ".tok-kw { color: #c084fc; }",
      ".tok-fn { color: #60a5fa; }",
      ".tok-str { color: #86efac; }",
      ".tok-com { color: #71717a; font-style: italic; }",
      ".tok-num { color: #fbbf24; }",
      ".tok-type { color: #f472b6; }",
      ".diff-add { background: rgba(34,197,94,.10); border-left: 2px solid rgba(34,197,94,.5); }",
      ".diff-rem { background: rgba(239,68,68,.10); border-left: 2px solid rgba(239,68,68,.5); }",
      ".diff-add-marker { color: rgb(34 197 94); }",
      ".diff-rem-marker { color: rgb(239 68 68); }",
    ];
    for (const line of expected) {
      it(`index.css contains: ${line}`, () => {
        expect(indexCss).toContain(line);
      });
    }
  });

  /*
   * Table-driven asserter for the project's hand-rolled utility classes
   * that aren't generated by Tailwind and aren't part of the M22 slice 02
   * editor utilities asserted above. Each row names a selector, what it's
   * for, and the regex(es) that must appear inside its rule body. Adding
   * a new utility = adding a row.
   *
   * The selector is matched without regard to which `@layer` the rule
   * lives in — `extractRuleBody` works the same whether the rule sits at
   * the top level or inside `@layer utilities { … }`. The first two
   * entries (`divider-y`, `mono`) seed the table; future utilities should
   * be appended here, not asserted in ad-hoc one-offs.
   */
  describe("custom utilities table — divider-y / mono", () => {
    interface UtilityRow {
      /** Selector class name without the leading dot. */
      selector: string;
      /** Human-readable purpose; surfaces in failure messages. */
      description: string;
      /** Regexes that must each match somewhere inside the rule body. */
      required: { name: string; pattern: RegExp }[];
      /** Optional regexes that must NOT match (guards anti-patterns). */
      forbidden?: { name: string; pattern: RegExp }[];
    }

    /**
     * Pull the body of the first `.<selector> { … }` rule out of `indexCss`.
     * The bodies we care about don't contain nested braces, so a lazy
     * `[^}]*` match is sufficient.
     */
    function extractRuleBody(selector: string): string | null {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\.${escaped}\\s*\\{([^}]*)\\}`);
      const m = indexCss.match(re);
      if (!m || m[1] === undefined) return null;
      return m[1];
    }

    const TABLE: UtilityRow[] = [
      {
        selector: "divider-y",
        description: "auto-themed hairline divider bound to var(--border)",
        required: [
          {
            name: "border-color: var(--border)",
            pattern: /border-color:\s*var\(\s*--border\s*\)/,
          },
        ],
        forbidden: [
          {
            // Catch a regression that hard-codes a hex / rgb / hsl literal
            // instead of going through the token system.
            name: "literal colour value (must use var(--border))",
            pattern: /border-color:\s*(#|rgb|hsl\()/,
          },
        ],
      },
      {
        selector: "mono",
        description: "JetBrains Mono Variable family with ligature reset",
        required: [
          {
            name: "font-family includes 'JetBrains Mono Variable'",
            pattern: /font-family:\s*'JetBrains Mono Variable'/,
          },
          {
            name: "font-variant-ligatures: none",
            pattern: /font-variant-ligatures:\s*none/,
          },
        ],
      },
    ];

    for (const row of TABLE) {
      describe(`.${row.selector} — ${row.description}`, () => {
        it(`is registered as a \`.${row.selector} { … }\` rule in index.css`, () => {
          const body = extractRuleBody(row.selector);
          expect(
            body,
            `index.css must declare \`.${row.selector} { … }\``,
          ).not.toBeNull();
        });

        for (const req of row.required) {
          it(`declares ${req.name}`, () => {
            const body = extractRuleBody(row.selector);
            expect(body).not.toBeNull();
            expect(body!).toMatch(req.pattern);
          });
        }

        if (row.forbidden) {
          for (const forb of row.forbidden) {
            it(`does not contain ${forb.name}`, () => {
              const body = extractRuleBody(row.selector);
              expect(body).not.toBeNull();
              expect(body!).not.toMatch(forb.pattern);
            });
          }
        }
      });
    }
  });
});

/**
 * Activity affordance utilities — `.pulse-dot` (status-dot pulse) and
 * `.agent-glow` (agent-message left-rule walk). These pair with two
 * `@keyframes` rules and a `@media (prefers-reduced-motion: reduce)`
 * opt-out. Same parse-the-file rationale as above (jsdom + `css: false`
 * cannot resolve these via `getComputedStyle`).
 *
 * The failure modes worth catching are:
 *   a) the keyframes get dropped or renamed,
 *   b) somebody collapses `pulse-dot`'s 50% step to opacity-only (drops
 *      the colour-blind-readable transform),
 *   c) somebody swaps `.agent-glow`'s inset box-shadow for an `outline`
 *      (geometrically different — outlines paint outside the box and
 *      break compositing),
 *   d) the `prefers-reduced-motion: reduce` opt-out is stripped (WCAG
 *      2.3.3 regression). The Playwright reduced-motion spec covers the
 *      runtime side; this test guards the source.
 */
describe("activity affordance utilities — .pulse-dot / .agent-glow", () => {
  describe("@keyframes — both rules are defined and shaped correctly", () => {
    it("`@keyframes pulse-dot` is defined", () => {
      expect(indexCss).toMatch(/@keyframes\s+pulse-dot\s*\{/);
    });

    it("`@keyframes glow` is defined", () => {
      expect(indexCss).toMatch(/@keyframes\s+glow\s*\{/);
    });

    it("pulse-dot midpoint combines opacity AND transform (not opacity-only)", () => {
      const body =
        indexCss.match(/@keyframes\s+pulse-dot\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
      expect(body, "@keyframes pulse-dot must have a body").not.toBe("");
      // The brief explicitly forbids an opacity-only animation. The 50%
      // step must declare both `opacity` and `transform: scale(...)`.
      expect(body).toMatch(/50%[^{]*\{[^}]*opacity\s*:/);
      expect(body).toMatch(/50%[^{]*\{[^}]*transform\s*:\s*scale\(/);
    });

    it("glow uses an inset box-shadow (not outline)", () => {
      const body =
        indexCss.match(/@keyframes\s+glow\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
      expect(body, "@keyframes glow must have a body").not.toBe("");
      // The brief explicitly forbids substituting `outline` for the inset
      // shadow — the geometry differs (outline paints outside the box).
      expect(body).toMatch(/box-shadow\s*:\s*inset\b/);
      expect(body).not.toMatch(/\boutline\s*:/);
      // Indigo-500 is the prototype's primary anchor.
      expect(body).toMatch(/rgba\(\s*99\s*,\s*102\s*,\s*241\s*,/);
    });
  });

  describe("class bindings — duration + timing function + iteration", () => {
    it(".pulse-dot animation runs 1.6s ease-in-out infinite", () => {
      const decls = parseDecls(extractBlock(indexCss, "\\.pulse-dot"));
      expect(decls.get("animation")).toBe("pulse-dot 1.6s ease-in-out infinite");
    });

    it(".agent-glow animation runs 2.4s ease-in-out infinite (glow keyframe)", () => {
      const decls = parseDecls(extractBlock(indexCss, "\\.agent-glow"));
      expect(decls.get("animation")).toBe("glow 2.4s ease-in-out infinite");
    });
  });

  describe("@media (prefers-reduced-motion: reduce) — WCAG 2.3.3 opt-out", () => {
    // Slice the media-query body once. The block contains nested rules
    // (`.pulse-dot, .agent-glow { ... }` and `.pulse-dot { ... }`), so
    // greedy-but-balanced matching is the simplest read.
    const reducedMotionBlock =
      indexCss.match(
        /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{([\s\S]*?)\n\}/,
      )?.[1] ?? "";

    it("the reduce media query is present", () => {
      expect(
        reducedMotionBlock,
        "@media (prefers-reduced-motion: reduce) must exist in index.css",
      ).not.toBe("");
    });

    it("disables animation on .pulse-dot AND .agent-glow", () => {
      expect(reducedMotionBlock).toMatch(/\.pulse-dot/);
      expect(reducedMotionBlock).toMatch(/\.agent-glow/);
      expect(reducedMotionBlock).toMatch(/animation\s*:\s*none/);
    });

    it("resets .pulse-dot opacity and transform so it doesn't freeze mid-cycle", () => {
      // Without these resets the dot can halt at 55% opacity / 0.85× scale
      // when the user opts out of motion — visibly broken.
      const pulseDotInsideReduce =
        reducedMotionBlock.match(/\.pulse-dot\s*\{([^}]*)\}/)?.[1] ?? "";
      expect(
        pulseDotInsideReduce,
        ".pulse-dot must have its own block inside the reduce query",
      ).not.toBe("");
      expect(pulseDotInsideReduce).toMatch(/opacity\s*:\s*1\b/);
      expect(pulseDotInsideReduce).toMatch(/transform\s*:\s*none\b/);
    });
  });
});

/**
 * card-hover + tab-active utilities (M22 surface polish).
 *
 * These two utilities are the canonical way to (a) lift a clickable card
 * with an indigo glow on hover, and (b) underline the active tab in a
 * shadcn Tabs strip without shifting tab content. Co-locating the source
 * in `index.css` and the assertions here means any drift between what the
 * file declares and what the prototype calls for fails one of:
 *
 *   - the property-level matchers below (catches missing/wrong values),
 *   - the "no border-b-2" guard (catches the easy "simplification" that
 *     would push tab content up by 2px on activation),
 *   - the `tokens-preview.spec.ts` "utilities" e2e (catches visual drift
 *     once Playwright runs `hover()` on the card and snapshots the lift).
 *
 * Whitespace in the source file is unstable across Prettier passes, so we
 * normalise a block's body with single-space joins before regex-matching
 * against it. The regexes themselves use `\s+` and `\s*` so a Prettier
 * column rewrap doesn't break the test.
 */
function normaliseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

describe(".card-hover utility", () => {
  it("declares a 150ms transition on transform, box-shadow, and border-color", () => {
    const body = normaliseWs(extractBlock(indexCss, "\\.card-hover"));
    // Property ordering is fixed so the failure message is legible if any
    // of the three properties goes missing — the brief lists them in this
    // order and the visual baseline depends on all three transitioning
    // together.
    expect(body).toContain("transition:");
    expect(body).toMatch(/transform\s+\.15s\s+ease/);
    expect(body).toMatch(/box-shadow\s+\.15s\s+ease/);
    expect(body).toMatch(/border-color\s+\.15s\s+ease/);
  });

  it(":hover state lifts -1px, gains indigo border, and indigo glow shadow", () => {
    const body = normaliseWs(extractBlock(indexCss, "\\.card-hover:hover"));
    expect(body).toMatch(/transform:\s*translateY\(-1px\)/);
    // Indigo-500 expressed as space-separated rgb() with /.5 alpha — keep
    // the exact representation greppable so a refactor away from it shows
    // up here, not in a visual diff.
    expect(body).toMatch(
      /border-color:\s*rgb\(\s*99\s+102\s+241\s*\/\s*\.5\s*\)/,
    );
    expect(body).toMatch(
      /box-shadow:\s*0\s+8px\s+24px\s+-8px\s+rgba\(99,\s*102,\s*241,\s*\.25\)/,
    );
  });
});

describe(".tab-active utility", () => {
  it("declares position: relative on the host element", () => {
    const body = normaliseWs(extractBlock(indexCss, "\\.tab-active"));
    expect(body).toMatch(/position:\s*relative/);
  });

  it("draws a 1px underline via ::after pinned to bottom: -1px", () => {
    const body = normaliseWs(extractBlock(indexCss, "\\.tab-active::after"));
    expect(body).toMatch(/content:\s*''/);
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/left:\s*0/);
    expect(body).toMatch(/right:\s*0/);
    // The -1px is the whole point — overlaps the tab strip's bottom
    // border so activation produces zero layout shift. A regression to
    // `bottom: 0` or `bottom: 1px` would ship a 1px content jolt on
    // every tab switch.
    expect(body).toMatch(/bottom:\s*-1px/);
    expect(body).toMatch(/height:\s*1px/);
  });

  it("underline tracks var(--foreground) so it auto-themes", () => {
    const body = normaliseWs(extractBlock(indexCss, "\\.tab-active::after"));
    expect(body).toMatch(/background:\s*var\(--foreground\)/);
  });

  it("does NOT use border-b-2 — the pseudo-element approach is required", () => {
    // Per the slice brief: replacing the underline with `border-b-2` would
    // grow the tab box by 2px on activation. Guard against the easy
    // "simplification" by asserting neither the .tab-active block nor its
    // ::after counterpart references a bottom-border utility.
    const tabActiveBlock = extractBlock(indexCss, "\\.tab-active");
    const tabActiveAfterBlock = extractBlock(indexCss, "\\.tab-active::after");
    expect(tabActiveBlock).not.toMatch(/border-b/);
    expect(tabActiveAfterBlock).not.toMatch(/border-b/);
  });
});

/**
 * `.sparkbar` and `.bar` — chart-strip primitives shared between the
 * project token-usage row, the dev tokens preview, and any future
 * sparkline / column-bar consumer.
 *
 * `.sparkbar` is intentionally `currentColor`-driven: the parent picks
 * the tone via a `text-*` class (e.g. `text-emerald-500` for "healthy",
 * `text-destructive` for "over budget"). Hard-coding a fill here would
 * make every consumer break in lockstep.
 *
 * `.bar` ships the dark-mode gradient as the *default* rule and uses
 * `.light .bar` for the light-mode override — matching the prototype
 * (docs/prototypes/*.html) and the convention the ThemeProvider sets up
 * by toggling `.light` / `.dark` on the document root.
 */
describe("css-utilities — sparkbar and bar chart-strip primitives", () => {
  describe(".sparkbar — inline tick used by sparkline strips", () => {
    const decls = parseDecls(extractBlock(indexCss, "\\.sparkbar"));

    it("is inline-block so it composes inside flowing text", () => {
      expect(decls.get("display")).toBe("inline-block");
    });

    it("is 3px wide with a 1px right gap (matches the prototype tick metrics)", () => {
      expect(decls.get("width")).toBe("3px");
      expect(decls.get("margin-right")).toBe("1px");
    });

    it("uses currentColor so the parent picks the tone — no hard-coded fill", () => {
      expect(decls.get("background")).toBe("currentColor");
    });

    it("paints at 65% opacity", () => {
      // Both `.65` and `0.65` are valid CSS; the prototype writes the short form.
      expect(decls.get("opacity")).toMatch(/^(?:\.65|0\.65)$/);
    });

    it("aligns to the baseline so heights stack from the bottom", () => {
      expect(decls.get("vertical-align")).toBe("bottom");
    });

    it("rounds its corners by 1px", () => {
      expect(decls.get("border-radius")).toBe("1px");
    });

    it("does NOT hard-code a colour fill (regression guard for currentColor)", () => {
      // If anyone adds e.g. `background: #818cf8` the parent's `text-*`
      // class stops controlling tone and every consumer breaks silently.
      // The single `background: currentColor` declaration is the contract.
      const m = indexCss.match(/\.sparkbar\s*\{[^}]*\}/);
      expect(m, "expected exactly one .sparkbar rule").not.toBeNull();
      const body = m![0];
      expect(body).not.toMatch(/background\s*:\s*#[0-9a-f]/i);
      expect(body).not.toMatch(/background\s*:\s*rgb\(/i);
      expect(body).not.toMatch(/background\s*:\s*hsl\(/i);
      expect(body).not.toMatch(/background\s*:\s*linear-gradient/i);
    });
  });

  describe(".bar — column-bar primitive (default = dark mode)", () => {
    const decls = parseDecls(extractBlock(indexCss, "\\.bar"));

    it("ships the dark-mode indigo-400 → indigo-500 gradient by default", () => {
      // #818cf8 = Tailwind indigo-400; #6366f1 = indigo-500. The 180deg
      // direction makes the brighter tone the *top* of the bar.
      const bg = decls.get("background");
      expect(bg).toBeDefined();
      expect(bg).toMatch(/linear-gradient\(\s*180deg/);
      expect(bg).toMatch(/#818cf8\s+0%/);
      expect(bg).toMatch(/#6366f1\s+100%/);
    });

    it("rounds the top corners by 3px and leaves the bottom flat", () => {
      // `3px 3px 0 0` — top-left, top-right, bottom-right, bottom-left.
      expect(decls.get("border-radius")).toBe("3px 3px 0 0");
    });

    it("is NOT re-declared under :root (the .light override depends on default specificity)", () => {
      // The prototype intentionally uses `.bar` as the default and
      // `.light .bar` as the override. If somebody re-declares `.bar`
      // inside the `:root { … }` block, `:root .bar` wins specificity
      // over `.light .bar` and the override stops cascading.
      expect(indexCss).not.toMatch(/:root[^}]*\.bar\s*\{/);
    });
  });

  describe(".light .bar — light-mode override", () => {
    const decls = parseDecls(extractBlock(indexCss, "\\.light\\s+\\.bar"));

    it("overrides the gradient to indigo-500 → indigo-600 in light mode", () => {
      // #6366f1 = indigo-500; #4f46e5 = indigo-600. Slightly deeper than
      // the dark-mode default so the bars retain visual weight on the
      // light zinc-50 surface.
      const bg = decls.get("background");
      expect(bg).toBeDefined();
      expect(bg).toMatch(/linear-gradient\(\s*180deg/);
      expect(bg).toMatch(/#6366f1\s+0%/);
      expect(bg).toMatch(/#4f46e5\s+100%/);
    });

    it("is keyed off a parent .light class (matches ThemeProvider)", () => {
      // ThemeProvider toggles `.light` / `.dark` on the document root.
      // The `.light .bar` selector picks up the override transparently
      // — no per-component handling needed.
      expect(indexCss).toMatch(/\.light\s+\.bar\s*\{/);
    });
  });
});

/**
 * Orphan + missing utility checker (CI guard).
 *
 * Two failure modes drift in over time as the prototype evolves:
 *
 *   1. **Orphan utilities** — a class is declared inside `@layer utilities`
 *      in `index.css` but no source file references it. Either the
 *      consumer was deleted/refactored and the rule should follow, or the
 *      rule was added speculatively and never wired in. Either way it's
 *      noise in the bundle and a maintenance liability.
 *
 *   2. **Missing utilities** — a source file uses a class name that *looks*
 *      like one of our prototype utilities (e.g. `tok-kw`, `editor-line`,
 *      `pulse-dot`) but the rule isn't actually defined. Tailwind v4
 *      silently drops the class, the surface renders unstyled, and there
 *      is no compile-time signal anywhere.
 *
 * The check is layer-scoped: we extract every selector inside
 * `@layer utilities { … }` blocks and treat that as the canonical defined
 * set. This is why the contributor guidance says "do NOT add custom
 * utilities outside `@layer utilities`" — the checker depends on the
 * scope to distinguish utilities from chat-markdown / prose / overrides.
 *
 * The "missing" regex is deliberately narrow: it matches only the
 * prototype-utility name shapes (`tok-*`, `diff-*`, plus a fixed list).
 * Tailwind purges the rest at build time; widening the regex to all class
 * tokens would re-implement Tailwind's purge with worse ergonomics.
 */

/** Brace-balanced extraction of every `@layer utilities { … }` body in the
 *  CSS source. Brace depth matters because each utilities body contains
 *  nested rule blocks (`.editor-line { … }`). A naive `[^}]*` regex would
 *  terminate at the first inner `}`. */
function extractLayerUtilitiesBodies(css: string): string[] {
  const bodies: string[] = [];
  const re = /@layer\s+utilities\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      const c = css[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    if (depth === 0) bodies.push(css.slice(start, i - 1));
    re.lastIndex = i;
  }
  return bodies;
}

/** Collect class names defined as plain `.<name> { … }` rules within a
 *  utilities-layer body. Skip @keyframes blocks (defensively — they should
 *  never live inside @layer utilities, but the brief asks for the guard).
 *
 *  The class-name regex requires the next non-whitespace character after
 *  the captured name to be `{`. That excludes pseudo / state / combinator
 *  variants like `.editor-line:hover`, `.tab-active::after`, `.dark .ln`
 *  — those are overrides on existing utilities, not new utility names. */
function extractDefinedUtilities(layerBody: string): Set<string> {
  // Strip @keyframes blocks if any are present in the layer body.
  let stripped = layerBody;
  for (let pass = 0; pass < 8; pass++) {
    const next = stripped.replace(/@keyframes\s+[\w-]+\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "");
    if (next === stripped) break;
    stripped = next;
  }
  const out = new Set<string>();
  const ruleRe = /\.([a-zA-Z_][\w-]*)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(stripped)) !== null) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  return out;
}

/** Recursively walk `root` and yield .ts / .tsx files under it, skipping
 *  any `__tests__` directory and the shadcn-managed `components/ui/`
 *  directory (the latter contains generated primitives whose class names
 *  intentionally overlap with Tailwind core utilities — including those
 *  isn't useful for this checker). */
function walkSourceFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        const rel = path.relative(root, full);
        if (rel === path.join("components", "ui")) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === ".ts" || ext === ".tsx") out.push(full);
      }
    }
  }
  return out;
}

/** Extract whitespace-separated identifier tokens from every string
 *  literal in a source file. Over-broad on purpose — we only use the
 *  result for membership checks against a narrow set of utility names,
 *  so false positives outside that set are fine and false negatives
 *  (the failure mode that matters) are what we guard against.
 *
 *  We strip `/* … *\/` block comments first because JSDoc / JSX comments
 *  routinely contain unbalanced apostrophes ("don't", "doesn't") that
 *  would otherwise open a synthetic string literal in the regex pass and
 *  swallow real `className="…"` strings until the next stray quote. The
 *  strip is only applied to a working copy — the source file is
 *  untouched. */
function extractClassTokens(src: string): Set<string> {
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Set<string>();
  const stringLitRe = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs;
  for (const m of stripped.matchAll(stringLitRe)) {
    const content = m[2];
    if (!content) continue;
    for (const tok of content.split(/\s+/)) {
      if (tok && /^[a-zA-Z_][\w-]*$/.test(tok)) tokens.add(tok);
    }
  }
  return tokens;
}

const PROTOTYPE_UTILITY_RE =
  /^(?:divider-y|mono|pulse-dot|agent-glow|sparkbar|bar|card-hover|tab-active|editor-line|ln|tok-(?:kw|fn|str|com|num|type)|diff-(?:add|rem|add-marker|rem-marker))$/;

describe("css-utilities — orphan + missing checker (CI guard)", () => {
  const layerBodies = extractLayerUtilitiesBodies(indexCss);
  const definedUtilities = new Set<string>();
  for (const body of layerBodies) {
    for (const name of extractDefinedUtilities(body)) {
      definedUtilities.add(name);
    }
  }

  const srcRoot = path.resolve(repoRoot, "src");
  const sourceFiles = walkSourceFiles(srcRoot);
  const tokensByFile = new Map<string, Set<string>>();
  const allSourceTokens = new Set<string>();
  for (const f of sourceFiles) {
    const text = readFileSync(f, "utf8");
    const toks = extractClassTokens(text);
    tokensByFile.set(f, toks);
    for (const t of toks) allSourceTokens.add(t);
  }

  it("sanity: index.css declares at least one @layer utilities block with utilities inside", () => {
    expect(layerBodies.length).toBeGreaterThan(0);
    expect(definedUtilities.size).toBeGreaterThan(0);
  });

  it("sanity: source-file walk found ts/tsx files outside __tests__ and components/ui/", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
    expect(allSourceTokens.size).toBeGreaterThan(0);
  });

  it("Orphan check: every selector defined in our @layer utilities block in index.css is referenced in at least one ui/src/**/*.{ts,tsx,css} file.", () => {
    const orphans: string[] = [];
    for (const name of definedUtilities) {
      if (!allSourceTokens.has(name)) orphans.push(name);
    }
    orphans.sort();
    expect(
      orphans,
      `Defined utilities not referenced by any ui/src/**/*.{ts,tsx} source file:\n${orphans
        .map((n) => `  .${n}`)
        .join("\n")}\n\nEither wire the utility into a consumer or drop the rule from index.css.`,
    ).toEqual([]);
  });

  it("Missing check: every class name matching the prototype-utility regex used in source resolves to a defined rule.", () => {
    const missing: { file: string; token: string }[] = [];
    for (const [f, tokens] of tokensByFile) {
      for (const tok of tokens) {
        if (PROTOTYPE_UTILITY_RE.test(tok) && !definedUtilities.has(tok)) {
          missing.push({ file: path.relative(repoRoot, f), token: tok });
        }
      }
    }
    expect(
      missing,
      `Source files reference prototype utility classes that are NOT defined inside @layer utilities in index.css:\n${missing
        .map((o) => `  ${o.file}: .${o.token}`)
        .join("\n")}\n\nDefine the rule under @layer utilities in ui/src/index.css.`,
    ).toEqual([]);
  });
});
