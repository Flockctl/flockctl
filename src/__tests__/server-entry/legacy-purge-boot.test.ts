import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

// Integration test: spawn the real `server-entry.ts` with an isolated HOME
// (where `~/.flockctlrc` lives) and FLOCKCTL_HOME (where the SQLite DB
// lives), seed a legacy direct-HTTP remote-server entry, and confirm the
// purge step runs at boot — i.e. the warning is emitted AND the rc file is
// rewritten before the HTTP server starts accepting requests.

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
        rej(new Error("could not get free port"));
      }
    });
  });
}

const repoRoot = resolve(new URL(".", import.meta.url).pathname, "..", "..", "..");

interface Booted {
  child: ChildProcess;
  home: string;
  rcPath: string;
  stderrBuf: { value: string };
  stdoutBuf: { value: string };
}

const active: Booted[] = [];

async function bootWithSeededRc(rcContent: string): Promise<Booted> {
  const home = mkdtempSync(join(tmpdir(), "flockctl-purge-boot-"));
  const rcPath = join(home, ".flockctlrc");
  writeFileSync(rcPath, rcContent);

  const port = await pickFreePort();
  const child = spawn(
    "npx",
    ["tsx", join(repoRoot, "src/server-entry.ts"), "--port", String(port)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        FLOCKCTL_HOME: home,
        FLOCKCTL_MOCK_AI: "1",
      },
      cwd: repoRoot,
    },
  );

  const stderrBuf = { value: "" };
  const stdoutBuf = { value: "" };
  child.stderr?.on("data", (d) => {
    stderrBuf.value += d.toString();
  });
  child.stdout?.on("data", (d) => {
    stdoutBuf.value += d.toString();
  });

  const booted: Booted = { child, home, rcPath, stderrBuf, stdoutBuf };
  active.push(booted);

  // Wait for either the purge log line to land OR the server to answer
  // /health — whichever comes first is sufficient proof that the boot
  // sequence ran past purgeLegacyRemoteServers().
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 18_000;
  while (Date.now() < deadline) {
    if (stderrBuf.value.includes("Removed ") || stdoutBuf.value.includes("Removed ")) {
      // give the subsequent synchronous saveRc() a beat to flush
      await new Promise((r) => setTimeout(r, 50));
      break;
    }
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) break;
    } catch {
      /* not ready */
    }
    if (child.exitCode !== null) {
      throw new Error(
        `server-entry exited early (${child.exitCode})\n--- stderr ---\n${stderrBuf.value}\n--- stdout ---\n${stdoutBuf.value}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return booted;
}

afterEach(async () => {
  while (active.length > 0) {
    const b = active.pop()!;
    if (b.child.exitCode === null) {
      b.child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      if (b.child.exitCode === null) b.child.kill("SIGKILL");
    }
    try {
      rmSync(b.home, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe("server-entry legacy remote-server purge at boot", () => {
  it(
    "drops legacy direct-HTTP entries and logs the removal without leaking tokens",
    async () => {
      const LEAKED_TOKEN = "boot-SECRET-TOKEN-shouldNotAppear-12345";
      const booted = await bootWithSeededRc(
        JSON.stringify({
          remoteServers: [
            {
              id: "legacy-1",
              name: "old-prod",
              url: "https://prod.example",
              token: LEAKED_TOKEN,
            },
            {
              id: "modern-1",
              name: "new-prod",
              ssh: { host: "user@new.example" },
            },
          ],
        }),
      );

      const combinedLogs = booted.stderrBuf.value + booted.stdoutBuf.value;
      expect(combinedLogs).toMatch(/Removed 1 legacy remote server/);
      expect(combinedLogs).toContain("old-prod");
      // Secret must NEVER appear in logs.
      expect(combinedLogs).not.toContain(LEAKED_TOKEN);

      const saved = JSON.parse(readFileSync(booted.rcPath, "utf-8"));
      expect(saved.remoteServers).toHaveLength(1);
      expect(saved.remoteServers[0].name).toBe("new-prod");
      expect(saved.remoteServers[0].ssh.host).toBe("user@new.example");
    },
    25_000,
  );

  it(
    "leaves a clean rc file untouched",
    async () => {
      const rcContent = JSON.stringify({
        remoteServers: [
          { id: "ok-1", name: "prod", ssh: { host: "user@prod.example" } },
        ],
      });
      const booted = await bootWithSeededRc(rcContent);

      const combinedLogs = booted.stderrBuf.value + booted.stdoutBuf.value;
      expect(combinedLogs).not.toMatch(/Removed \d+ legacy remote server/);

      const saved = JSON.parse(readFileSync(booted.rcPath, "utf-8"));
      expect(saved.remoteServers).toHaveLength(1);
      expect(saved.remoteServers[0].name).toBe("prod");
    },
    25_000,
  );
});
