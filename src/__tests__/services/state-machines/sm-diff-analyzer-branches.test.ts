/**
 * Branch-coverage tests for `src/services/state-machines/sm-diff-analyzer.ts`.
 *
 * Targets uncovered branches:
 *  - parseMermaidBlock: `[*] --> [*]` noise, final-marker only, arrow with
 *    events present/absent.
 *  - extractEntityName: frontmatter entity-line, HTML comment, H1 heading,
 *    filename fallback.
 *  - parseDiffAddedLines: `rename`, `similarity`, `/dev/null`, hunk without
 *    leading +/- (context line), trailing "\ No newline" tokens.
 *  - detectTransitionsInLines: `opts.entity` mismatch skip, ignore-marker
 *    on preceding line, event-call against registry with known+unknown
 *    events, entity scoping in event-call branch, object literal with event
 *    field present.
 *  - suggestEdit / formatViolations: event-call message paths, multi-event
 *    registered list, event-call with no registry, candidates with multiple
 *    entries (entity="*" aggregate).
 *  - globToRegExp: `?` wildcard, special-char escaping, trailing `/`.
 *  - filterLinesByGlob: glob="" / undefined passthrough.
 *  - runCheck: `opts.diffText` branch (bypass execSync), empty diff.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseMermaidBlock,
  parseRegistryMarkdown,
  parseDiffAddedLines,
  detectTransitionsInLines,
  checkAgainstRegistry,
  globToRegExp,
  filterLinesByGlob,
  loadRegistry,
  runCheck,
  formatViolations,
  type DetectedTransition,
  type RegistryEntry,
} from "../../../services/state-machines/sm-diff-analyzer.js";

let tmpBase: string;
let counter = 0;

beforeAll(() => {
  tmpBase = join(tmpdir(), `flockctl-sm-diff-branches-${process.pid}`);
  mkdirSync(tmpBase, { recursive: true });
});

afterAll(() => {
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

beforeEach(() => { counter++; });

function makeProject(): string {
  const dir = join(tmpBase, `p-${counter}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("parseMermaidBlock — uncovered edges", () => {
  it("skips `[*] --> [*]` noise and honours `A --> [*]` final markers", () => {
    const text = `
      [*] --> [*]
      A --> B : fire
      B --> [*]
    `;
    const out = parseMermaidBlock(text);
    expect(out.transitions).toEqual([{ from: "A", to: "B", event: "fire" }]);
    // `B` ends up in states set via final-marker branch.
    expect(out.states).toContain("B");
    expect(out.states).toContain("A");
  });

  it("strips `%%` comments and ignores unknown directives", () => {
    const text = `
      stateDiagram-v2
      direction LR  %% trailing mermaid comment
      classDef active fill:#fa0
      %% leading comment line
      A --> B
    `;
    const out = parseMermaidBlock(text);
    expect(out.transitions).toEqual([{ from: "A", to: "B" }]);
  });
});

describe("parseRegistryMarkdown — entity name sources", () => {
  it("prefers frontmatter entity over H1 heading", () => {
    const md = `---
entity: "order"
---

# Thing

\`\`\`mermaid
stateDiagram-v2
[*] --> draft
draft --> paid
\`\`\`
`;
    const entry = parseRegistryMarkdown(md, "/tmp/other.md")!;
    expect(entry.entity).toBe("order");
    expect(entry.initial).toBe("draft");
  });

  it("falls back to HTML comment when no frontmatter", () => {
    const md = `<!-- entity: invoice -->

\`\`\`mermaid
stateDiagram-v2
A --> B
\`\`\`
`;
    expect(parseRegistryMarkdown(md, "/x/y.md")!.entity).toBe("invoice");
  });

  it("falls back to first H1 heading", () => {
    const md = `# Shipment Things

\`\`\`mermaid
stateDiagram-v2
A --> B
\`\`\`
`;
    expect(parseRegistryMarkdown(md, "/x/y.md")!.entity).toBe("shipment");
  });

  it("falls back to filename when nothing else present", () => {
    const md = `\`\`\`mermaid
stateDiagram-v2
A --> B
\`\`\`
`;
    expect(parseRegistryMarkdown(md, "/x/widget.md")!.entity).toBe("widget");
  });

  it("returns null when there are no mermaid blocks", () => {
    expect(parseRegistryMarkdown("# only text", "/x/y.md")).toBeNull();
  });

  it("returns null when mermaid blocks contain no transitions and no states", () => {
    const md = `\`\`\`mermaid
stateDiagram-v2
%% empty
\`\`\`
`;
    expect(parseRegistryMarkdown(md, "/x/y.md")).toBeNull();
  });
});

describe("parseDiffAddedLines — uncovered branches", () => {
  it("handles rename/similarity headers and /dev/null (file added)", () => {
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 70%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-removed",
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+first",
      "+second",
    ].join("\n");
    const out = parseDiffAddedLines(diff);
    // Only b/new.ts lines, not /dev/null
    expect(out.map((l) => l.content)).toEqual(["first", "second"]);
    expect(out[0]!.file).toBe("new.ts");
  });

  it("advances newLineNo across context lines and trailing `\\ No newline` markers", () => {
    const diff = [
      "+++ b/a.ts",
      "@@ -1,3 +1,4 @@",
      " ctx-line", // context: advance
      "+added", // line 2
      "-removed",
      " another-ctx",
      "+last", // line 4
      "\\ No newline at end of file",
    ].join("\n");
    const out = parseDiffAddedLines(diff);
    expect(out).toEqual([
      { file: "a.ts", line: 2, content: "added" },
      { file: "a.ts", line: 4, content: "last" },
    ]);
  });

  it("ignores added lines when no file header has been seen yet", () => {
    const diff = ["+orphan"].join("\n");
    expect(parseDiffAddedLines(diff)).toEqual([]);
  });

  it("clears currentFile to null when `+++ ` header fails the strict regex", () => {
    // A `+++ ` line with no path at all — startsWith matches, but the regex
    // requires at least one captured character so `m` is null and the
    // `m?.[1] ?? null` RHS is taken.
    const diff = [
      "+++ b/valid.ts",
      "@@ -0,0 +1,1 @@",
      "+keep",
      "+++ ", // malformed header → currentFile goes back to null
      "@@ -0,0 +1,1 @@",
      "+dropped",
    ].join("\n");
    const out = parseDiffAddedLines(diff);
    expect(out.map((l) => l.content)).toEqual(["keep"]);
  });
});

describe("detectTransitionsInLines — uncovered branches", () => {
  it("skips an annotation when opts.entity does not match", () => {
    const lines = [
      { file: "a.ts", line: 1, content: "// @sm:order draft -> paid" },
    ];
    const out = detectTransitionsInLines(lines, { entity: "invoice" });
    // Entity scope rejected annotation entirely.
    expect(out).toEqual([]);
  });

  it("honours ignore marker on a preceding added line", () => {
    const lines = [
      { file: "x.ts", line: 10, content: "// flockctl-sm-ignore" },
      { file: "x.ts", line: 11, content: "// @sm:order draft -> paid" },
    ];
    const out = detectTransitionsInLines(lines);
    expect(out).toEqual([]);
  });

  it("handles object-literal with event: field", () => {
    const lines = [
      {
        file: "x.ts",
        line: 1,
        content: "transition({ from: 'a', to: 'b', event: 'fire' })",
      },
    ];
    const out = detectTransitionsInLines(lines);
    expect(out).toHaveLength(1);
    expect(out[0]!.event).toBe("fire");
    expect(out[0]!.pattern).toBe("object-literal");
  });

  it("uses opts.entity when object literal has no entity hint", () => {
    const lines = [
      { file: "x.ts", line: 1, content: "{ from: 'a', to: 'b' }" },
    ];
    const out = detectTransitionsInLines(lines, { entity: "order" });
    expect(out[0]!.entity).toBe("order");
  });

  it("event-call: skips unrelated entities when opts.entity set", () => {
    const registry: Map<string, RegistryEntry> = new Map([
      [
        "order",
        {
          entity: "order",
          sourcePath: "/r/order.md",
          states: ["a", "b"],
          transitions: [{ from: "a", to: "b", event: "known" }],
        },
      ],
      [
        "invoice",
        {
          entity: "invoice",
          sourcePath: "/r/invoice.md",
          states: [],
          transitions: [],
        },
      ],
    ]);
    const lines = [
      { file: "x.ts", line: 1, content: ".transition('mystery')" },
    ];
    const out = detectTransitionsInLines(lines, {
      registry,
      entity: "order",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.entity).toBe("order");
    expect(out[0]!.event).toBe("mystery");
  });

  it("event-call: does NOT flag a known event (declared transition)", () => {
    const registry: Map<string, RegistryEntry> = new Map([
      [
        "order",
        {
          entity: "order",
          sourcePath: "/r/order.md",
          states: ["a", "b"],
          transitions: [{ from: "a", to: "b", event: "known" }],
        },
      ],
    ]);
    const out = detectTransitionsInLines(
      [{ file: "x.ts", line: 1, content: ".transition('known')" }],
      { registry },
    );
    expect(out).toEqual([]);
  });
});

describe("checkAgainstRegistry — uncovered message branches", () => {
  it("builds event-call violation when no registry entry exists for the entity", () => {
    const detected: DetectedTransition[] = [
      {
        entity: "order",
        from: "?",
        to: "?",
        event: "xyz",
        file: "x.ts",
        line: 1,
        raw: ".transition('xyz')",
        pattern: "event-call",
      },
    ];
    const violations = checkAgainstRegistry(detected, new Map());
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/unknown event `xyz`/);
    expect(violations[0]!.suggestion).toMatch(/xyz/);
  });

  it("entity=* aggregates candidates from every registry entry", () => {
    const reg: Map<string, RegistryEntry> = new Map([
      [
        "order",
        {
          entity: "order",
          sourcePath: "/r/o.md",
          states: ["a", "b"],
          transitions: [{ from: "a", to: "b" }],
        },
      ],
      [
        "invoice",
        {
          entity: "invoice",
          sourcePath: "/r/i.md",
          states: ["a", "b"],
          transitions: [{ from: "x", to: "y" }],
        },
      ],
    ]);
    // This transition exists in one of the two registries — allowed.
    const allowed = checkAgainstRegistry(
      [
        {
          entity: "*",
          from: "a",
          to: "b",
          file: "f.ts",
          line: 1,
          raw: "{from:'a',to:'b'}",
          pattern: "object-literal",
        },
      ],
      reg,
    );
    expect(allowed).toEqual([]);

    // Neither entity declares d->e → violation with empty `registeredTransitions`
    // because candidates.length > 1 so `entry` stays undefined.
    const viol = checkAgainstRegistry(
      [
        {
          entity: "*",
          from: "d",
          to: "e",
          file: "f.ts",
          line: 1,
          raw: "{from:'d',to:'e'}",
          pattern: "object-literal",
        },
      ],
      reg,
    );
    expect(viol).toHaveLength(1);
    expect(viol[0]!.registeredTransitions).toEqual([]);
    expect(viol[0]!.registrySource).toBeUndefined();
  });
});

describe("formatViolations — registered-transition listing", () => {
  it("emits `registered: …` line when registeredTransitions is non-empty", () => {
    const reg: Map<string, RegistryEntry> = new Map([
      [
        "order",
        {
          entity: "order",
          sourcePath: "/r/o.md",
          states: ["a", "b", "c"],
          transitions: [
            { from: "a", to: "b" },
            { from: "b", to: "c", event: "ev" },
          ],
        },
      ],
    ]);
    const viol = checkAgainstRegistry(
      [
        {
          entity: "order",
          from: "a",
          to: "c",
          file: "f.ts",
          line: 7,
          raw: "{from:'a',to:'c'}",
          pattern: "object-literal",
        },
      ],
      reg,
    );
    const out = formatViolations(viol);
    expect(out).toContain("registered: a→b, b→c:ev");
    expect(out).toMatch(/1 state-machine violation found/);
  });

  it("pluralizes the footer when there are multiple violations", () => {
    const viol = checkAgainstRegistry(
      [
        {
          entity: "missing",
          from: "x",
          to: "y",
          file: "a",
          line: 1,
          raw: "",
          pattern: "object-literal",
        },
        {
          entity: "missing",
          from: "y",
          to: "z",
          file: "a",
          line: 2,
          raw: "",
          pattern: "object-literal",
        },
      ],
      new Map(),
    );
    expect(formatViolations(viol)).toMatch(/2 state-machine violations found/);
  });
});

describe("globToRegExp / filterLinesByGlob — uncovered branches", () => {
  it("translates `?` and special regex chars", () => {
    const re = globToRegExp("src/file?.[jt]s");
    // `?` = single non-slash, `[]` escaped, `.` escaped.
    expect(re.test("src/file1.jts")).toBe(false); // literal `.[jt]s` required
    expect(re.test("src/file1.[jt]s")).toBe(true);
    expect(re.test("src/file/1.[jt]s")).toBe(false); // `?` is non-slash
  });

  it("`**/` wildcard matches nested paths and advances past the slash", () => {
    const re = globToRegExp("**/x.ts");
    expect(re.test("x.ts")).toBe(true);
    expect(re.test("a/b/x.ts")).toBe(true);
    expect(re.test("x.ts.bak")).toBe(false);
  });

  it("returns all lines unfiltered when glob is empty/undefined", () => {
    const lines = [{ file: "a.ts", line: 1, content: "x" }];
    expect(filterLinesByGlob(lines, undefined)).toBe(lines);
    // An empty string is falsy too → passthrough.
    expect(filterLinesByGlob(lines, "")).toBe(lines);
  });
});

describe("parseDiffAddedLines — more header kinds", () => {
  it("skips `index` and `deleted file mode` lines inside a diff", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "index abc123..def456 100644",
      "deleted file mode 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -0,0 +1,1 @@",
      "+added",
    ].join("\n");
    const out = parseDiffAddedLines(diff);
    expect(out).toEqual([{ file: "a.ts", line: 1, content: "added" }]);
  });
});

describe("suggestEdit / formatViolations — event-call paths", () => {
  it("event-call with known registry produces `unknown event …` formatted message", () => {
    const reg: Map<string, RegistryEntry> = new Map([
      [
        "order",
        {
          entity: "order",
          sourcePath: "/r/o.md",
          states: ["a", "b"],
          transitions: [{ from: "a", to: "b", event: "known" }],
        },
      ],
    ]);
    const det: DetectedTransition = {
      entity: "order",
      from: "?",
      to: "?",
      event: "mystery",
      file: "x.ts",
      line: 3,
      raw: "",
      pattern: "event-call",
    };
    const viol = checkAgainstRegistry([det], reg);
    expect(viol).toHaveLength(1);
    expect(viol[0]!.message).toMatch(/unknown event `mystery` for entity `order`/);
    expect(viol[0]!.suggestion).toContain("/r/o.md");
    // formatViolations renders both message and registered list.
    const out = formatViolations(viol);
    expect(out).toContain("unknown event `mystery`");
    expect(out).toContain("registered: a→b:known");
  });

  it("object-literal with event field renders `: event` in the Mermaid suggestion", () => {
    const det: DetectedTransition = {
      entity: "order",
      from: "a",
      to: "c",
      event: "fire",
      file: "x.ts",
      line: 1,
      raw: "{from:'a',to:'c',event:'fire'}",
      pattern: "object-literal",
    };
    const viol = checkAgainstRegistry([det], new Map());
    expect(viol[0]!.suggestion).toMatch(/a --> c : fire/);
  });
});

describe("loadRegistry — filesystem edges", () => {
  it("returns empty map when `.flockctl/state-machines/` does not exist", () => {
    const dir = makeProject();
    const reg = loadRegistry(dir);
    expect(reg.size).toBe(0);
  });

  it("loads registry entries from markdown files with mermaid blocks", () => {
    const dir = makeProject();
    const smDir = join(dir, ".flockctl", "state-machines");
    mkdirSync(smDir, { recursive: true });
    // Skipped — not `.md`.
    writeFileSync(join(smDir, "readme.txt"), "ignored");
    // Skipped — nested dir (would be filtered by `isFile()`).
    mkdirSync(join(smDir, "subdir"));
    // Real entry.
    writeFileSync(
      join(smDir, "order.md"),
      `---
entity: order
---

\`\`\`mermaid
stateDiagram-v2
[*] --> draft
draft --> paid : pay
\`\`\`
`,
    );
    // File without mermaid → parseRegistryMarkdown returns null, loadRegistry skips.
    writeFileSync(join(smDir, "empty.md"), "# no diagrams\n");

    const reg = loadRegistry(dir);
    expect(reg.size).toBe(1);
    expect(reg.get("order")?.transitions).toEqual([
      { from: "draft", to: "paid", event: "pay" },
    ]);
  });
});

describe("runCheck — error paths & diffText override", () => {
  it("throws a wrapped error when `git diff` fails (no diffText override)", () => {
    // cwd missing forces execSync to throw.
    expect(() =>
      runCheck({ cwd: "/definitely/not/a/real/path/x/y/z", registry: new Map() }),
    ).toThrow(/failed to run/);
  });

  it("uses opts.diffText and returns exitCode=0 with no violations on clean diff", () => {
    const diff = [
      "+++ b/src/foo.ts",
      "@@ -0,0 +1,1 @@",
      "+// unrelated comment",
    ].join("\n");
    const res = runCheck({ cwd: "/nonexistent", diffText: diff, registry: new Map() });
    expect(res.exitCode).toBe(0);
    expect(res.violations).toEqual([]);
  });

  it("flags an object-literal transition as a violation when no registry entry", () => {
    const diff = [
      "+++ b/src/order.ts",
      "@@ -0,0 +1,1 @@",
      "+{ from: 'draft', to: 'gone', entity: 'order' }",
    ].join("\n");
    const res = runCheck({ cwd: "/nonexistent", diffText: diff, registry: new Map() });
    expect(res.exitCode).toBe(1);
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]!.detected.entity).toBe("order");
  });

  it("filters by `files` glob", () => {
    const diff = [
      "+++ b/skipped.ts",
      "@@ -0,0 +1,1 @@",
      "+{ from: 'a', to: 'b' }",
      "+++ b/src/order.ts",
      "@@ -0,0 +1,1 @@",
      "+{ from: 'a', to: 'b' }",
    ].join("\n");
    const res = runCheck({
      cwd: "/nonexistent",
      diffText: diff,
      files: "src/**",
      registry: new Map(),
    });
    expect(res.detected).toHaveLength(1);
    expect(res.detected[0]!.file).toBe("src/order.ts");
  });
});
