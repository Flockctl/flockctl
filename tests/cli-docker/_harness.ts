/**
 * CLI-Docker test harness.
 *
 * Spins up the `flockctl-cli-test:local` image in a detached container,
 * exposes an `exec` helper that wraps every CLI invocation with `c8`
 * (so coverage is collected for each `dist/cli.js` run), and cleans
 * up on exit — copying the in-container c8 output tree back to the
 * host before removing the container.
 *
 * Modeled on tests/smoke/_harness.ts but talks to docker instead of
 * spawning the server in-process.
 *
 * Coverage flow:
 *   1. Container env: NODE_V8_COVERAGE=/flockctl-home/nyc_output so any
 *      Node process inside (including the detached daemon that `flockctl
 *      start` spawns) dumps raw v8 coverage there.
 *   2. Each `ctx.exec` prepends
 *        c8 --reporter=json --reports-dir=/flockctl-home/c8/<id> \
 *            --temp-directory=/flockctl-home/v8-raw/<id> --clean=false
 *      so the CLI invocation itself produces an istanbul coverage-final.json
 *      in a per-invocation subdir AND keeps the raw v8 files in a unique
 *      temp dir (so they don't get cleaned and accumulate across runs).
 *   3. On teardown the harness `docker cp`s /flockctl-home/c8 AND
 *      /flockctl-home/v8-raw out to coverage/cli-docker/<containerName>/
 *      on the host. The runner (run.ts):
 *        - merges the istanbul outputs into a single coverage-final.json
 *          (used by ad-hoc tooling),
 *        - rewrites the URL field of every raw v8 file (`/app/dist/...`
 *          → host `<repoRoot>/dist/...`) and runs `c8 check-coverage`
 *          against the rewritten dir to enforce the 100% gate (the host
 *          has dist/ + source maps, so the report remaps to src/).
 */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const IMAGE_TAG = "flockctl-cli-test:local";
const CONTAINER_INTERNAL_PORT = 52077;
const HEALTH_TIMEOUT_MS = 20_000;
const DAEMON_URL_INTERNAL = `http://127.0.0.1:${CONTAINER_INTERNAL_PORT}`;
const DOCKER_INSTALL_URL = "https://docs.docker.com/engine/install/";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
// Host output root. run.ts reads from here to merge.
export const HOST_COVERAGE_DIR = resolve(repoRoot, "coverage", "cli-docker");
// Host-side fixtures directory. When present it's mounted read-only at
// /fixtures in the container so tests can seed sample trees without baking
// them into the image. Individual tests copy the subtree they need out to
// a writable location under /flockctl-home before touching it (e.g. to run
// `git init`), since /fixtures is read-only.
const HOST_FIXTURES_DIR = resolve(here, "fixtures");

export interface ExecOptions {
  env?: Record<string, string>;
  stdin?: string;
  /**
   * When true, do NOT wrap the command with c8. Used for bookkeeping
   * commands like `sh`, `mkdir`, `cat`, etc. that are not the flockctl
   * CLI under test.
   */
  raw?: boolean;
  /**
   * Timeout in ms for the docker exec. Defaults to 30s.
   */
  timeoutMs?: number;
  /**
   * Working directory inside the container. Defaults to the image WORKDIR
   * (/app). Setting this is the only way to cover code paths that read
   * `process.cwd()` (e.g. `flockctl project add-cwd`).
   */
  cwd?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CliDockerContext {
  exec(cmd: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** Host-reachable URL for the daemon (e.g. http://127.0.0.1:<mapped>). */
  daemonUrl: string;
  /** Mount point inside the container — also set as FLOCKCTL_HOME. */
  tmpHome: string;
  /** Container name, useful for diagnostics / `docker logs`. */
  containerName: string;
  /**
   * Poll the container's daemon /health endpoint (via the host-mapped
   * port) until it returns 200 or deadline. Throws on timeout.
   */
  waitForDaemon(timeoutMs?: number): Promise<void>;
}

function assertDockerAvailable(): void {
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error(
      `docker CLI not found on PATH. Install Docker first: ${DOCKER_INSTALL_URL}`,
    );
  }
  if (probe.status !== 0) {
    const msg = (probe.stderr || "").trim() || "docker daemon is not responding";
    throw new Error(
      `docker is not available (${msg}). Is the Docker daemon running? ${DOCKER_INSTALL_URL}`,
    );
  }
}

function assertImageAvailable(): void {
  const probe = spawnSync("docker", ["image", "inspect", IMAGE_TAG], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    throw new Error(
      `image ${IMAGE_TAG} not found. Build it first:\n  tsx tests/cli-docker/build.ts`,
    );
  }
}

async function hostPortIsFree(port: number): Promise<boolean> {
  return await new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => {
      res(false);
    });
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => res(true));
    });
  });
}

function runDocker(args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): SpawnSyncReturns<string> {
  return spawnSync("docker", args, {
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    input: opts.stdin,
    timeout: opts.timeoutMs ?? 30_000,
  });
}

function resolveMappedPort(containerName: string): number {
  const r = runDocker(["port", containerName, String(CONTAINER_INTERNAL_PORT)]);
  if (r.status !== 0) {
    throw new Error(
      `docker port lookup failed for ${containerName}: ${(r.stderr || "").trim()}`,
    );
  }
  // Output like "127.0.0.1:49174\n0.0.0.0:49174". Prefer 127.0.0.1 line.
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  const prefer = lines.find((l) => l.startsWith("127.0.0.1:")) ?? lines[0];
  if (!prefer) {
    throw new Error(`docker port returned no mappings for ${containerName}`);
  }
  const m = prefer.match(/:(\d+)$/);
  if (!m) {
    throw new Error(`unable to parse docker port output: ${r.stdout}`);
  }
  return parseInt(m[1], 10);
}

async function pollHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `daemon /health did not become ready within ${timeoutMs}ms (${url}). ${
      lastErr ? `last error: ${(lastErr as Error).message}` : ""
    }`,
  );
}

function coverageIdForCommand(cmd: string[]): string {
  const slug = cmd
    .slice(0, 4)
    .join("-")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 40);
  const rand = randomBytes(4).toString("hex");
  return `${slug || "cmd"}-${rand}`;
}

/**
 * Spawns a `docker exec` child and returns a promise resolving with stdout,
 * stderr, and the exit code. Uses `spawn` (not spawnSync) so we can stream
 * stdin and avoid blocking the event loop when child processes emit lots
 * of output.
 */
function dockerExec(
  containerName: string,
  innerCmd: string[],
  opts: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = ["exec", "-i"];
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push("-e", `${k}=${v}`);
      }
    }
    if (opts.cwd) {
      args.push("-w", opts.cwd);
    }
    args.push(containerName, ...innerCmd);

    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const timeout = opts.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(
        new Error(`docker exec timed out after ${timeout}ms: ${innerCmd.join(" ")}`),
      );
    }, timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code: code ?? -1 });
    });

    if (opts.stdin) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

export async function withCliDocker(
  fn: (ctx: CliDockerContext) => Promise<void>,
): Promise<void> {
  assertDockerAvailable();
  assertImageAvailable();

  const containerName = `flockctl-cli-test-${process.pid}-${randomBytes(3).toString("hex")}`;
  const hostTmp = mkdtempSync(join(tmpdir(), "flockctl-cli-docker-"));

  // Prefer the canonical port so test fixtures can hit the documented
  // default; fall back to a random host port if it's busy.
  const use52077 = await hostPortIsFree(CONTAINER_INTERNAL_PORT);
  const portArg = use52077
    ? `127.0.0.1:${CONTAINER_INTERNAL_PORT}:${CONTAINER_INTERNAL_PORT}`
    : `127.0.0.1:0:${CONTAINER_INTERNAL_PORT}`;

  const runArgs = [
    "run",
    "-d",
    "--rm",
    "--name",
    containerName,
    "-v",
    `${hostTmp}:/flockctl-home`,
  ];

  // Mount the host fixtures dir read-only so tests can seed sample
  // trees without baking them into the image. Tests copy the parts
  // they need out to a writable path under /flockctl-home before
  // touching them (git init, etc.).
  try {
    const fxStat = statSync(HOST_FIXTURES_DIR);
    if (fxStat.isDirectory()) {
      runArgs.push("-v", `${HOST_FIXTURES_DIR}:/fixtures:ro`);
    }
  } catch {
    /* fixtures dir absent — not an error; test suites that don't need
       fixtures still work. */
  }

  runArgs.push(
    "-e",
    "FLOCKCTL_HOME=/flockctl-home",
    "-e",
    "NODE_V8_COVERAGE=/flockctl-home/nyc_output",
    "-p",
    portArg,
    IMAGE_TAG,
    "sleep",
    "infinity",
  );

  const startRes = runDocker(runArgs);
  if (startRes.status !== 0) {
    rmSync(hostTmp, { recursive: true, force: true });
    throw new Error(
      `docker run failed (exit ${startRes.status}): ${(startRes.stderr || "").trim()}`,
    );
  }

  let daemonUrl = `http://127.0.0.1:${CONTAINER_INTERNAL_PORT}`;
  try {
    const hostPort = resolveMappedPort(containerName);
    daemonUrl = `http://127.0.0.1:${hostPort}`;

    // Make sure the coverage target subdirs exist inside the container
    // so c8 doesn't trip over a missing parent.
    await dockerExec(
      containerName,
      [
        "sh",
        "-c",
        "mkdir -p /flockctl-home/c8 /flockctl-home/nyc_output /flockctl-home/v8-raw",
      ],
      { raw: true, timeoutMs: 10_000 },
    );

    const ctx: CliDockerContext = {
      daemonUrl,
      tmpHome: "/flockctl-home",
      containerName,

      async exec(cmd: string[], opts: ExecOptions = {}) {
        if (cmd.length === 0) {
          throw new Error("exec: cmd must not be empty");
        }

        let innerCmd: string[];
        if (opts.raw) {
          innerCmd = cmd;
        } else {
          // Accept both `["flockctl", "start"]` and `["start"]` forms —
          // the wrapper always runs `node dist/cli.js ...`.
          const cliArgs = cmd[0] === "flockctl" ? cmd.slice(1) : cmd;
          const covId = coverageIdForCommand(cliArgs);
          const covDir = `/flockctl-home/c8/${covId}`;
          // Per-invocation v8 temp dir + --clean=false. c8 normally wipes
          // its --temp-directory before the spawn (to drop stale data); we
          // override that so each invocation's raw v8 output survives in a
          // unique subdir, and the host runner can collect them all and
          // run a single `c8 check-coverage` against the union.
          const v8Dir = `/flockctl-home/v8-raw/${covId}`;
          // Use an absolute path for dist/cli.js so callers can pass an
          // opts.cwd that isn't /app (e.g. `project add-cwd` runs from a
          // fixture path and still has to resolve the CLI module).
          innerCmd = [
            "c8",
            "--reporter=json",
            `--reports-dir=${covDir}`,
            `--temp-directory=${v8Dir}`,
            "--clean=false",
            "node",
            "/app/dist/cli.js",
            ...cliArgs,
          ];
        }
        return dockerExec(containerName, innerCmd, opts);
      },

      async waitForDaemon(timeoutMs: number = HEALTH_TIMEOUT_MS) {
        await pollHealth(daemonUrl, timeoutMs);
      },
    };

    await fn(ctx);
  } finally {
    // Best-effort: always try to extract coverage before the container goes
    // away, then force-remove whether or not the copy succeeded.
    try {
      mkdirSync(HOST_COVERAGE_DIR, { recursive: true });
      const destDir = join(HOST_COVERAGE_DIR, containerName);
      mkdirSync(destDir, { recursive: true });
      const cp = runDocker([
        "cp",
        `${containerName}:/flockctl-home/c8/.`,
        destDir,
      ]);
      if (cp.status !== 0) {
        console.warn(
          `[cli-docker] warning: docker cp failed (${cp.status}): ${(cp.stderr || "").trim()}`,
        );
      }
      // Also pull the raw v8 dirs out so the host runner can run
      // `c8 check-coverage` against the union of all per-invocation runs.
      // Each <covId>/ subdir contains one or more coverage-*.json v8 files.
      const v8Dest = join(destDir, "v8-raw");
      mkdirSync(v8Dest, { recursive: true });
      const cpV8 = runDocker([
        "cp",
        `${containerName}:/flockctl-home/v8-raw/.`,
        v8Dest,
      ]);
      if (cpV8.status !== 0) {
        console.warn(
          `[cli-docker] warning: docker cp v8-raw failed (${cpV8.status}): ${(cpV8.stderr || "").trim()}`,
        );
      }
    } catch (err) {
      console.warn(
        `[cli-docker] warning: could not extract coverage from ${containerName}:`,
        (err as Error).message,
      );
    }

    const rm = runDocker(["rm", "-f", containerName]);
    if (rm.status !== 0) {
      console.warn(
        `[cli-docker] warning: docker rm -f ${containerName} failed: ${(rm.stderr || "").trim()}`,
      );
    }

    try {
      rmSync(hostTmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
