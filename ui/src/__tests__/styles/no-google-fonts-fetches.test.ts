/// <reference types="node" />
/**
 * no-google-fonts-fetches.test.ts — M22 typography slice
 *
 * Guards the "fonts are vendored, never fetched" invariant. The slice
 * standardises on `@fontsource-variable/*` packages (vendored woff2
 * files in `node_modules`); a regression to a CDN `<link
 * href="https://fonts.googleapis.com/…">` or a `@import
 * url("https://fonts.gstatic.com/…")` would defeat the local-first
 * posture and add a runtime network dependency to the UI shell.
 *
 * What this test does:
 *
 *   1. Always asserts the source files (`index.html`, everything under
 *      `src/`) contain no `googleapis.com` or `gstatic.com`
 *      references. This is the regression guard that runs every CI
 *      pass.
 *   2. If `dist/` exists (i.e. the operator ran `npm run build`
 *      before `npm test`), additionally walks the built artefacts to
 *      confirm the bundler did not splice a CDN reference back in via
 *      a transitive dependency. Skipped silently when there is no
 *      build output — the verification command in the slice spec
 *      (`npm run build && grep ...`) covers the post-build pass
 *      explicitly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../..");

const BANNED = [/googleapis\.com/i, /gstatic\.com/i];

/**
 * Walk `root` recursively and return absolute paths of regular files
 * whose extension matches one of `exts` (case-insensitive). Skips
 * `node_modules` to avoid false positives in vendored package
 * comments / READMEs that reference Google Fonts as upstream.
 */
function walk(root: string, exts: readonly string[]): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack: string[] = [root];
  // The styles test folder itself contains the banned strings as
  // regex source — skip it to avoid a self-referential failure.
  const selfDir = path.resolve(__dirname);
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (path.resolve(dir) === selfDir) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (exts.includes(ext)) out.push(full);
      }
    }
  }
  return out;
}

describe("M22 typography — no Google Fonts fetches", () => {
  it("source tree (index.html + src/**) has no googleapis.com / gstatic.com references", () => {
    const targets = [
      path.resolve(repoRoot, "index.html"),
      ...walk(path.resolve(repoRoot, "src"), [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".css",
        ".html",
      ]),
    ].filter((f) => existsSync(f) && statSync(f).isFile());

    expect(targets.length).toBeGreaterThan(0);

    const offenders: { file: string; pattern: string }[] = [];
    for (const file of targets) {
      const text = readFileSync(file, "utf8");
      for (const re of BANNED) {
        if (re.test(text)) {
          offenders.push({
            file: path.relative(repoRoot, file),
            pattern: re.source,
          });
        }
      }
    }
    expect(
      offenders,
      `Source files must not reference Google Fonts CDNs:\n${offenders
        .map((o) => `  ${o.file} matches /${o.pattern}/`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("built artefacts (dist/**) have no googleapis.com / gstatic.com references when present", () => {
    const dist = path.resolve(repoRoot, "dist");
    if (!existsSync(dist)) {
      // Skip silently — `npm run build` is part of the slice
      // verification command but is not a precondition for `npm
      // test`.
      return;
    }

    const distFiles = walk(dist, [".html", ".css", ".js", ".mjs", ".map"]);
    const offenders: { file: string; pattern: string }[] = [];
    for (const file of distFiles) {
      const text = readFileSync(file, "utf8");
      for (const re of BANNED) {
        if (re.test(text)) {
          offenders.push({
            file: path.relative(repoRoot, file),
            pattern: re.source,
          });
        }
      }
    }
    expect(
      offenders,
      `Built artefacts must not contain Google Fonts CDN references:\n${offenders
        .map((o) => `  ${o.file} matches /${o.pattern}/`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
