// ─── no_circular_imports — static import-graph invariant ───
//
// Pins the parent slice 11/03 §"auto-executor must NOT import missions"
// invariant: the auto-executor is the "make tasks run" engine and the
// missions tier is the "decide what to do next" engine. They communicate
// via the `taskTerminalEvents` channel (see `src/services/typed-event-
// emitter.ts` + the subscriber at `src/services/missions/event-subscriber
// .ts`). If a future refactor smuggles a `from "./missions/..."` import
// into the auto-executor's transitive closure, the executor stops being
// buildable without the supervisor stack — and the runtime decoupling
// promised by the EventEmitter seam quietly evaporates.
//
// We don't take a `madge` dependency for this — the test is small enough
// to express as a hand-rolled BFS over the file's relative imports, which
// keeps the suite hermetic (no network / postinstall cost) and avoids
// adding a transitive devDep just to enforce one rule.
//
// Scope:
//   - Resolves only RELATIVE specifiers (./, ../). Bare specifiers
//     ("drizzle-orm", "node:crypto", etc.) are skipped — the rule is
//     about intra-repo coupling, not about node_modules.
//   - Resolves `*.js` to its sibling `*.ts` source (the codebase uses
//     ESM-style `.js` import suffixes against TypeScript sources).
//   - Treats a `from "./foo"` (no extension) as `./foo.ts` or `./foo/
//     index.ts` to mirror the TS resolver's fallback.
//
// What this catches:
//   - A direct edge: `auto-executor.ts` adds `import {...} from
//     "./missions/event-subscriber.js"`.
//   - A transitive edge: any module reachable from auto-executor adding
//     a missions import (e.g. plan-store importing supervisor for some
//     reason).
//
// What this does NOT catch:
//   - Dynamic `await import("./missions/...")` calls. These are
//     forbidden by code-review and are not idiomatic in this codebase
//     (no `await import` is used in src/ today). A future check could
//     add a regex for them; the current scope is the static-import
//     surface mentioned in the parent slice.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────
// Pure helpers — no Vitest, no DB, no I/O beyond `fs`.
// ─────────────────────────────────────────────────────────────────────

/**
 * Extract every `from "..."` specifier from a TypeScript source — covers
 * `import x from "..."`, `import { a, b } from "..."`, `import "..."`
 * (side-effect import), `import type ... from "..."`, and
 * `export ... from "..."` re-exports.
 *
 * Multiline imports work because the regex is anchored on the keyword and
 * non-greedy across the brace block; the [\s\S] class matches newlines.
 *
 * Side-effect-only imports (`import "./register-codecs.js"`) are matched
 * by a separate clause since they have no `from` keyword.
 */
function extractImportSpecifiers(content: string): string[] {
  const out: string[] = [];

  // `import ... from "..."` and `export ... from "..."`.
  const fromRe = /(?:^|\s)(?:import|export)(?:\s+type)?[\s\S]*?\sfrom\s+["']([^"']+)["']/g;
  for (let m: RegExpExecArray | null; (m = fromRe.exec(content)); ) {
    out.push(m[1]);
  }

  // Side-effect imports: `import "./foo.js";` (no `from`).
  const sideRe = /(?:^|\s)import\s+["']([^"']+)["']/g;
  for (let m: RegExpExecArray | null; (m = sideRe.exec(content)); ) {
    out.push(m[1]);
  }

  return out;
}

/**
 * Resolve a relative import specifier from a source file to the on-disk
 * `.ts` source it points at. Returns `null` for bare specifiers and for
 * paths that don't resolve to an existing file (broken imports are not
 * this test's concern — `tsc` already covers them).
 *
 *   - `./foo.js`  → `./foo.ts`            (.js suffix swap, ESM convention)
 *   - `./foo`     → `./foo.ts`            (extension-less)
 *   - `./foo`     → `./foo/index.ts`      (directory + index fallback)
 *   - `./foo.json` → null                 (not TS — out of scope)
 */
function resolveRelativeImport(
  fromFile: string,
  spec: string,
): string | null {
  if (!spec.startsWith(".")) return null; // bare specifier — skip.
  const baseDir = dirname(fromFile);
  const target = resolve(baseDir, spec);

  // ESM-style `.js` import against a `.ts` source.
  if (target.endsWith(".js")) {
    const tsCandidate = target.replace(/\.js$/u, ".ts");
    if (existsSync(tsCandidate) && statSync(tsCandidate).isFile()) {
      return tsCandidate;
    }
  }

  // Extension-less `./foo` → `./foo.ts`.
  const tsCandidate = `${target}.ts`;
  if (existsSync(tsCandidate) && statSync(tsCandidate).isFile()) {
    return tsCandidate;
  }

  // Directory + index fallback.
  const indexCandidate = join(target, "index.ts");
  if (existsSync(indexCandidate) && statSync(indexCandidate).isFile()) {
    return indexCandidate;
  }

  // Imports of non-TS assets (JSON, .css, etc.) and broken imports return
  // null — neither is a missions edge, so dropping them is safe.
  return null;
}

/**
 * BFS the static import graph rooted at `entryFile`. Returns every TS
 * source reachable via relative imports (the bare specifiers are
 * deliberately excluded — see file header).
 *
 * The returned set is keyed by absolute file path so callers can slice
 * it any way they like (path-prefix tests, `relative()` for diagnostics,
 * etc.).
 */
function collectTransitiveImports(entryFile: string): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [entryFile];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);

    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      // Defensive: a file that disappeared between BFS rounds (unlikely
      // under a test run) shouldn't crash the test.
      continue;
    }
    for (const spec of extractImportSpecifiers(content)) {
      const resolved = resolveRelativeImport(file, spec);
      if (resolved && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return visited;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, "..", "..");
const SRC_ROOT = resolve(__dirname, "..");
const AUTO_EXECUTOR = resolve(SRC_ROOT, "services", "auto-executor.ts");
const MISSIONS_DIR = resolve(SRC_ROOT, "services", "missions");

/**
 * True when `file` is inside `src/services/missions/` — the forbidden
 * zone for the auto-executor's import closure. Comparison is path-
 * prefix; the trailing separator guard prevents a future
 * `services/missions-companion/` directory from being misclassified.
 */
function isInsideMissions(file: string): boolean {
  const prefix = MISSIONS_DIR + "/";
  return file === MISSIONS_DIR || file.startsWith(prefix);
}

describe("no_circular_imports", () => {
  // ───────────────────────────────────────────────────────────────────
  // self-test for the BFS helper — guard against false negatives.
  // ───────────────────────────────────────────────────────────────────
  //
  // The whole test relies on `collectTransitiveImports` actually walking
  // the graph. If a regex regression silently returned an empty set,
  // every "forbidden zone" test would trivially pass. Pin two known
  // edges from the auto-executor so the helper is exercised end-to-end.
  it("self_test: collectTransitiveImports walks at least the obvious edges", () => {
    const reachable = collectTransitiveImports(AUTO_EXECUTOR);

    // The entry file itself MUST be reachable (it's in the visited set).
    expect(reachable.has(AUTO_EXECUTOR)).toBe(true);

    // typed-event-emitter is a direct edge (line 19 of auto-executor).
    expect(
      reachable.has(resolve(SRC_ROOT, "services", "typed-event-emitter.ts")),
    ).toBe(true);

    // The plan-store directory entry is imported as
    // `./plan-store/index.js` — verify the directory + index fallback
    // resolves it correctly.
    expect(
      reachable.has(
        resolve(SRC_ROOT, "services", "plan-store", "index.ts"),
      ),
    ).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────
  // auto_executor_has_zero_outbound_edges_into_missions
  // ───────────────────────────────────────────────────────────────────
  //
  // The headline assertion. Every TS source reachable from auto-
  // executor.ts via static `import` / `export … from "…"` chains must
  // live OUTSIDE `src/services/missions/`. A failure here means the
  // mission-agnostic-executor invariant has been violated — the
  // EventEmitter seam exists precisely so the executor doesn't need to
  // know what missions are.
  it("auto_executor_has_zero_outbound_edges_into_src_services_missions", () => {
    const reachable = collectTransitiveImports(AUTO_EXECUTOR);
    const violations = [...reachable]
      .filter(isInsideMissions)
      .map((p) => relative(REPO_ROOT, p));

    if (violations.length > 0) {
      // Surface the offending files in the assertion message so a CI
      // failure points the author straight at the import to remove.
      const formatted = violations.map((v) => `  - ${v}`).join("\n");
      throw new Error(
        `auto-executor.ts must not (transitively) import from src/services/missions/.\n` +
          `Found ${violations.length} forbidden edge(s):\n${formatted}\n\n` +
          `If you need to react to terminal task events from the missions tier, ` +
          `subscribe via taskTerminalEvents (see src/services/missions/event-subscriber.ts).`,
      );
    }
    expect(violations).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────
  // event_subscriber_does_import_auto_executor (sanity check)
  // ───────────────────────────────────────────────────────────────────
  //
  // The opposite direction is allowed — the subscriber pulls in the
  // emitter handle from `auto-executor.ts`. Pinning this edge guards
  // against an accidental refactor that severs the wiring (which would
  // make the headline test trivially true: an empty graph passes).
  it("event_subscriber_imports_auto_executor_emitter_handle", () => {
    const subscriber = resolve(MISSIONS_DIR, "event-subscriber.ts");
    const reachable = collectTransitiveImports(subscriber);
    expect(reachable.has(AUTO_EXECUTOR)).toBe(true);
  });
});
