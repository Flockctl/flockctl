/**
 * Shared harness — spawns a real flockctl server on a free port with an
 * isolated FLOCKCTL_HOME, waits for readiness, and hands back base URL + kill.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

export interface SmokeServer {
  baseUrl: string;
  home: string;
  stop: () => Promise<void>;
}

async function pickFreePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    // Bind explicitly to 127.0.0.1 so the port we claim is the same one the
    // daemon will bind to (server.ts defaults to 127.0.0.1). Without the
    // explicit host, listen(0) binds to all interfaces, which has caused
    // confusing port-collision symptoms on CI runners.
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => res(port));
      } else {
        srv.close();
        rej(new Error("could not get port"));
      }
    });
  });
}

export async function startFlockctl(extraEnv: NodeJS.ProcessEnv = {}): Promise<SmokeServer> {
  const port = await pickFreePort();
  const home = mkdtempSync(join(tmpdir(), "flockctl-smoke-"));
  const repoRoot = resolve(new URL(".", import.meta.url).pathname, "..", "..");

  // Spawn `tsx` directly (not via `npx`) so the daemon's PID is the Node
  // process — keeps signal forwarding deterministic on Linux CI runners and
  // skips the npx cold-start hop that can blow past our readiness deadline.
  const tsxBin = resolve(repoRoot, "node_modules/.bin/tsx");
  const child: ChildProcess = spawn(
    tsxBin,
    [join(repoRoot, "src/server-entry.ts"), "--port", String(port)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FLOCKCTL_HOME: home,
        FLOCKCTL_MOCK_AI: "1",
        ...extraEnv,
      },
      // Spawn from an arbitrary cwd (the isolated FLOCKCTL_HOME, which is
      // never the package root). This is load-bearing: the daemon resolves
      // bundled assets (drizzle migrations, skill manifests, …) relative to
      // their own module URL, NOT relative to process.cwd(). When that
      // contract was ever broken, smoke tests that ran with cwd=repoRoot
      // happened to pass because "./migrations" coincidentally resolved
      // against the repo. Spawning from `home` guarantees that any future
      // cwd-relative regression fails CI before it ships to npm.
      cwd: home,
    },
  );

  let stdoutBuf = "";
  child.stdout?.on("data", (d) => {
    stdoutBuf += d.toString();
  });
  child.stderr?.on("data", (d) => {
    stdoutBuf += d.toString();
  });

  // Use 127.0.0.1 directly — `localhost` resolution can prefer IPv6 [::1]
  // on some Linux CI runners while the daemon binds IPv4 only, leading to
  // a hung connect that masquerades as a slow startup.
  const baseUrl = `http://127.0.0.1:${port}`;
  // 25 s deadline — covers `tsx` cold-start + DB migrations + Hono boot on
  // a cold CI runner. On a warm dev machine this resolves in < 2 s.
  const deadlineMs = 25_000;
  const deadline = Date.now() + deadlineMs;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) {
        healthy = true;
        break;
      }
    } catch {
      // not ready yet
    }
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode}):\n${stdoutBuf}`);
    }
    await new Promise((res) => setTimeout(res, 150));
  }
  if (!healthy) {
    // Daemon never answered /health within the deadline. Kill it to free
    // the port + tmp dir, then surface the captured logs so CI failures
    // are diagnosable instead of mysterious 30 s timeouts.
    if (child.exitCode === null) child.kill("SIGKILL");
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw new Error(
      `server did not answer /health within ${deadlineMs}ms (port ${port}):\n--- captured stdout/stderr ---\n${stdoutBuf || "(empty)"}`,
    );
  }

  return {
    baseUrl,
    home,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((res) => setTimeout(res, 300));
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/**
 * Create an active AI provider key via the HTTP API and return its ID.
 *
 * `_allowed-keys.ts` requires at least one active key in `allowedKeyIds`
 * whenever a workspace or project is created, so every smoke test that
 * exercises those endpoints must seed one first.
 */
export async function seedActiveKey(srv: SmokeServer): Promise<number> {
  const res = await fetch(`${srv.baseUrl}/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "anthropic",
      providerType: "api-key",
      label: "smoke-key",
      keyValue: "sk-ant-api-smoke",
      isActive: true,
    }),
  });
  assert(res.status === 201, `seedActiveKey: POST /keys failed (${res.status})`);
  const key = (await res.json()) as { id: number };
  return key.id;
}
