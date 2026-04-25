import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { basename, dirname, join } from "path";

interface PackageMeta {
  name: string;
  version: string;
}

let cached: PackageMeta | null = null;

function loadPackageMeta(): PackageMeta {
  if (cached) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/lib/package-version.ts → ../../package.json
    // dist/lib/package-version.js → ../../package.json
    const path = join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
      name?: string;
      version?: string;
    };
    /* v8 ignore start — package.json in-tree always has these fields; the
       ?? fallback exists only as a defensive shim for a corrupted install. */
    cached = {
      name: pkg.name ?? "flockctl",
      version: pkg.version ?? "unknown",
    };
    /* v8 ignore stop */
  } catch {
    cached = { name: "flockctl", version: "unknown" };
  }
  return cached;
}

export function getPackageVersion(): string {
  return loadPackageMeta().version;
}

export function getPackageName(): string {
  return loadPackageMeta().name;
}

export type InstallMode = "global" | "local" | "unknown";

export interface InstallInfo {
  mode: InstallMode;
  // For "local" mode: the project directory that has flockctl in its node_modules.
  // For "global": the npm prefix root (parent of node_modules). For "unknown": undefined.
  root?: string;
}

let cachedInstall: InstallInfo | null = null;

// Detect how this daemon was installed by walking up from its own package root.
// - ".../node_modules/flockctl/package.json" with a project package.json two levels up → local
// - ".../lib/node_modules/flockctl/package.json" with no package.json two levels up → global
// - anything else (e.g. running from source, worktrees, npx cache) → unknown
export function getInstallInfo(): InstallInfo {
  if (cachedInstall) return cachedInstall;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgRoot = join(here, "..", ".."); // src|dist/lib/... → package root
    const parentDir = dirname(pkgRoot);
    /* v8 ignore next — the else-path ("parentDir IS node_modules") only fires
     * when flockctl is a real local dep or `npm i -g`; tests always run from
     * source so parentDir is never "node_modules". */
    if (basename(parentDir) !== "node_modules") {
      cachedInstall = { mode: "unknown" };
      return cachedInstall;
    }
    /* v8 ignore start — the body below is reachable only via the else-path
     * we ignored just above; blanket-ignore everything until we return. */
    const installParent = dirname(parentDir);
    if (existsSync(join(installParent, "package.json"))) {
      cachedInstall = { mode: "local", root: installParent };
    } else {
      cachedInstall = { mode: "global", root: installParent };
    }
    /* v8 ignore stop */
  } catch {
    cachedInstall = { mode: "unknown" };
  }
  return cachedInstall;
}

// Compare two semver strings. Returns true if a > b.
export function semverGt(a: string, b: string): boolean {
  const parse = (v: string): { core: number[]; pre: string } => {
    const [core = "", pre] = v.split("-", 2);
    const parts = core.split(".").map((n) => Number(n) || 0);
    while (parts.length < 3) parts.push(0);
    return { core: parts, pre: pre ?? "" };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    /* v8 ignore start — parse() pads core to 3 entries, so ?? 0 only fires
       for a pathological shape (negative index). Kept as TS null-safety glue. */
    const av = pa.core[i] ?? 0;
    const bv = pb.core[i] ?? 0;
    /* v8 ignore stop */
    if (av !== bv) return av > bv;
  }
  // Core equal. A release (no prerelease) outranks any prerelease.
  if (pa.pre === pb.pre) return false;
  if (pa.pre === "") return true;
  if (pb.pre === "") return false;
  return pa.pre > pb.pre;
}
