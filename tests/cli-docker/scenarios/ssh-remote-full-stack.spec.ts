#!/usr/bin/env tsx
/**
 * ssh-remote-full-stack — two-container end-to-end for SSH remote servers.
 *
 * ---------------------------------------------------------------------------
 * Topology
 * ---------------------------------------------------------------------------
 *
 *      ┌────────────┐                 ┌────────────┐
 *      │  host-b    │ ── ssh ──►      │  host-a    │
 *      │ flockctl-  │                 │ flockctl-  │
 *      │ cli-test   │                 │ sshd-test  │
 *      │            │                 │            │
 *      │ daemon     │                 │ sshd (PID1)│
 *      │ on 52077   │                 │ flockctl   │
 *      │ + ssh      │                 │ spawned    │
 *      │ tunnel mgr │                 │ on demand  │
 *      └────────────┘                 └────────────┘
 *
 * The two containers share a user-defined bridge network (`ssh-remote-net`)
 * so host-b can reach host-a by the DNS alias `host-a`. Nothing is
 * published to the test host — the spec drives both sides exclusively via
 * `docker exec`, so concurrent cli-docker runs on the same CI worker do
 * not collide on a host port.
 *
 * ---------------------------------------------------------------------------
 * What this proves (the five test cases)
 * ---------------------------------------------------------------------------
 *
 *   1. happy path               POST /meta/remote-servers from host-b to
 *                               create an entry pointing at host-a; expect
 *                               201 with `tunnelStatus: "ready"` and a
 *                               live tunnelPort. The rc entry on host-b
 *                               has a 43-char base64url token; capture it
 *                               for test 5's leak check.
 *   2. tunnel forwards /health  GET http://127.0.0.1:<tunnelPort>/health
 *                               from inside host-b must land on host-a's
 *                               daemon (200). Proves the ssh -L forward
 *                               is wired up correctly end-to-end.
 *   3. delete tears down        DELETE /meta/remote-servers/:id returns
 *                               204; follow-up GET :id → 404. Exercises
 *                               the stop-tunnel + rc-remove path.
 *   4. remote_flockctl_missing  Rename `flockctl` → `flockctl.disabled`
 *                               on host-a and POST again. The bootstrap
 *                               exec exits 127; the classifier returns
 *                               `remote_flockctl_missing`; the handler
 *                               returns 502 with that errorCode.
 *                               (Per the task spec: "same Dockerfile but
 *                               with flockctl renamed to flockctl.disabled
 *                               before test run. No second image.")
 *   5. token never in logs      After all of the above, grep both
 *                               containers' stdout/stderr dumps AND the
 *                               daemon log files on both sides for the
 *                               token captured in step 1. Required match
 *                               count is 0 — a 43-char base64url literal
 *                               is so unlikely to appear accidentally
 *                               that any match is a genuine leak.
 *
 * ---------------------------------------------------------------------------
 * Container naming + coverage gate
 * ---------------------------------------------------------------------------
 *
 * The runner's coverage gate (`run.ts::collectRewrittenV8`) filters
 * container dirs under `coverage/cli-docker/` by the
 * `flockctl-cli-test-` prefix. Our compose project picks a different
 * prefix (`ssh-remote-<pid>-<rand>`) so we are intentionally IGNORED by
 * the gate. Rationale: this scenario exercises HTTP routes, the SSH
 * tunnel manager, and ssh itself — none of it is `dist/cli.js` or
 * `dist/cli-commands/**` code. The single-container CLI specs already
 * hold the CLI at 100%.
 *
 * ---------------------------------------------------------------------------
 * Verification
 * ---------------------------------------------------------------------------
 *
 *   npm run test:cli-docker -- --grep 'ssh-remote-full-stack'
 *
 * First run builds `flockctl-sshd-test:local` from
 * `tests/cli-docker/fixtures/sshd-Dockerfile`. Subsequent runs reuse the
 * image (BuildKit cache). The base assumption — `flockctl-cli-test:local`
 * already exists — matches every other cli-docker test.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Paths + constants
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const sshdDockerfile = resolve(here, "..", "fixtures", "sshd-Dockerfile");
const composeFile = resolve(here, "..", "compose", "ssh-remote.yml");

const SSHD_IMAGE = "flockctl-sshd-test:local";
const CLI_IMAGE = "flockctl-cli-test:local";

// Lower-case + digits/hyphens only — docker compose rejects anything else
// for COMPOSE_PROJECT_NAME.
const PROJECT_NAME = `ssh-remote-${process.pid}-${randomBytes(3).toString(
  "hex",
)}`;

/** Port the flockctl daemon inside host-b binds to. Fixed because the
 * daemon is always invoked with default args. */
const DAEMON_PORT = 52077;

/** Tight regex for the 43-char base64url token the CLI mints. Used by
 * test 5's belt-and-braces regex check (complementing the exact-string
 * indexOf). Global flag so match() returns every occurrence. */
const TOKEN_REGEX = /[A-Za-z0-9_-]{43}/g;

const DOCKER_INSTALL_URL = "https://docs.docker.com/engine/install/";

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/**
 * Wrapper around `spawnSync` that throws by default on non-zero exit so
 * shell pipelines "fail closed". Pass `ignoreErrors: true` for probes
 * where a non-zero status is informative (e.g. `nc -z` readiness checks).
 */
function run(
  cmd: string,
  args: string[],
  opts: {
    input?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    timeoutMs?: number;
    ignoreErrors?: boolean;
  } = {},
): RunResult {
  const res = spawnSync(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    input: opts.input,
    env: opts.env ?? process.env,
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 60_000,
  });
  const out: RunResult = {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status,
  };
  if ((out.status ?? 1) !== 0 && !opts.ignoreErrors) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (status=${out.status}):\n${
        out.stderr || out.stdout
      }`,
    );
  }
  return out;
}

function assertDockerAvailable(): void {
  const probe = run("docker", ["version", "--format", "{{.Server.Version}}"], {
    ignoreErrors: true,
    timeoutMs: 10_000,
  });
  if ((probe.status ?? 1) !== 0) {
    throw new Error(
      `docker is not available (${(probe.stderr || "").trim()}). ` +
        `Is the Docker daemon running? ${DOCKER_INSTALL_URL}`,
    );
  }
}

function imageExists(tag: string): boolean {
  const res = run("docker", ["image", "inspect", tag], {
    ignoreErrors: true,
    timeoutMs: 15_000,
  });
  return (res.status ?? 1) === 0;
}

// ---------------------------------------------------------------------------
// Image build — idempotent
// ---------------------------------------------------------------------------

/**
 * Build `flockctl-sshd-test:local` on demand. Skipped when the image
 * already exists (BuildKit layer cache handles partial invalidations).
 * The sshd Dockerfile expects a `flockctl.tgz` alongside itself in the
 * build context; we produce it via `npm pack` from the repo root and
 * copy it + the Dockerfile into a tmpdir that becomes the docker build
 * context.
 */
function ensureSshdImageBuilt(): void {
  if (imageExists(SSHD_IMAGE)) return;

  console.log(
    `[ssh-remote-full-stack] building ${SSHD_IMAGE} (first run; ~2 min)...`,
  );

  // `npm pack` writes flockctl-<version>.tgz into --pack-destination. The
  // filename varies with package.json's version field, so we discover the
  // name rather than hard-coding it.
  const packDir = mkdtempSync(join(tmpdir(), "flockctl-sshd-pack-"));
  const ctxDir = mkdtempSync(join(tmpdir(), "flockctl-sshd-ctx-"));
  try {
    run("npm", ["pack", "--pack-destination", packDir], {
      cwd: repoRoot,
      timeoutMs: 180_000,
    });
    const packed = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
    assert(packed, `npm pack produced no .tgz in ${packDir}`);

    // Build context = the Dockerfile + the tarball renamed to a stable
    // `flockctl.tgz` so the Dockerfile's COPY line doesn't need to know
    // the package version.
    copyFileSync(sshdDockerfile, join(ctxDir, "Dockerfile"));
    copyFileSync(join(packDir, packed!), join(ctxDir, "flockctl.tgz"));

    run(
      "docker",
      ["build", "-t", SSHD_IMAGE, ctxDir],
      {
        env: { ...process.env, DOCKER_BUILDKIT: "1" },
        timeoutMs: 10 * 60_000,
      },
    );
  } finally {
    try {
      rmSync(packDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(ctxDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// docker exec helper
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function dockerExec(
  container: string,
  cmd: string[],
  opts: {
    env?: Record<string, string>;
    timeoutMs?: number;
    ignoreErrors?: boolean;
  } = {},
): Promise<ExecResult> {
  const args = ["exec"];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push("-e", `${k}=${v}`);
  }
  args.push(container, ...cmd);
  const res = spawnSync("docker", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30_000,
  });
  const out: ExecResult = {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    code: res.status ?? -1,
  };
  if (out.code !== 0 && !opts.ignoreErrors) {
    throw new Error(
      `docker exec ${container} ${cmd.join(" ")} failed (code=${out.code}):\n${
        out.stderr || out.stdout
      }`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP helper — runs inside the cli-test image, which has node but no curl.
// ---------------------------------------------------------------------------

/**
 * Tiny node-based HTTP client we exec inside host-b. The cli-test:local
 * image is alpine + flockctl and deliberately ships no curl — flockctl
 * itself is the only CLI surface that container needs. busybox wget can
 * do GET + POST but chokes on arbitrary methods (DELETE, PUT), so to
 * keep this spec's HTTP surface uniform we route every request through
 * node's built-in `http` module. First line of stdout is the status
 * code; the remainder is the response body verbatim.
 *
 * URL, METHOD and BODY travel via env vars rather than argv so quoting
 * is deterministic — JSON bodies with embedded quotes/braces can't
 * trip up `sh -c` this way.
 */
const HTTP_SCRIPT = `
const http = require('http');
const u = new URL(process.env.U);
const body = process.env.B || '';
const req = http.request({
  hostname: u.hostname,
  port: u.port || 80,
  path: u.pathname + u.search,
  method: process.env.M,
  headers: body
    ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    : {},
}, (res) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => {
    process.stdout.write(String(res.statusCode) + '\\n');
    process.stdout.write(Buffer.concat(chunks).toString('utf8'));
  });
});
req.on('error', (e) => { console.error(e.message); process.exit(2); });
if (body) req.write(body);
req.end();
`;

interface HttpResult {
  status: number;
  body: string;
}

async function httpRequest(
  container: string,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<HttpResult> {
  const env: Record<string, string> = { M: method, U: url };
  if (body !== undefined) env.B = JSON.stringify(body);
  const r = await dockerExec(container, ["node", "-e", HTTP_SCRIPT], {
    env,
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  const nl = r.stdout.indexOf("\n");
  if (nl < 0) {
    throw new Error(
      `httpRequest: malformed response from ${method} ${url}: ${r.stdout}`,
    );
  }
  const status = Number(r.stdout.slice(0, nl).trim());
  const respBody = r.stdout.slice(nl + 1);
  if (!Number.isFinite(status)) {
    throw new Error(
      `httpRequest: non-numeric status '${r.stdout.slice(0, nl)}' for ${method} ${url}`,
    );
  }
  return { status, body: respBody };
}

// ---------------------------------------------------------------------------
// Readiness probes
// ---------------------------------------------------------------------------

async function waitForSshdReady(
  hostBContainer: string,
  hostAHost: string,
  deadlineMs: number,
): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    // busybox nc is shipped in the flockctl-cli-test:local (alpine) image.
    // `-z` is connect-only, `-w 1` keeps the probe bounded on a black hole.
    const r = await dockerExec(
      hostBContainer,
      ["sh", "-c", `nc -z -w 1 ${hostAHost} 22`],
      { ignoreErrors: true, timeoutMs: 5_000 },
    );
    if (r.code === 0) return;
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(
    `sshd on ${hostAHost}:22 not ready within ${deadlineMs}ms`,
  );
}

async function waitForHealth(
  hostBContainer: string,
  port: number,
  deadlineMs: number,
): Promise<void> {
  const end = Date.now() + deadlineMs;
  let lastErr: unknown = null;
  while (Date.now() < end) {
    try {
      const r = await httpRequest(
        hostBContainer,
        "GET",
        `http://127.0.0.1:${port}/health`,
        undefined,
        { timeoutMs: 5_000 },
      );
      if (r.status === 200) return;
      lastErr = new Error(`status=${r.status} body=${r.body.slice(0, 200)}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(
    `daemon /health on 127.0.0.1:${port} (inside ${hostBContainer}) not ready within ${deadlineMs}ms${
      lastErr ? `: ${(lastErr as Error).message}` : ""
    }`,
  );
}

// ---------------------------------------------------------------------------
// Per-test keypair helper
// ---------------------------------------------------------------------------

/**
 * Generate a fresh, passphrase-less ed25519 keypair in `dir`. Returns the
 * abs paths of the private key (mounted read-only into host-b) and the
 * public key (mounted read-only into host-a as authorized_keys).
 *
 * ed25519 over RSA: shorter, faster to generate, and universally
 * supported by the openssh-server in debian bookworm.
 */
function generateKeyPair(dir: string): {
  privateKeyPath: string;
  publicKeyPath: string;
} {
  const privateKeyPath = join(dir, "id_ed25519");
  const publicKeyPath = `${privateKeyPath}.pub`;
  run(
    "ssh-keygen",
    [
      "-t",
      "ed25519",
      "-N",
      "",
      "-q",
      "-C",
      "flockctl-ssh-remote-test",
      "-f",
      privateKeyPath,
    ],
    { timeoutMs: 10_000 },
  );
  // ssh client insists on private keys being 0600 even in BatchMode. On
  // macOS the tmpdir default umask is looser than Linux's, so force it.
  chmodSync(privateKeyPath, 0o600);
  return { privateKeyPath, publicKeyPath };
}

// ---------------------------------------------------------------------------
// Compose lifecycle
// ---------------------------------------------------------------------------

function composeUp(env: NodeJS.ProcessEnv): void {
  run(
    "docker",
    ["compose", "-f", composeFile, "up", "-d"],
    { env, timeoutMs: 120_000 },
  );
}

function composeDown(env: NodeJS.ProcessEnv): void {
  run(
    "docker",
    ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"],
    { env, timeoutMs: 60_000, ignoreErrors: true },
  );
}

function resolveContainerNames(
  env: NodeJS.ProcessEnv,
): { hostA: string; hostB: string } {
  // `--format '{{.Name}}'` is stable across compose v2 and avoids hand-
  // parsing the table output. Filter by service label via two calls.
  const lookup = (service: string): string => {
    const r = run(
      "docker",
      [
        "compose",
        "-f",
        composeFile,
        "ps",
        "--format",
        "{{.Name}}",
        service,
      ],
      { env, timeoutMs: 10_000 },
    );
    const name = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    assert(name, `compose ps did not return a container name for ${service}`);
    return name!;
  };
  return { hostA: lookup("host-a"), hostB: lookup("host-b") };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  assertDockerAvailable();

  if (!imageExists(CLI_IMAGE)) {
    throw new Error(
      `${CLI_IMAGE} not found. Build it first:\n  tsx tests/cli-docker/build.ts`,
    );
  }

  ensureSshdImageBuilt();

  // Per-run tmpdirs: ssh keypair + host-b FLOCKCTL_HOME. Both live under
  // the OS tmpdir so a crashed test leaves recoverable state (they'll be
  // cleaned up by the OS eventually even if we fail to rm them).
  const sshKeyDir = mkdtempSync(join(tmpdir(), "flockctl-ssh-remote-keys-"));
  const hostBHome = mkdtempSync(join(tmpdir(), "flockctl-ssh-remote-homeb-"));

  const { privateKeyPath, publicKeyPath } = generateKeyPair(sshKeyDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COMPOSE_PROJECT_NAME: PROJECT_NAME,
    AUTHORIZED_KEYS_FILE: publicKeyPath,
    SSH_KEY_DIR: sshKeyDir,
    HOST_B_TMP: hostBHome,
  };

  let upAcknowledged = false;
  try {
    composeUp(env);
    upAcknowledged = true;

    const { hostA, hostB } = resolveContainerNames(env);

    // The cli-test:local image is a minimal alpine + flockctl build —
    // it deliberately omits the openssh client because the single-
    // container CLI specs never need it. This two-container scenario
    // DOES need it: host-b's flockctl shells out to `ssh` both for the
    // bootstrap exec and for the long-lived `ssh -L` tunnel. Install
    // it lazily at run-time so the base image stays unchanged.
    await dockerExec(
      hostB,
      ["apk", "add", "--no-cache", "openssh-client"],
      { timeoutMs: 60_000 },
    );

    // Wait for host-a's sshd to accept TCP, then start the daemon on
    // host-b and wait for /health. sshd comes up in ~1s after PID 1
    // starts; the daemon start fork+health-poll takes ~1–3s.
    await waitForSshdReady(hostB, "host-a", 30_000);
    await dockerExec(hostB, ["flockctl", "start"], { timeoutMs: 30_000 });
    await waitForHealth(hostB, DAEMON_PORT, 30_000);

    // Pre-start the remote daemon on host-a as the tester user so that
    // when POST /meta/remote-servers ssh's in and runs `flockctl
    // remote-bootstrap --print-token`, the `ensureDaemonRunning` fast
    // path (daemon already answers /health) short-circuits. Otherwise
    // we race realStartDaemon's IPC 'ready' handler (which
    // process.exits the bootstrap parent) against the token-printing
    // step in runRemoteBootstrap, and on fast container scheduling
    // IPC wins and the spawned daemon exits before ever emitting the
    // token. Production CLIs hit the same race; here we side-step it
    // because the test proves the HTTP pipeline, not the daemon-
    // spawn sequence (which the non-SSH CLI specs already cover).
    await dockerExec(
      hostA,
      [
        "runuser",
        "-u",
        "tester",
        "--",
        "bash",
        "-c",
        // `cd /home/tester` is load-bearing: the migrations folder is
        // symlinked into $HOME (see sshd-Dockerfile) and
        // `src/db/migrate.ts` resolves `./migrations` relative to cwd.
        // Without the chdir the daemon boot aborts with
        // "Can't find meta/_journal.json file".
        'cd /home/tester && export HOME=/home/tester FLOCKCTL_HOME=/home/tester/flockctl && mkdir -p "$FLOCKCTL_HOME" && flockctl start',
      ],
      { timeoutMs: 30_000 },
    );

    // -----------------------------------------------------------------
    // Test 1 — happy path: POST /meta/remote-servers succeeds 201.
    // -----------------------------------------------------------------
    const createBody = {
      name: "ci-host-a",
      ssh: {
        host: "host-a",
        user: "tester",
        identityFile: "/ssh-keys/id_ed25519",
      },
    };

    const createRes = await httpRequest(
      hostB,
      "POST",
      `http://127.0.0.1:${DAEMON_PORT}/meta/remote-servers`,
      createBody,
      { timeoutMs: 60_000 },
    );
    const createBodyStr = createRes.body;
    assert(
      createRes.status === 201,
      `[test-1 happy-path] POST expected 201, got ${createRes.status}; body=${createBodyStr}`,
    );
    const createJson = JSON.parse(createBodyStr);
    assert(
      createJson.tunnelStatus === "ready",
      `[test-1] tunnelStatus !== 'ready': ${createBodyStr}`,
    );
    assert(
      typeof createJson.tunnelPort === "number" && createJson.tunnelPort > 0,
      `[test-1] missing / bad tunnelPort: ${createBodyStr}`,
    );
    assert(
      typeof createJson.id === "string" && createJson.id.length > 0,
      `[test-1] missing id: ${createBodyStr}`,
    );
    // The POST contract says the response MUST NOT echo the token.
    assert(
      !("token" in createJson),
      `[test-1] response leaked 'token': ${createBodyStr}`,
    );
    assert(
      !("tokenLabel" in createJson),
      `[test-1] response leaked 'tokenLabel': ${createBodyStr}`,
    );

    const tunnelPort = createJson.tunnelPort as number;
    const serverId = createJson.id as string;

    // The token is persisted in host-b's rc. Pull it out so test 5 can
    // grep for it. The tight `^[A-Za-z0-9_-]{43}$` regex also doubles as
    // a shape check — a malformed token would imply a CLI regression.
    const rcText = (
      await dockerExec(hostB, ["cat", "/root/.flockctlrc"])
    ).stdout;
    const rc = JSON.parse(rcText);
    const rcEntry = (
      rc.remoteServers as Array<{ id: string; token?: string }>
    ).find((s) => s.id === serverId);
    assert(
      rcEntry?.token && /^[A-Za-z0-9_-]{43}$/.test(rcEntry.token),
      `[test-1] rc entry missing a valid 43-char token`,
    );
    const capturedToken: string = rcEntry.token!;

    console.log("[ssh-remote-full-stack] test 1 — happy path: ok");

    // -----------------------------------------------------------------
    // Test 2 — tunnel forwards /health to host-a's daemon.
    // -----------------------------------------------------------------
    // Create-time host-a got its daemon spawned by `flockctl remote-
    // bootstrap` via ssh. The tunnel manager on host-b keeps an ssh -L
    // forward open; fetching tunnelPort from inside host-b MUST land on
    // host-a's /health.
    const hRes = await httpRequest(
      hostB,
      "GET",
      `http://127.0.0.1:${tunnelPort}/health`,
      undefined,
      { timeoutMs: 15_000 },
    );
    assert(
      hRes.status === 200,
      `[test-2 tunnel-forwards-health] expected 200, got ${hRes.status}; body=${hRes.body}`,
    );
    console.log("[ssh-remote-full-stack] test 2 — tunnel forwards /health: ok");

    // -----------------------------------------------------------------
    // Test 3 — DELETE /meta/remote-servers/:id tears down cleanly.
    // -----------------------------------------------------------------
    const delRes = await httpRequest(
      hostB,
      "DELETE",
      `http://127.0.0.1:${DAEMON_PORT}/meta/remote-servers/${serverId}`,
      undefined,
      { timeoutMs: 15_000 },
    );
    assert(
      delRes.status === 204,
      `[test-3 delete] expected 204, got ${delRes.status}; body=${delRes.body}`,
    );

    const afterDel = await httpRequest(
      hostB,
      "GET",
      `http://127.0.0.1:${DAEMON_PORT}/meta/remote-servers/${serverId}`,
      undefined,
      { timeoutMs: 10_000 },
    );
    assert(
      afterDel.status === 404,
      `[test-3 delete] expected 404 after DELETE, got ${afterDel.status}; body=${afterDel.body}`,
    );
    console.log("[ssh-remote-full-stack] test 3 — delete tears down: ok");

    // -----------------------------------------------------------------
    // Test 4 — remote_flockctl_missing when the remote binary is gone.
    // -----------------------------------------------------------------
    // Rename (don't delete) `flockctl` on host-a so the test is
    // symmetric with the spec wording and so a future test can
    // re-enable it by renaming back. After the rename the remote sh
    // exits 127 when ssh tries to exec `flockctl`; classifyStderr maps
    // that (via the "command not found" regex OR the exit-code 127
    // fallback) to `remote_flockctl_missing`, and the POST handler
    // returns 502 with that code.
    await dockerExec(
      hostA,
      [
        "sh",
        "-c",
        'src=$(which flockctl) && mv "$src" "${src}.disabled"',
      ],
      { timeoutMs: 10_000 },
    );

    const missingRes = await httpRequest(
      hostB,
      "POST",
      `http://127.0.0.1:${DAEMON_PORT}/meta/remote-servers`,
      {
        name: "ci-missing",
        ssh: {
          host: "host-a",
          user: "tester",
          identityFile: "/ssh-keys/id_ed25519",
        },
      },
      { timeoutMs: 60_000 },
    );
    const missingBodyStr = missingRes.body;
    assert(
      missingRes.status === 502,
      `[test-4 flockctl-missing] expected 502, got ${missingRes.status}; body=${missingBodyStr}`,
    );
    const missingJson = JSON.parse(missingBodyStr);
    assert(
      missingJson.errorCode === "remote_flockctl_missing",
      `[test-4] expected errorCode=remote_flockctl_missing, got: ${missingBodyStr}`,
    );
    console.log(
      "[ssh-remote-full-stack] test 4 — remote_flockctl_missing: ok",
    );

    // -----------------------------------------------------------------
    // Test 5 — the token captured in test 1 never appears anywhere.
    // -----------------------------------------------------------------
    // Sources to check:
    //   - docker logs hostA         sshd stderr (auth attempts)
    //   - docker logs hostB         should be empty (sleep infinity)
    //   - host-b:/flockctl-home/flockctl.log     local daemon log
    //   - host-a:/home/tester/flockctl/flockctl.log   remote daemon log
    //
    // We want `includes(capturedToken)` to return false in the
    // concatenated blob. The regex check below is a belt-and-braces
    // defense against a future code change that logs the token with a
    // whitespace byte injected (which `indexOf` would miss).
    const logsA = run("docker", ["logs", hostA], {
      ignoreErrors: true,
      timeoutMs: 10_000,
    });
    const logsB = run("docker", ["logs", hostB], {
      ignoreErrors: true,
      timeoutMs: 10_000,
    });
    const daemonLogB = await dockerExec(
      hostB,
      ["cat", "/flockctl-home/flockctl.log"],
      { ignoreErrors: true, timeoutMs: 10_000 },
    );
    const daemonLogA = await dockerExec(
      hostA,
      ["cat", "/home/tester/flockctl/flockctl.log"],
      { ignoreErrors: true, timeoutMs: 10_000 },
    );

    const combined = [
      logsA.stdout,
      logsA.stderr,
      logsB.stdout,
      logsB.stderr,
      daemonLogB.stdout,
      daemonLogA.stdout,
    ].join("\n");

    const firstHit = combined.indexOf(capturedToken);
    assert(
      firstHit === -1,
      `[test-5 token-leak] token from test 1 appeared in combined logs at offset ${firstHit} — CRITICAL security regression.`,
    );

    // Regex-level defense: if a future code change logs the token with
    // a whitespace/control byte in the middle, the indexOf check misses
    // it. The 43-char base64url regex still matches contiguous copies.
    const matches = combined.match(TOKEN_REGEX) ?? [];
    const exactDupes = matches.filter((t) => t === capturedToken);
    assert(
      exactDupes.length === 0,
      `[test-5 token-leak] token from test 1 matched by regex in combined logs (${exactDupes.length} times)`,
    );

    console.log("[ssh-remote-full-stack] test 5 — token never in logs: ok");

    console.log("\n[ssh-remote-full-stack] all 5 test cases passed");
  } finally {
    if (upAcknowledged) {
      composeDown(env);
    }
    try {
      rmSync(sshKeyDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(hostBHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
