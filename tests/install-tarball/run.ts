/**
 * install-tarball test — the only tier that actually validates the artefact
 * we ship to npm.
 *
 * What it does:
 *   1. `npm pack` produces the exact tarball that `npm publish` would upload.
 *   2. Installs that tarball into a brand-new tmp project (`npm install`),
 *      so we go through the real consumer code path — including the npm
 *      `files` allowlist filter and the dist/ tree as it lands in
 *      `node_modules/flockctl/`.
 *   3. Spawns the daemon as `node node_modules/flockctl/dist/server-entry.js`
 *      from the tmp project's cwd (NOT the repo root). This is the load-
 *      bearing bit: any `./relative/path` in the daemon code that resolves
 *      against `process.cwd()` will fail here, exactly as it failed for the
 *      first user who ran `flockctl` after `npm install -g`.
 *   4. Asserts /health returns 200, then kills the daemon cleanly.
 *
 * Failure modes this catches that no other tier does:
 *   - cwd-relative path bugs (the rc.2 `migrationsFolder: "./migrations"`
 *     regression — smoke tests can't see this because they spawn `tsx
 *     src/server-entry.ts` from cwd=repoRoot, where every relative path
 *     happens to resolve correctly).
 *   - Files dropped from the npm `files` allowlist in `package.json`
 *     (e.g. someone removes "migrations" by accident — the daemon would
 *     still boot in dev but crash on `npm install`).
 *   - `tsc`-only breakage (anything that works under `tsx` but not after a
 *     real build, e.g. unsupported import-meta syntax, JS-vs-TS resolution
 *     differences).
 *
 * Cost: ~30–90 s end-to-end (the install does a real npm dependency
 * resolution against the registry). That's why this is a separate tier
 * rather than part of the default `npm test` chain.
 */
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

async function pickFreePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
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

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  // 1. Sanity check — dist/ must exist. We don't run `npm run build` from
  //    inside the test (it pulls a UI build that takes ~45 s); the caller
  //    (npm script + CI step) is responsible for building first.
  const distEntry = join(repoRoot, "dist", "server-entry.js");
  assert(
    existsSync(distEntry),
    `${distEntry} missing — run \`npm run build\` before this test (or use \`npm run test:install-tarball\` which does it for you).`,
  );

  const projectDir = mkdtempSync(join(tmpdir(), "flockctl-install-test-"));
  const home = mkdtempSync(join(tmpdir(), "flockctl-install-test-home-"));
  let tarballAbs: string | undefined;

  try {
    // 2. Pack. `npm pack` prints the tarball filename (relative to cwd) on
    //    its last stdout line; we resolve that to an absolute path so the
    //    install step in step 4 can use it from a different cwd. We use
    //    `--pack-destination=<projectDir>` so the .tgz lands inside the
    //    sandboxed tmp dir and gets cleaned up automatically — never in
    //    the repo, where it could accidentally get committed.
    process.stdout.write(`Packing tarball into ${projectDir} ... `);
    const packStdout = execFileSync(
      "npm",
      ["pack", "--silent", "--pack-destination", projectDir],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    const tarballName = packStdout.trim().split("\n").pop()?.trim() ?? "";
    assert(tarballName.endsWith(".tgz"), `unexpected npm pack output: ${packStdout}`);
    tarballAbs = resolve(projectDir, tarballName);
    assert(existsSync(tarballAbs), `tarball not at expected path ${tarballAbs}`);
    process.stdout.write("ok\n");

    // 3. Bootstrap a brand-new consumer project. `private: true` keeps npm
    //    from balking on missing publishConfig fields.
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify(
        { name: "flockctl-install-test", private: true, version: "0.0.0" },
        null,
        2,
      ),
    );

    // 4. Install. `--no-audit --no-fund` keep noise out of CI logs;
    //    `--no-save` would also work but using a regular install lets us
    //    verify the dependency tree resolves cleanly via package-lock.
    process.stdout.write(`Installing tarball ${tarballName} ... `);
    execFileSync(
      "npm",
      ["install", "--silent", "--no-audit", "--no-fund", tarballAbs],
      { cwd: projectDir, encoding: "utf-8", stdio: ["ignore", "ignore", "inherit"] },
    );
    process.stdout.write("ok\n");

    // 5. Files-allowlist sanity check — assert the load-bearing assets that
    //    aren't covered by `dist/` actually shipped. If someone narrows the
    //    npm `files` array in package.json, this fails before we even try
    //    to boot the daemon, with a clear message about what got dropped.
    const required = [
      "node_modules/flockctl/dist/server-entry.js",
      "node_modules/flockctl/dist/cli.js",
      "node_modules/flockctl/migrations/meta/_journal.json",
      "node_modules/flockctl/migrations/0000_init.sql",
    ];
    for (const rel of required) {
      const abs = join(projectDir, rel);
      assert(existsSync(abs), `expected shipped file missing: ${rel}`);
    }

    // 6. Boot the daemon FROM the consumer project's cwd. This is the bit
    //    that separates this test from the smoke tier — `cwd: projectDir`
    //    is a directory the daemon's bundled code knows nothing about.
    const port = await pickFreePort();
    const serverEntry = join(
      projectDir,
      "node_modules/flockctl/dist/server-entry.js",
    );
    process.stdout.write(`Spawning daemon (port ${port}, cwd=${projectDir}) ... `);
    const child = spawn("node", [serverEntry, "--port", String(port)], {
      cwd: projectDir,
      env: {
        ...process.env,
        FLOCKCTL_HOME: home,
        FLOCKCTL_MOCK_AI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout?.on("data", (d) => {
      output += d.toString();
    });
    child.stderr?.on("data", (d) => {
      output += d.toString();
    });

    // 7. Poll /health. 25 s deadline matches the smoke tier so we don't
    //    have a different timeout class to reason about.
    const deadline = Date.now() + 25_000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `daemon exited early (code=${child.exitCode}) before /health answered\n` +
            `--- captured stdout/stderr ---\n${output || "(empty)"}`,
        );
      }
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) {
          healthy = true;
          break;
        }
      } catch {
        /* not ready yet */
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    if (!healthy) {
      if (child.exitCode === null) child.kill("SIGKILL");
      throw new Error(
        `/health did not answer within 25 s\n` +
          `--- captured stdout/stderr ---\n${output || "(empty)"}`,
      );
    }
    process.stdout.write("ok\n");

    // 8. Clean shutdown. SIGTERM → wait → SIGKILL escalation, same as
    //    smoke harness. We don't fail the test if shutdown is slow; the
    //    boot-and-respond path is what we're guarding here.
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode === null) child.kill("SIGKILL");

    console.log("\nResults: install-tarball test passed");
  } finally {
    // tarball + projectDir share the same tmp tree (we packed into it),
    // so removing projectDir takes everything.
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

main().catch((err) => {
  console.error("\nResults: install-tarball test FAILED");
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
