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
    srv.listen(0, () => {
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

  const child: ChildProcess = spawn(
    "npx",
    ["tsx", join(repoRoot, "src/server-entry.ts"), "--port", String(port)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FLOCKCTL_HOME: home,
        FLOCKCTL_MOCK_AI: "1",
        ...extraEnv,
      },
      cwd: repoRoot,
    },
  );

  let stdoutBuf = "";
  child.stdout?.on("data", (d) => {
    stdoutBuf += d.toString();
  });
  child.stderr?.on("data", (d) => {
    stdoutBuf += d.toString();
  });

  const baseUrl = `http://localhost:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) break;
    } catch {
      // not ready yet
    }
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode}):\n${stdoutBuf}`);
    }
    await new Promise((res) => setTimeout(res, 150));
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
