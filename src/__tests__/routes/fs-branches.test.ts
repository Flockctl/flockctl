/**
 * Branch-coverage top-up for src/routes/fs.ts.
 *
 * The base fs.test.ts suite exercises the happy paths, a large fuzz,
 * and the jail / input-validation branches. This file fills in the
 * specific errno-discriminator branches that the fuzz doesn't reliably
 * hit: ELOOP, EINVAL, ERR_INVALID_ARG_VALUE, ERR_INVALID_ARG_TYPE, and
 * the 500-fallthrough cases for realpath / lstat / readdir.
 *
 * We stub individual `fs/promises` calls via `vi.spyOn` so we can
 * deterministically surface any errno without coordinating a real
 * filesystem condition (symlink loops are tricky inside a temp tree
 * that `beforeEach` rebuilds, and ERR_INVALID_ARG_* only surfaces for
 * some Node versions / call shapes).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import fsp from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { app } from "../../server.js";

let fakeHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "flockctl-fs-branches-"));
  fakeHome = join(base, "home");
  mkdirSync(fakeHome, { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  try {
    rmSync(join(fakeHome, ".."), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Build an errno-like Error that node's filesystem layer would throw. */
function errnoError(code: string, message = `simulated ${code}`): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe("GET /fs/browse — realpath error-code branches", () => {
  it("maps ELOOP to 400 Invalid path", async () => {
    vi.spyOn(fsp, "realpath").mockImplementation(async (p: any) => {
      // The initial homedir realpath (canonicalHome) must succeed — only
      // the per-request resolve should fail. Detect by calling shape.
      if (typeof p === "string" && p.includes("loop-target")) {
        throw errnoError("ELOOP", "too many levels of symlinks");
      }
      // fall through to the real implementation via the un-spied copy
      return p as unknown as string;
    });

    const target = join(fakeHome, "loop-target");
    mkdirSync(target);
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid path/i);
  });

  it("maps EINVAL to 400 Invalid path", async () => {
    vi.spyOn(fsp, "realpath").mockImplementation(async (p: any) => {
      if (typeof p === "string" && p.includes("einval-target")) {
        throw errnoError("EINVAL", "invalid argument");
      }
      return p as unknown as string;
    });

    const target = join(fakeHome, "einval-target");
    mkdirSync(target);
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(400);
  });

  it("maps ERR_INVALID_ARG_VALUE to 400 Invalid path", async () => {
    vi.spyOn(fsp, "realpath").mockImplementation(async (p: any) => {
      if (typeof p === "string" && p.includes("bad-arg-val")) {
        throw errnoError("ERR_INVALID_ARG_VALUE", "invalid value");
      }
      return p as unknown as string;
    });

    const target = join(fakeHome, "bad-arg-val");
    mkdirSync(target);
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(400);
  });

  it("maps ERR_INVALID_ARG_TYPE to 400 Invalid path", async () => {
    vi.spyOn(fsp, "realpath").mockImplementation(async (p: any) => {
      if (typeof p === "string" && p.includes("bad-arg-type")) {
        throw errnoError("ERR_INVALID_ARG_TYPE", "invalid arg type");
      }
      return p as unknown as string;
    });

    const target = join(fakeHome, "bad-arg-type");
    mkdirSync(target);
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(400);
  });

  it("maps EACCES to 403 Permission denied", async () => {
    vi.spyOn(fsp, "realpath").mockImplementation(async (p: any) => {
      if (typeof p === "string" && p.includes("no-perm")) {
        throw errnoError("EACCES", "permission denied");
      }
      return p as unknown as string;
    });
    const target = join(fakeHome, "no-perm");
    mkdirSync(target);
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/permission denied/i);
  });

  it("maps an unknown realpath errno to 500 with the error message", async () => {
    vi.spyOn(fsp, "realpath").mockImplementation(async (p: any) => {
      if (typeof p === "string" && p.includes("eio-target")) {
        throw errnoError("EIO", "IO boom");
      }
      return p as unknown as string;
    });
    const target = join(fakeHome, "eio-target");
    mkdirSync(target);
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("IO boom");
  });

  it("uses a generic message when the error carries no message", async () => {
    vi.spyOn(fsp, "realpath").mockImplementation(async (p: any) => {
      if (typeof p === "string" && p.includes("nomsg-target")) {
        const e = errnoError("EIO");
        e.message = "";
        throw e;
      }
      return p as unknown as string;
    });
    const target = join(fakeHome, "nomsg-target");
    mkdirSync(target);
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to resolve path");
  });
});

describe("GET /fs/browse — lstat error-code branches", () => {
  // realpath succeeds (default real impl), lstat is the failing call.

  it("maps ENAMETOOLONG to 400 Invalid path", async () => {
    const target = join(fakeHome, "lstat-nametoolong");
    mkdirSync(target);
    vi.spyOn(fsp, "lstat").mockImplementation(async () => {
      throw errnoError("ENAMETOOLONG");
    });
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(400);
  });

  it("maps EACCES to 403 Permission denied", async () => {
    const target = join(fakeHome, "lstat-eacces");
    mkdirSync(target);
    vi.spyOn(fsp, "lstat").mockImplementation(async () => {
      throw errnoError("EACCES", "no lstat for you");
    });
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(403);
  });

  it("maps ENOENT to 404 Path not found", async () => {
    const target = join(fakeHome, "lstat-enoent");
    mkdirSync(target);
    vi.spyOn(fsp, "lstat").mockImplementation(async () => {
      throw errnoError("ENOENT");
    });
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(404);
  });

  it("maps an unknown lstat errno to 500", async () => {
    const target = join(fakeHome, "lstat-eio");
    mkdirSync(target);
    vi.spyOn(fsp, "lstat").mockImplementation(async () => {
      throw errnoError("EIO", "lstat IO boom");
    });
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("lstat IO boom");
  });

  it("uses a generic message when lstat error has no message", async () => {
    const target = join(fakeHome, "lstat-nomsg");
    mkdirSync(target);
    vi.spyOn(fsp, "lstat").mockImplementation(async () => {
      const e = errnoError("EIO");
      e.message = "";
      throw e;
    });
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to stat path");
  });
});

describe("GET /fs/browse — readdir error-code branches", () => {
  it("maps EACCES from readdir to 403 Permission denied", async () => {
    const target = join(fakeHome, "readdir-eacces");
    mkdirSync(target);
    vi.spyOn(fsp, "readdir").mockImplementation(async () => {
      throw errnoError("EACCES", "cannot list");
    });
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(403);
  });

  it("maps an unknown readdir errno to 500", async () => {
    const target = join(fakeHome, "readdir-eio");
    mkdirSync(target);
    vi.spyOn(fsp, "readdir").mockImplementation(async () => {
      throw errnoError("EIO", "readdir IO boom");
    });
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("readdir IO boom");
  });

  it("uses a generic message when readdir error has no message", async () => {
    const target = join(fakeHome, "readdir-nomsg");
    mkdirSync(target);
    vi.spyOn(fsp, "readdir").mockImplementation(async () => {
      const e = errnoError("EIO");
      e.message = "";
      throw e;
    });
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to read directory");
  });
});

describe("GET /fs/browse — canonical home fallback", () => {
  it("handles a realpath failure on rawHome by falling back to rawHome", async () => {
    // Make ONLY the first realpath call (on rawHome during canonicalHome
    // bootstrap) fail. The handler must NOT 500 — it silently falls back
    // to rawHome and still serves the directory on a subsequent realpath
    // of the resolved request path.
    writeFileSync(join(fakeHome, "marker.txt"), "ok");
    const realRealpath = fsp.realpath.bind(fsp);
    let callCount = 0;
    vi.spyOn(fsp, "realpath").mockImplementation(async (p: any) => {
      callCount++;
      if (callCount === 1) {
        throw errnoError("ENOENT", "home vanished");
      }
      return realRealpath(p);
    });

    const res = await app.request("/fs/browse");
    // The first realpath threw → canonicalHome fell back to rawHome.
    // On macOS the second realpath resolves /var → /private/var so the
    // post-realpath jail check 403s; on Linux it passes and returns 200.
    // Either outcome exercises the fallback branch.
    expect([200, 403]).toContain(res.status);
  });
});
