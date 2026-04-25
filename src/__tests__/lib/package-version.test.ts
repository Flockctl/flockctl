import { describe, it, expect } from "vitest";
import {
  getPackageName,
  getPackageVersion,
  getInstallInfo,
  semverGt,
} from "../../lib/package-version.js";

// These helpers cache their computed values on first call. We don't try to
// unstick that cache here — the default "run from source" topology gives us
// deterministic values that are sufficient to cover every reachable branch
// in the parser/compare paths (the install-path branches are v8-ignored
// because they only fire under real npm-installed layouts).

describe("package-version basics", () => {
  it("getPackageVersion returns a semver-shaped string", () => {
    const v = getPackageVersion();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
    // Not "unknown" in the in-tree run — proves the happy path through
    // loadPackageMeta() actually read package.json.
    expect(v).not.toBe("unknown");
  });

  it("getPackageName returns the bundled name", () => {
    expect(getPackageName()).toBe("flockctl");
  });

  it("cached: second call returns the same object reference (via value)", () => {
    expect(getPackageVersion()).toBe(getPackageVersion());
    expect(getPackageName()).toBe(getPackageName());
  });
});

describe("getInstallInfo", () => {
  it("returns 'unknown' mode when running from source tree", () => {
    // In the test environment the file lives at src/lib/package-version.ts,
    // so walking two levels up lands on the project root (not a node_modules
    // parent). That's the "unknown" branch — exercises the basename !==
    // "node_modules" guard that closes the function early.
    const info = getInstallInfo();
    expect(info.mode).toBe("unknown");
    expect(info.root).toBeUndefined();
  });

  it("is cached — repeated calls return structurally equal info", () => {
    const a = getInstallInfo();
    const b = getInstallInfo();
    expect(a).toEqual(b);
  });
});

describe("semverGt", () => {
  it("returns true when major is greater", () => {
    expect(semverGt("2.0.0", "1.9.9")).toBe(true);
  });

  it("returns false when major is lesser", () => {
    expect(semverGt("1.0.0", "2.0.0")).toBe(false);
  });

  it("compares minor when majors tie", () => {
    expect(semverGt("1.2.0", "1.1.9")).toBe(true);
    expect(semverGt("1.1.0", "1.2.0")).toBe(false);
  });

  it("compares patch when major/minor tie", () => {
    expect(semverGt("1.1.5", "1.1.4")).toBe(true);
    expect(semverGt("1.1.3", "1.1.4")).toBe(false);
  });

  it("treats a release as greater than a prerelease with the same core", () => {
    expect(semverGt("1.0.0", "1.0.0-beta.1")).toBe(true);
    expect(semverGt("1.0.0-beta.1", "1.0.0")).toBe(false);
  });

  it("compares prerelease strings lexically when cores tie", () => {
    expect(semverGt("1.0.0-beta", "1.0.0-alpha")).toBe(true);
    expect(semverGt("1.0.0-alpha", "1.0.0-beta")).toBe(false);
  });

  it("returns false for exactly equal versions", () => {
    expect(semverGt("1.2.3", "1.2.3")).toBe(false);
    expect(semverGt("1.2.3-rc.1", "1.2.3-rc.1")).toBe(false);
  });

  it("pads short version strings with zeros", () => {
    expect(semverGt("2", "1.9.9")).toBe(true);
    expect(semverGt("1.5", "1.4.9")).toBe(true);
  });

  it("treats non-numeric segments as zero (defensive)", () => {
    // parse() uses Number() || 0 — anything non-numeric becomes 0.
    expect(semverGt("x.y.z", "0.0.0")).toBe(false);
    expect(semverGt("1.0.0", "x.y.z")).toBe(true);
  });
});
