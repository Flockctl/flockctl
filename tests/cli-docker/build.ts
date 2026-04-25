#!/usr/bin/env tsx
/**
 * Build the Flockctl CLI test image.
 *
 * 1. Runs `npm run build` on the host so dist/ is fresh.
 * 2. Shells out to `docker build` with this directory's Dockerfile.
 *
 * Verification:
 *   tsx tests/cli-docker/build.ts
 *   docker run --rm flockctl-cli-test:local flockctl --version
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const IMAGE_TAG = "flockctl-cli-test:local";
const DOCKER_INSTALL_URL = "https://docs.docker.com/engine/install/";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const dockerfile = resolve(here, "Dockerfile");
const dockerignore = resolve(here, ".dockerignore");
// BuildKit convention: when -f points at <path>/Dockerfile, BuildKit will
// pick up <path>/Dockerfile.dockerignore as that file's ignore list
// (overriding the context-root .dockerignore). We sync it from our
// canonical .dockerignore at build time and clean up after.
const dockerignoreSynced = resolve(here, "Dockerfile.dockerignore");

function fail(msg: string, code = 1): never {
  console.error(`\x1b[31merror\x1b[0m ${msg}`);
  process.exit(code);
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  console.log(`\x1b[36m$\x1b[0m ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", env });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      fail(
        `'${cmd}' not found on PATH. Install it first — see ${
          cmd === "docker" ? DOCKER_INSTALL_URL : "your package manager"
        }`,
      );
    }
    fail(`failed to spawn ${cmd}: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    fail(`${cmd} exited with status ${result.status}`, result.status);
  }
  if (result.signal) {
    fail(`${cmd} terminated by signal ${result.signal}`);
  }
}

// 0. Sanity check: docker must be present before we burn time on a host build.
const dockerProbe = spawnSync("docker", ["--version"], { stdio: "ignore" });
if (dockerProbe.error || dockerProbe.status !== 0) {
  fail(
    `docker is not available. Install Docker Engine or Docker Desktop: ${DOCKER_INSTALL_URL}`,
  );
}

// 1. Build dist/ on the host. The Dockerfile copies dist/ in, so it must
//    exist and be current. `npm run build` is idempotent; run it every time
//    to avoid stale-image footguns.
run("npm", ["run", "build"], repoRoot);

if (!existsSync(resolve(repoRoot, "dist", "cli.js"))) {
  fail("dist/cli.js missing after `npm run build` — aborting image build.");
}

// 2. Sync .dockerignore → Dockerfile.dockerignore so BuildKit reads our
//    ignore list even though the build context is the repo root (which has
//    its own, unrelated .dockerignore).
if (!existsSync(dockerignore)) {
  fail(`expected ${dockerignore} to exist`);
}
copyFileSync(dockerignore, dockerignoreSynced);

// 3. Build the image. DOCKER_BUILDKIT=1 guarantees the per-Dockerfile
//    ignore-file is honored on older Docker Engine installs; modern Docker
//    Desktop uses BuildKit by default.
try {
  run(
    "docker",
    ["build", "-f", dockerfile, "-t", IMAGE_TAG, repoRoot],
    repoRoot,
    { ...process.env, DOCKER_BUILDKIT: "1" },
  );
} finally {
  if (existsSync(dockerignoreSynced)) {
    try {
      unlinkSync(dockerignoreSynced);
    } catch {
      /* best-effort cleanup */
    }
  }
}

console.log(`\n\x1b[32m✓\x1b[0m built image ${IMAGE_TAG}`);
console.log(
  `  verify: docker run --rm ${IMAGE_TAG} flockctl --version`,
);
