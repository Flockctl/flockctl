import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";

import {
  runCheck,
  parseDiffAddedLines,
  parseMermaidBlock,
  parseRegistryMarkdown,
  loadRegistry,
  detectTransitionsInLines,
  checkAgainstRegistry,
  formatViolations,
  globToRegExp,
  filterLinesByGlob,
} from "../../services/state-machines/sm-diff-analyzer";

/* -------------------------------------------------------------------------- */
/* Fixtures / helpers                                                         */
/* -------------------------------------------------------------------------- */

const ORDER_REGISTRY_MD_BASE = `---
entity: order
---

# Order state machine

\`\`\`mermaid
stateDiagram-v2
    [*] --> pending
    pending --> shipped : ship
    pending --> cancelled : cancel
    shipped --> delivered : deliver
\`\`\`
`;

const ORDER_REGISTRY_MD_WITH_CANCEL_FROM_SHIPPED = `---
entity: order
---

# Order state machine

\`\`\`mermaid
stateDiagram-v2
    [*] --> pending
    pending --> shipped : ship
    pending --> cancelled : cancel
    shipped --> delivered : deliver
    shipped --> cancelled : cancel
\`\`\`
`;

function setupRepo(registry: string): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "flockctl-sm-test-"));

  mkdirSync(join(root, ".flockctl", "state-machines"), { recursive: true });
  writeFileSync(
    join(root, ".flockctl", "state-machines", "order.md"),
    registry,
  );

  return { root };
}

/**
 * Craft a unified diff that claims to add one line with a new transition.
 * Using a synthetic diff string lets us avoid shelling out to `git` in each
 * assertion while still exercising `parseDiffAddedLines` end-to-end.
 */
function syntheticDiff(file: string, addedLines: string[]): string {
  const count = addedLines.length;
  const header =
    `diff --git a/${file} b/${file}\n` +
    `--- a/${file}\n` +
    `+++ b/${file}\n` +
    `@@ -0,0 +1,${count} @@\n`;
  return header + addedLines.map((l) => `+${l}`).join("\n") + "\n";
}

/* -------------------------------------------------------------------------- */
/* Mermaid parser                                                             */
/* -------------------------------------------------------------------------- */

describe("parseMermaidBlock", () => {
  it("parses initial, transitions, events, final", () => {
    const parsed = parseMermaidBlock(
      `stateDiagram-v2
    [*] --> pending
    pending --> shipped : ship
    pending --> cancelled : cancel
    shipped --> delivered : deliver
    delivered --> [*]`,
    );
    expect(parsed.initial).toBe("pending");
    expect(parsed.states.sort()).toEqual(
      ["cancelled", "delivered", "pending", "shipped"].sort(),
    );
    expect(parsed.transitions).toEqual([
      { from: "pending", to: "shipped", event: "ship" },
      { from: "pending", to: "cancelled", event: "cancel" },
      { from: "shipped", to: "delivered", event: "deliver" },
    ]);
  });

  it("skips comments, directives, and blank lines without crashing", () => {
    const parsed = parseMermaidBlock(
      `stateDiagram-v2
%% a comment
    direction LR

    classDef ok fill:#0f0

    A --> B`,
    );
    expect(parsed.transitions).toEqual([{ from: "A", to: "B" }]);
  });

  it("ignores [*] -> [*] self-loops and parses events without whitespace", () => {
    const parsed = parseMermaidBlock(
      `stateDiagram-v2
[*] --> [*]
idle-->running:start`,
    );
    expect(parsed.initial).toBeUndefined();
    expect(parsed.transitions).toEqual([
      { from: "idle", to: "running", event: "start" },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Registry markdown loader                                                   */
/* -------------------------------------------------------------------------- */

describe("parseRegistryMarkdown", () => {
  it("extracts the entity name from frontmatter", () => {
    const entry = parseRegistryMarkdown(ORDER_REGISTRY_MD_BASE, "/tmp/order.md");
    expect(entry).not.toBeNull();
    expect(entry!.entity).toBe("order");
    expect(entry!.transitions.length).toBe(3);
    expect(entry!.initial).toBe("pending");
  });

  it("falls back to HTML comment for entity when frontmatter is absent", () => {
    const md = `<!-- entity: payment -->

\`\`\`mermaid
stateDiagram-v2
    [*] --> new
    new --> paid : pay
\`\`\`
`;
    const entry = parseRegistryMarkdown(md, "/tmp/x.md");
    expect(entry!.entity).toBe("payment");
  });

  it("falls back to the filename stem when nothing else is present", () => {
    const md = `\`\`\`mermaid
stateDiagram-v2
    [*] --> a
    a --> b : go
\`\`\``;
    const entry = parseRegistryMarkdown(md, "/tmp/widget.md");
    expect(entry!.entity).toBe("widget");
  });

  it("returns null when there are no mermaid blocks", () => {
    expect(
      parseRegistryMarkdown("# nothing here", "/tmp/x.md"),
    ).toBeNull();
  });

  it("returns null when mermaid blocks are empty", () => {
    const md = `\`\`\`mermaid
stateDiagram-v2
\`\`\``;
    expect(parseRegistryMarkdown(md, "/tmp/x.md")).toBeNull();
  });

  it("uses the first H1 heading when nothing else names the entity", () => {
    const md = `# Shipping

\`\`\`mermaid
stateDiagram-v2
    [*] --> a
    a --> b : go
\`\`\``;
    const entry = parseRegistryMarkdown(md, "/tmp/stuff.md");
    expect(entry!.entity).toBe("shipping");
  });
});

/* -------------------------------------------------------------------------- */
/* loadRegistry                                                               */
/* -------------------------------------------------------------------------- */

describe("loadRegistry", () => {
  let root: string;

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("loads all .md files under .flockctl/state-machines/", () => {
    ({ root } = setupRepo(ORDER_REGISTRY_MD_BASE));
    writeFileSync(
      join(root, ".flockctl", "state-machines", "payment.md"),
      `<!-- entity: payment -->

\`\`\`mermaid
stateDiagram-v2
    [*] --> new
    new --> paid : pay
\`\`\``,
    );
    const reg = loadRegistry(root);
    expect([...reg.keys()].sort()).toEqual(["order", "payment"]);
    expect(reg.get("order")!.transitions.length).toBe(3);
  });

  it("returns an empty map when the directory is missing", () => {
    root = mkdtempSync(join(tmpdir(), "flockctl-sm-empty-"));
    const reg = loadRegistry(root);
    expect(reg.size).toBe(0);
  });

  it("skips non-.md files and directories", () => {
    ({ root } = setupRepo(ORDER_REGISTRY_MD_BASE));
    writeFileSync(
      join(root, ".flockctl", "state-machines", "README.txt"),
      "not a registry",
    );
    mkdirSync(join(root, ".flockctl", "state-machines", "archive"));
    const reg = loadRegistry(root);
    expect(reg.size).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Diff parser                                                                */
/* -------------------------------------------------------------------------- */

describe("parseDiffAddedLines", () => {
  it("extracts added lines with 1-based new-file line numbers", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,5 @@
 const a = 1;
+const b = 2;
+const c = 3;
 const d = 4;
-const e = 5;
 const f = 6;
`;
    const added = parseDiffAddedLines(diff);
    expect(added).toEqual([
      { file: "src/foo.ts", line: 2, content: "const b = 2;" },
      { file: "src/foo.ts", line: 3, content: "const c = 3;" },
    ]);
  });

  it("handles /dev/null new files and multiple files in the diff", () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
--- a/deleted.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-gone
`;
    const added = parseDiffAddedLines(diff);
    expect(added.map((l) => l.file)).toEqual(["new.ts", "new.ts"]);
    expect(added[0].line).toBe(1);
    expect(added[1].line).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Heuristic detection                                                        */
/* -------------------------------------------------------------------------- */

describe("detectTransitionsInLines — explicit annotation", () => {
  it("detects `@sm:entity from -> to`", () => {
    const d = detectTransitionsInLines([
      {
        file: "src/order.ts",
        line: 10,
        content: "// @sm:order shipped -> cancelled",
      },
    ]);
    expect(d).toEqual([
      expect.objectContaining({
        entity: "order",
        from: "shipped",
        to: "cancelled",
        pattern: "annotation",
      }),
    ]);
  });

  it("detects `@sm entity: from -> to` and `flockctl-sm entity from->to`", () => {
    const d = detectTransitionsInLines([
      {
        file: "a.ts",
        line: 1,
        content: "// @sm order: new -> paid",
      },
      {
        file: "b.ts",
        line: 1,
        content: "/* flockctl-sm order a->b */",
      },
    ]);
    expect(d.length).toBe(2);
    expect(d[0].from).toBe("new");
    expect(d[1].from).toBe("a");
    expect(d[1].to).toBe("b");
  });

  it("respects an inline ignore marker", () => {
    const d = detectTransitionsInLines([
      {
        file: "x.ts",
        line: 1,
        content: "// @sm:order a -> b   // flockctl-sm-ignore",
      },
    ]);
    expect(d).toEqual([]);
  });

  it("respects an ignore marker on the preceding added line", () => {
    const d = detectTransitionsInLines([
      { file: "x.ts", line: 10, content: "// flockctl-sm-ignore" },
      { file: "x.ts", line: 11, content: "// @sm:order a -> b" },
    ]);
    expect(d).toEqual([]);
  });
});

describe("detectTransitionsInLines — object literal", () => {
  it("detects `{ from: 'X', to: 'Y' }` with entity hint", () => {
    const d = detectTransitionsInLines([
      {
        file: "x.ts",
        line: 1,
        content:
          "const t = { entity: 'order', from: 'shipped', to: 'cancelled' };",
      },
    ]);
    expect(d).toEqual([
      expect.objectContaining({
        entity: "order",
        from: "shipped",
        to: "cancelled",
        pattern: "object-literal",
      }),
    ]);
  });

  it("falls back to entity=* when no hint is present", () => {
    const d = detectTransitionsInLines([
      { file: "x.ts", line: 1, content: "{ from: 'a', to: 'b' }" },
    ]);
    expect(d[0].entity).toBe("*");
  });

  it("captures an optional event field", () => {
    const d = detectTransitionsInLines([
      {
        file: "x.ts",
        line: 1,
        content: "{ from: 'a', to: 'b', event: 'go' }",
      },
    ]);
    expect(d[0].event).toBe("go");
  });
});

describe("detectTransitionsInLines — event call", () => {
  it("flags unknown events from `.transition('...')` against the registry", () => {
    const entry = parseRegistryMarkdown(
      ORDER_REGISTRY_MD_BASE,
      "/tmp/order.md",
    )!;
    const registry = new Map([[entry.entity, entry]]);

    const d = detectTransitionsInLines(
      [
        { file: "x.ts", line: 1, content: "order.transition('ship')" },
        { file: "x.ts", line: 2, content: "order.transition('teleport')" },
      ],
      { registry },
    );
    expect(d.length).toBe(1);
    expect(d[0].pattern).toBe("event-call");
    expect(d[0].event).toBe("teleport");
  });
});

/* -------------------------------------------------------------------------- */
/* checkAgainstRegistry                                                       */
/* -------------------------------------------------------------------------- */

describe("checkAgainstRegistry", () => {
  const entry = parseRegistryMarkdown(
    ORDER_REGISTRY_MD_BASE,
    "/tmp/order.md",
  )!;
  const registry = new Map([[entry.entity, entry]]);

  it("passes a declared transition (pending -> shipped)", () => {
    const v = checkAgainstRegistry(
      [
        {
          entity: "order",
          from: "pending",
          to: "shipped",
          file: "x.ts",
          line: 1,
          raw: "",
          pattern: "annotation",
        },
      ],
      registry,
    );
    expect(v).toEqual([]);
  });

  it("reports an undeclared transition (shipped -> cancelled)", () => {
    const v = checkAgainstRegistry(
      [
        {
          entity: "order",
          from: "shipped",
          to: "cancelled",
          file: "x.ts",
          line: 1,
          raw: "",
          pattern: "annotation",
        },
      ],
      registry,
    );
    expect(v.length).toBe(1);
    expect(v[0].message).toBe(
      "new transition shipped→cancelled not declared in registry",
    );
    expect(v[0].registrySource).toBe("/tmp/order.md");
    expect(v[0].suggestion).toContain("shipped --> cancelled");
  });

  it("reports when the entity has no registry at all", () => {
    const v = checkAgainstRegistry(
      [
        {
          entity: "ghost",
          from: "a",
          to: "b",
          file: "x.ts",
          line: 1,
          raw: "",
          pattern: "annotation",
        },
      ],
      registry,
    );
    expect(v.length).toBe(1);
    expect(v[0].message).toContain("no registry for entity `ghost`");
  });

  it("passes an entity='*' transition if any entity declares it", () => {
    const v = checkAgainstRegistry(
      [
        {
          entity: "*",
          from: "pending",
          to: "shipped",
          file: "x.ts",
          line: 1,
          raw: "",
          pattern: "object-literal",
        },
      ],
      registry,
    );
    expect(v).toEqual([]);
  });

  it("reports unknown events from event-call detections", () => {
    const v = checkAgainstRegistry(
      [
        {
          entity: "order",
          from: "?",
          to: "?",
          event: "teleport",
          file: "x.ts",
          line: 1,
          raw: "",
          pattern: "event-call",
        },
      ],
      registry,
    );
    expect(v.length).toBe(1);
    expect(v[0].message).toContain("unknown event `teleport`");
  });
});

/* -------------------------------------------------------------------------- */
/* Glob filter                                                                */
/* -------------------------------------------------------------------------- */

describe("globToRegExp / filterLinesByGlob", () => {
  it("matches single-segment wildcards", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/order.ts")).toBe(true);
    expect(re.test("src/nested/order.ts")).toBe(false);
  });

  it("matches recursive wildcards", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/order.ts")).toBe(true);
    expect(re.test("src/a/b/order.ts")).toBe(true);
    expect(re.test("other/order.ts")).toBe(false);
  });

  it("filters diff lines by glob", () => {
    const lines = [
      { file: "src/a.ts", line: 1, content: "" },
      { file: "tests/b.ts", line: 1, content: "" },
    ];
    expect(filterLinesByGlob(lines, "src/**/*.ts")).toHaveLength(1);
    expect(filterLinesByGlob(lines, undefined)).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end — the spec fixture                                              */
/* -------------------------------------------------------------------------- */

describe("runCheck — spec verification fixture", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupRepo(ORDER_REGISTRY_MD_BASE));
  });

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("exits 1 when a new `shipped -> cancelled` transition is added without updating the registry", () => {
    const diff = syntheticDiff("src/models/order.ts", [
      "function cancelShipped(order) {",
      "  // @sm:order shipped -> cancelled",
      "  order.status = 'cancelled';",
      "}",
    ]);

    const result = runCheck({ cwd: root, diffText: diff });
    expect(result.exitCode).toBe(1);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].message).toBe(
      "new transition shipped→cancelled not declared in registry",
    );
    expect(result.violations[0].detected.file).toBe("src/models/order.ts");
    expect(result.violations[0].suggestion).toContain("shipped --> cancelled");
  });

  it("exits 0 when the registry is updated to declare shipped -> cancelled", () => {
    // Overwrite order.md with the variant that allows shipped -> cancelled
    writeFileSync(
      join(root, ".flockctl", "state-machines", "order.md"),
      ORDER_REGISTRY_MD_WITH_CANCEL_FROM_SHIPPED,
    );

    const diff = syntheticDiff("src/models/order.ts", [
      "function cancelShipped(order) {",
      "  // @sm:order shipped -> cancelled",
      "  order.status = 'cancelled';",
      "}",
    ]);

    const result = runCheck({ cwd: root, diffText: diff });
    expect(result.exitCode).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it("exits 0 when the diff has no transitions at all", () => {
    const diff = syntheticDiff("src/models/order.ts", [
      "// just a doc tweak",
      "export const X = 1;",
    ]);
    const result = runCheck({ cwd: root, diffText: diff });
    expect(result.exitCode).toBe(0);
    expect(result.detected).toEqual([]);
  });

  it("respects the --files glob to restrict detection scope", () => {
    const diff =
      syntheticDiff("src/models/order.ts", [
        "// @sm:order shipped -> cancelled",
      ]) +
      syntheticDiff("docs/order.md", [
        "// @sm:order shipped -> cancelled",
      ]);

    const scoped = runCheck({
      cwd: root,
      diffText: diff,
      files: "docs/**/*.md",
    });
    // Only the docs occurrence should be considered — but that's still an
    // undeclared transition, so exit 1 with exactly one violation.
    expect(scoped.violations.length).toBe(1);
    expect(scoped.violations[0].detected.file).toBe("docs/order.md");
  });

  it("suppresses violations when `// flockctl-sm-ignore` is adjacent", () => {
    const diff = syntheticDiff("src/models/order.ts", [
      "// flockctl-sm-ignore",
      "// @sm:order shipped -> cancelled",
    ]);
    const result = runCheck({ cwd: root, diffText: diff });
    expect(result.exitCode).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end via real `git diff` (covers the execSync path)                  */
/* -------------------------------------------------------------------------- */

describe("runCheck — real git diff", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupRepo(ORDER_REGISTRY_MD_BASE));
    execSync("git init -q", { cwd: root });
    execSync("git config user.email test@example.com", { cwd: root });
    execSync("git config user.name test", { cwd: root });
    execSync("git add -A && git commit -q -m init", { cwd: root });
  });

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("runs `git diff HEAD` and flags undeclared transitions", () => {
    writeFileSync(
      join(root, "order.ts"),
      `// @sm:order shipped -> cancelled\nexport const X = 1;\n`,
    );
    // Stage the new file so `git diff HEAD` shows it (untracked files are
    // otherwise invisible to `git diff`).
    execSync("git add order.ts", { cwd: root });
    const result = runCheck({ cwd: root });
    expect(result.exitCode).toBe(1);
    expect(result.violations[0].message).toBe(
      "new transition shipped→cancelled not declared in registry",
    );
  });

  it("throws a helpful error when git fails", () => {
    // Not a git repo
    const nonRepo = mkdtempSync(join(tmpdir(), "flockctl-sm-notgit-"));
    try {
      expect(() => runCheck({ cwd: nonRepo })).toThrow(/git diff/);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* formatViolations                                                           */
/* -------------------------------------------------------------------------- */

describe("formatViolations", () => {
  it("renders file:line, message, registered list, and suggestion", () => {
    const entry = parseRegistryMarkdown(
      ORDER_REGISTRY_MD_BASE,
      "/tmp/order.md",
    )!;
    const violations = checkAgainstRegistry(
      [
        {
          entity: "order",
          from: "shipped",
          to: "cancelled",
          file: "src/order.ts",
          line: 42,
          raw: "",
          pattern: "annotation",
        },
      ],
      new Map([[entry.entity, entry]]),
    );
    const out = formatViolations(violations);
    expect(out).toContain("src/order.ts:42");
    expect(out).toContain(
      "new transition shipped→cancelled not declared in registry",
    );
    expect(out).toContain("registered: pending→shipped:ship");
    expect(out).toContain("1 state-machine violation found");
  });

  it("pluralises when there are multiple violations", () => {
    const entry = parseRegistryMarkdown(
      ORDER_REGISTRY_MD_BASE,
      "/tmp/order.md",
    )!;
    const violations = checkAgainstRegistry(
      [
        {
          entity: "order",
          from: "shipped",
          to: "cancelled",
          file: "a.ts",
          line: 1,
          raw: "",
          pattern: "annotation",
        },
        {
          entity: "order",
          from: "delivered",
          to: "shipped",
          file: "b.ts",
          line: 2,
          raw: "",
          pattern: "annotation",
        },
      ],
      new Map([[entry.entity, entry]]),
    );
    expect(formatViolations(violations)).toContain("2 state-machine violations found");
  });
});
