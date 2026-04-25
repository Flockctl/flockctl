import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { app } from "../../server.js";
import * as config from "../../config/index.js";
import { _resetRateLimiter } from "../../middleware/remote-auth.js";

// The route resolves the jail anchor via os.homedir(), which on POSIX honors
// $HOME. We point $HOME at a disposable temp directory for every test so the
// route operates on a well-known, tiny filesystem we control — the developer's
// real home directory is never touched.
let fakeHome: string;
let outsideDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  // fakeHome and outsideDir are siblings under a shared base so outsideDir
  // is guaranteed NOT to sit inside fakeHome — that's what makes the escape
  // tests meaningful.
  const base = mkdtempSync(join(tmpdir(), "flockctl-fs-test-"));
  fakeHome = join(base, "home");
  outsideDir = join(base, "outside");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  try {
    const base = join(fakeHome, "..");
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("GET /fs/browse — happy path", () => {
  it("lists $HOME by default and sorts directories before files", async () => {
    mkdirSync(join(fakeHome, "projects"));
    mkdirSync(join(fakeHome, "aardvark"));
    writeFileSync(join(fakeHome, "zfile.txt"), "z");
    writeFileSync(join(fakeHome, "afile.txt"), "a");

    const res = await app.request("/fs/browse");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      parent: string | null;
      entries: Array<{
        name: string;
        isDirectory: boolean;
        isSymlink: boolean;
        isHidden: boolean;
      }>;
      truncated: boolean;
    };

    // realpath may canonicalize /private/var → /var on macOS, so compare via
    // a realpath round-trip instead of the raw fakeHome string.
    const realFs = await import("fs/promises");
    const realFakeHome = await realFs.realpath(fakeHome);
    expect(body.path).toBe(realFakeHome);
    expect(body.parent).toBeNull();
    expect(body.truncated).toBe(false);

    const names = body.entries.map((e) => e.name);
    expect(names).toEqual(["aardvark", "projects", "afile.txt", "zfile.txt"]);
    expect(body.entries[0].isDirectory).toBe(true);
    expect(body.entries[2].isDirectory).toBe(false);
    expect(body.entries.every((e) => !e.isHidden)).toBe(true);
  });

  it("browses a nested directory inside $HOME and sets parent correctly", async () => {
    const sub = join(fakeHome, "workspace");
    mkdirSync(sub);
    writeFileSync(join(sub, "readme.md"), "# hi");

    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(sub)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      parent: string | null;
      entries: Array<{ name: string }>;
    };
    expect(body.parent).not.toBeNull();
    expect(body.entries.map((e) => e.name)).toEqual(["readme.md"]);
  });

  it("hides dotfiles by default and reveals them when show_hidden=1", async () => {
    writeFileSync(join(fakeHome, ".env"), "SECRET=1");
    writeFileSync(join(fakeHome, "visible.txt"), "ok");

    const hidden = await (await app.request("/fs/browse")).json();
    expect(hidden.entries.map((e: any) => e.name)).toEqual(["visible.txt"]);

    const shown = await (
      await app.request("/fs/browse?show_hidden=1")
    ).json();
    const names = shown.entries.map((e: any) => e.name);
    expect(names).toContain(".env");
    expect(names).toContain("visible.txt");
    const env = shown.entries.find((e: any) => e.name === ".env");
    expect(env.isHidden).toBe(true);
  });

  it("reports symlinks via isSymlink without following the target name", async () => {
    const target = join(fakeHome, "target-dir");
    mkdirSync(target);
    writeFileSync(join(target, "inner.txt"), "x");
    symlinkSync(target, join(fakeHome, "link-to-target"));

    const res = await app.request("/fs/browse");
    const body = await res.json();
    const link = body.entries.find((e: any) => e.name === "link-to-target");
    expect(link).toBeDefined();
    expect(link.isSymlink).toBe(true);
    // Target is a directory so the UI can sort it with directories.
    expect(link.isDirectory).toBe(true);
  });
});

describe("GET /fs/browse — jail enforcement", () => {
  it("returns 403 when the resolved path is outside $HOME", async () => {
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(outsideDir)}`,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/outside/i);
  });

  it("returns 403 when a symlink inside $HOME escapes via realpath", async () => {
    // Symlink in $HOME pointing OUTSIDE $HOME. path.resolve keeps us inside
    // (the symlink path itself lives in $HOME), but fs.realpath pops out → 403.
    const escapeLink = join(fakeHome, "escape");
    symlinkSync(outsideDir, escapeLink);

    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(escapeLink)}`,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/outside/i);
  });

  it("rejects absolute paths like /etc with 403", async () => {
    const res = await app.request("/fs/browse?path=/etc");
    expect(res.status).toBe(403);
  });
});

describe("GET /fs/browse — input validation", () => {
  it("returns 400 when the path points at a regular file", async () => {
    const filePath = join(fakeHome, "notes.txt");
    writeFileSync(filePath, "hello");
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(filePath)}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not a directory/i);
  });

  it("returns 404 when the path does not exist", async () => {
    const missing = join(fakeHome, "does-not-exist");
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(missing)}`,
    );
    expect(res.status).toBe(404);
  });

  it("treats non-numeric show_hidden as falsy (dotfiles stay hidden)", async () => {
    writeFileSync(join(fakeHome, ".hidden"), "x");
    writeFileSync(join(fakeHome, "visible.txt"), "y");

    for (const q of ["yes", "true", "0", "", "banana"]) {
      const res = await app.request(`/fs/browse?show_hidden=${q}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      const names = body.entries.map((e: any) => e.name);
      expect(names).not.toContain(".hidden");
      expect(names).toContain("visible.txt");
    }
  });

  it("treats empty ?path= as the default ($HOME)", async () => {
    writeFileSync(join(fakeHome, "marker.txt"), "x");
    const res = await app.request("/fs/browse?path=");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries.map((e: any) => e.name)).toContain("marker.txt");
  });
});

describe("GET /fs/browse — truncation", () => {
  it("caps entries at 500 and sets truncated=true", async () => {
    for (let i = 0; i < 510; i++) {
      writeFileSync(join(fakeHome, `file-${String(i).padStart(4, "0")}.txt`), "");
    }
    const res = await app.request("/fs/browse");
    const body = await res.json();
    expect(body.entries).toHaveLength(500);
    expect(body.truncated).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Loopback-only enforcement. When remote access is turned on, the filesystem
// browser is one of the few endpoints the bearer token is NOT meant to grant
// — even a legitimate remote caller must be blocked so the token cannot be
// used to enumerate $HOME from off-box.
// ────────────────────────────────────────────────────────────────────────────

const VALID_TOKEN = "0123456789abcdef0123456789abcdef0123";

function remoteEnv(ip = "203.0.113.7") {
  return {
    incoming: { socket: { remoteAddress: ip } },
  } as unknown as Record<string, unknown>;
}

function localhostEnv() {
  return {
    incoming: { socket: { remoteAddress: "127.0.0.1" } },
  } as unknown as Record<string, unknown>;
}

describe("GET /fs/browse — loopback-only gate", () => {
  beforeEach(() => {
    _resetRateLimiter();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 403 to a remote caller holding a valid bearer token", async () => {
    vi.spyOn(config, "hasRemoteAuth").mockReturnValue(true);
    vi.spyOn(config, "findMatchingToken").mockImplementation((provided) =>
      provided === VALID_TOKEN ? { label: "phone" } : null,
    );

    const res = await app.request(
      "/fs/browse",
      { headers: { authorization: `Bearer ${VALID_TOKEN}` } },
      remoteEnv(),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "endpoint is loopback-only" });
  });

  it("still serves localhost callers when remote auth is on", async () => {
    vi.spyOn(config, "hasRemoteAuth").mockReturnValue(true);
    vi.spyOn(config, "findMatchingToken").mockReturnValue({ label: "default" });

    writeFileSync(join(fakeHome, "marker.txt"), "x");
    const res = await app.request("/fs/browse", {}, localhostEnv());
    expect(res.status).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Fuzz-style route tests. We hurl a grab-bag of hostile ?path= values at the
// browser and assert on the *class* of response — 200/400/403/404 are all
// acceptable outcomes; 500 and missing response are NOT. The goal is to make
// sure no pathological input (encoded traversal, NUL bytes, CRLF injection,
// absurdly long strings) takes down the handler or leaks stack traces.
// ────────────────────────────────────────────────────────────────────────────

describe("GET /fs/browse — fuzz-style path inputs", () => {
  // A seeded LCG — deterministic so failures are reproducible but still
  // covering a wide span of weird byte sequences.
  function makeRng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  function randomWeirdPath(rng: () => number): string {
    const kinds = [
      // Encoded directory traversal variants.
      () => "/%2e%2e%2f".repeat(1 + Math.floor(rng() * 10)),
      () => "../".repeat(1 + Math.floor(rng() * 20)) + "etc/passwd",
      () => "/..;/..;/etc",
      () => "\u002e\u002e/".repeat(Math.floor(rng() * 6)) + "etc",
      // NUL-byte smuggling.
      () => fakeHome + "\u0000/etc/passwd",
      () => "/etc/passwd\u0000" + fakeHome,
      // CRLF injection.
      () => "/tmp\r\nX-Injected: 1",
      () => fakeHome + "\r\nEvil",
      // Unicode control / zero-width characters.
      () => fakeHome + "\u200b" + "foo",
      () => "/" + String.fromCodePoint(0x202e) + "etc",
      // Extremely long paths (>4096 chars, > PATH_MAX on Linux).
      () => "/" + "a".repeat(4097 + Math.floor(rng() * 2048)),
      () => fakeHome + "/" + "b".repeat(5000),
      // Windows-style drive letters on POSIX — pure garbage to path.resolve.
      () => "C:\\Windows\\System32",
      () => "\\\\?\\C:\\Users",
      // Absolute escape attempts.
      () => "/etc",
      () => "/var/log/system.log",
      () => "/proc/1/root",
      // Random printable garbage.
      () => {
        const len = 1 + Math.floor(rng() * 64);
        let s = "";
        for (let i = 0; i < len; i++) {
          s += String.fromCharCode(32 + Math.floor(rng() * 95));
        }
        return s;
      },
      // Random bytes as percent-encoded garbage.
      () => {
        const len = 1 + Math.floor(rng() * 64);
        let s = "";
        for (let i = 0; i < len; i++) {
          s +=
            "%" +
            Math.floor(rng() * 256)
              .toString(16)
              .padStart(2, "0");
        }
        return s;
      },
    ];
    return kinds[Math.floor(rng() * kinds.length)]();
  }

  it("never returns 500 across 100 hostile path inputs", async () => {
    // Populate $HOME with a handful of entries so 200-responses are realistic
    // when the fuzzer happens to generate a benign path.
    mkdirSync(join(fakeHome, "projects"));
    writeFileSync(join(fakeHome, "a.txt"), "a");

    const rng = makeRng(0xc0ffee);
    const observedStatuses = new Set<number>();
    const failures: Array<{ path: string; status: number; body: unknown }> = [];

    for (let i = 0; i < 100; i++) {
      const weird = randomWeirdPath(rng);
      // Build the URL manually — a raw query string is what a real attacker
      // would send, and lets us smuggle bytes that encodeURIComponent would
      // normalize away.
      let url: string;
      try {
        url = `/fs/browse?path=${encodeURIComponent(weird)}`;
      } catch {
        // encodeURIComponent can't fail on a string, but belt + braces.
        continue;
      }

      let res: Response;
      try {
        res = await app.request(url);
      } catch (err) {
        failures.push({ path: weird, status: -1, body: String(err) });
        continue;
      }

      observedStatuses.add(res.status);

      // Acceptable outcomes only: existing dir under $HOME → 200;
      // bad shape → 400; jail violation or permission denied → 403;
      // missing path → 404. Anything else (esp. 500, 502, 503) is a bug.
      const allowed = new Set([200, 400, 403, 404]);
      if (!allowed.has(res.status)) {
        let body: unknown;
        try {
          body = await res.clone().json();
        } catch {
          body = await res.clone().text();
        }
        failures.push({ path: weird, status: res.status, body });
        continue;
      }

      // When we DO get a body, it must be JSON-parseable — no raw HTML
      // error pages leaking from the framework.
      if (res.status !== 200) {
        const body = (await res.json()) as { error?: unknown };
        expect(typeof body.error).toBe("string");
      }
    }

    if (failures.length > 0) {
      // Surface the first offender so the failure message is actionable.
      throw new Error(
        `fuzz: unexpected responses (${failures.length}): ` +
          JSON.stringify(failures.slice(0, 3)),
      );
    }
    // Sanity: we should have hit more than one status class across 100
    // attempts — if every response is 403 we're not really exploring, and if
    // every response is 200 the jail isn't doing anything.
    expect(observedStatuses.size).toBeGreaterThan(1);
  });

  it("handles a single 10 000-character path without blowing up", async () => {
    const huge = "/" + "x".repeat(10_000);
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(huge)}`,
    );
    expect([400, 403, 404]).toContain(res.status);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("handles a NUL-byte smuggled path cleanly (no 500)", async () => {
    const p = fakeHome + "\u0000/etc/passwd";
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(p)}`,
    );
    // Node's fs calls throw ERR_INVALID_ARG_VALUE for NUL bytes, which
    // bubbles up as a stat/realpath error — the handler must still produce
    // a structured JSON response rather than a 500.
    expect([200, 400, 403, 404]).toContain(res.status);
  });

  it("handles CRLF in ?path= without echoing the header bytes", async () => {
    const injected = fakeHome + "\r\nX-Injected: pwn";
    const res = await app.request(
      `/fs/browse?path=${encodeURIComponent(injected)}`,
    );
    expect([200, 400, 403, 404]).toContain(res.status);
    // Whatever happens, we must not have grown an X-Injected response header.
    expect(res.headers.get("x-injected")).toBeNull();
  });
});
