import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Ensures every backend route registered in server.ts has a corresponding
 * Vite proxy entry so the UI dev server forwards requests correctly.
 */
describe("Vite proxy coverage", () => {
  it("all server.ts routes are present in vite.config.ts proxy", () => {
    const serverSrc = readFileSync(resolve(__dirname, "../../src/server.ts"), "utf-8");
    const viteSrc = readFileSync(resolve(__dirname, "../../ui/vite.config.ts"), "utf-8");

    // Extract route prefixes from app.route("/xxx", ...)
    const routeMatches = serverSrc.matchAll(/app\.route\("(\/[^"]+)"/g);
    const routePrefixes = [...new Set([...routeMatches].map(m => m[1]))];

    // Also include app.get("/health", ...) style direct routes
    const directMatches = serverSrc.matchAll(/app\.(?:get|post|put|patch|delete)\("(\/[^"/:]+)"/g);
    const directPrefixes = [...directMatches].map(m => m[1]);

    const allPrefixes = [...new Set([...routePrefixes, ...directPrefixes])];

    expect(allPrefixes.length).toBeGreaterThan(0);

    const missing = allPrefixes.filter(prefix => !viteSrc.includes(`"${prefix}"`));

    if (missing.length > 0) {
      throw new Error(
        `These backend routes are missing from ui/vite.config.ts proxy:\n` +
        missing.map(p => `  "${p}": "http://localhost:52077"`).join("\n") +
        `\n\nAdd them to avoid "Not found" / pattern errors in the UI dev server.`
      );
    }
  });
});
