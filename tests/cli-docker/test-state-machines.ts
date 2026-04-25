#!/usr/bin/env tsx
/**
 * CLI-docker test — `flockctl state-machines check`.
 *
 * Exercises every branch of the action handler at src/cli.ts:137-182:
 *   • empty diff                    → exit 0, "No state-machine transitions found in diff."
 *   • one matching transition       → exit 0, "1 detected transition matches the registry."
 *   • multiple matching transitions → exit 0, "N detected transitions match the registry."
 *   • undeclared transition         → exit 1, formatViolations() output on stderr
 *   • --diff <ref>                  → runs `git diff <ref>` instead of `git diff HEAD`
 *   • --files <glob>                → restricts detection to the matching file
 *   • --cwd <path>                  → runs from outside the git repo
 *   • error path (--cwd at non-git) → exit 1, "Error: ..." on stderr
 *
 * Each scenario stands up a tiny git repo at /tmp/sm-fixture inside the
 * container, writes the registry from tests/cli-docker/fixtures/sm-registry.md,
 * and applies one of the .patch fixtures as the change under test.
 *
 * Verification:
 *   npm run test:cli-docker -- --grep state-machines
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, withCliDocker } from "./_harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "fixtures");

const REGISTRY_MD = readFileSync(resolve(fixturesDir, "sm-registry.md"), "utf8");
const GOOD_DIFF = readFileSync(resolve(fixturesDir, "sm-good-diff.patch"), "utf8");
const BAD_DIFF = readFileSync(resolve(fixturesDir, "sm-bad-diff.patch"), "utf8");

const FIXTURE = "/tmp/sm-fixture";
const NON_REPO = "/tmp/sm-not-a-repo";

await withCliDocker(async (ctx) => {
  /* ---------------------------------------------------------------------- */
  /* Shell helpers                                                          */
  /* ---------------------------------------------------------------------- */

  async function shell(
    script: string,
    opts: { stdin?: string; timeoutMs?: number } = {},
  ) {
    const r = await ctx.exec(["sh", "-c", script], {
      raw: true,
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs ?? 15_000,
    });
    if (r.code !== 0) {
      throw new Error(
        `shell script failed (exit ${r.code}): ${script}\nstderr: ${r.stderr}`,
      );
    }
    return r;
  }

  /**
   * Rebuild the fixture from scratch: empty git repo on branch `main`
   * containing only the state-machine registry under
   * `.flockctl/state-machines/order.md`.
   */
  async function resetFixture(): Promise<void> {
    await shell(
      `rm -rf ${FIXTURE} && mkdir -p ${FIXTURE}/.flockctl/state-machines`,
    );
    await shell(`cat > ${FIXTURE}/.flockctl/state-machines/order.md`, {
      stdin: REGISTRY_MD,
    });
    await shell(
      `cd ${FIXTURE} && ` +
        `git init -q -b main && ` +
        `git config user.email test@example.com && ` +
        `git config user.name test && ` +
        `git add -A && ` +
        `git commit -q -m init`,
    );
  }

  async function applyPatch(patch: string): Promise<void> {
    await shell(`cd ${FIXTURE} && git apply -`, { stdin: patch });
    // Stage the new/changed files so `git diff HEAD` sees them.
    await shell(`cd ${FIXTURE} && git add -A`);
  }

  async function runCheck(args: string[]) {
    return ctx.exec(["state-machines", "check", ...args], {
      timeoutMs: 20_000,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Scenario 1 — empty diff                                                */
  /* ---------------------------------------------------------------------- */

  await resetFixture();
  {
    const r = await runCheck(["--cwd", FIXTURE]);
    assert(
      r.code === 0,
      `[1] empty diff: expected exit 0, got ${r.code}; stderr=${r.stderr}`,
    );
    assert(
      r.stdout.includes("No state-machine transitions found in diff."),
      `[1] empty diff: stdout should report no transitions, got ${JSON.stringify(
        r.stdout,
      )}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Scenario 2 — exactly one matching transition                           */
  /* ---------------------------------------------------------------------- */

  await resetFixture();
  await shell(
    `mkdir -p ${FIXTURE}/src && ` +
      `printf '// @sm:order pending -> shipped\\n' > ${FIXTURE}/src/order.ts && ` +
      `cd ${FIXTURE} && git add -A`,
  );
  {
    const r = await runCheck(["--cwd", FIXTURE]);
    assert(
      r.code === 0,
      `[2] one match: expected exit 0, got ${r.code}; stderr=${r.stderr}`,
    );
    assert(
      r.stdout.includes("1 detected transition matches the registry."),
      `[2] one match: stdout should use singular form, got ${JSON.stringify(
        r.stdout,
      )}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Scenario 3 — multiple matching transitions                             */
  /* ---------------------------------------------------------------------- */

  await resetFixture();
  await applyPatch(GOOD_DIFF); // 2 legal transitions in src/order.ts
  {
    const r = await runCheck(["--cwd", FIXTURE]);
    assert(
      r.code === 0,
      `[3] multi match: expected exit 0, got ${r.code}; stderr=${r.stderr}`,
    );
    const m = r.stdout.match(/(\d+) detected transitions match the registry\./);
    assert(
      m !== null,
      `[3] multi match: stdout should use plural form, got ${JSON.stringify(
        r.stdout,
      )}`,
    );
    assert(
      Number(m![1]) >= 2,
      `[3] multi match: expected >=2 detections, got ${m![1]}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Scenario 4 — violation found                                           */
  /* ---------------------------------------------------------------------- */

  await resetFixture();
  await applyPatch(BAD_DIFF); // shipped -> cancelled in two files
  {
    const r = await runCheck(["--cwd", FIXTURE]);
    assert(
      r.code === 1,
      `[4] violation: expected exit 1, got ${r.code}; stdout=${r.stdout}; stderr=${r.stderr}`,
    );
    assert(
      r.stderr.includes(
        "new transition shipped→cancelled not declared in registry",
      ),
      `[4] violation: stderr should contain formatted violation, got ${JSON.stringify(
        r.stderr,
      )}`,
    );
    assert(
      /state-machine violations? found/.test(r.stderr),
      `[4] violation: stderr should contain summary, got ${JSON.stringify(
        r.stderr,
      )}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Scenario 5 — --diff against a non-HEAD ref                             */
  /* ---------------------------------------------------------------------- */

  await resetFixture();
  // Commit good-diff on a feature branch, then diff that branch against main.
  await shell(
    `cd ${FIXTURE} && git checkout -q -b feature && git apply -`,
    { stdin: GOOD_DIFF },
  );
  await shell(
    `cd ${FIXTURE} && git add -A && git commit -q -m "add legal transitions"`,
  );
  {
    const r = await runCheck(["--cwd", FIXTURE, "--diff", "main"]);
    assert(
      r.code === 0,
      `[5] --diff main: expected exit 0, got ${r.code}; stderr=${r.stderr}`,
    );
    // Good-diff adds 2 legal transitions → plural form.
    assert(
      /\d+ detected transitions match the registry\./.test(r.stdout),
      `[5] --diff main: stdout should report matches, got ${JSON.stringify(
        r.stdout,
      )}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Scenario 6 — --files glob filter                                       */
  /* ---------------------------------------------------------------------- */

  await resetFixture();
  await applyPatch(BAD_DIFF); // violations in src/order.ts AND docs/order.md
  {
    // Scope to docs only — src/order.ts violation must be ignored.
    const r = await runCheck([
      "--cwd",
      FIXTURE,
      "--files",
      "docs/**/*.md",
    ]);
    assert(
      r.code === 1,
      `[6] --files: expected exit 1 for docs violation, got ${r.code}`,
    );
    assert(
      r.stderr.includes("docs/order.md"),
      `[6] --files: stderr should mention docs/order.md, got ${JSON.stringify(
        r.stderr,
      )}`,
    );
    assert(
      !r.stderr.includes("src/order.ts"),
      `[6] --files: stderr should NOT mention src/order.ts (filtered out), got ${JSON.stringify(
        r.stderr,
      )}`,
    );
    assert(
      r.stderr.includes("1 state-machine violation found"),
      `[6] --files: stderr should count exactly 1 violation, got ${JSON.stringify(
        r.stderr,
      )}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Scenario 7 — --cwd runs from outside the git repo                      */
  /* ---------------------------------------------------------------------- */

  await resetFixture();
  await applyPatch(GOOD_DIFF);
  {
    // ctx.exec's docker-exec inherits /app as WORKDIR — i.e. NOT a git repo.
    // Passing --cwd should still make the check succeed against the fixture.
    const r = await runCheck(["--cwd", FIXTURE]);
    assert(
      r.code === 0,
      `[7] --cwd from outside: expected exit 0, got ${r.code}; stderr=${r.stderr}`,
    );
    assert(
      /detected transitions? match/i.test(r.stdout),
      `[7] --cwd from outside: stdout should report matches, got ${JSON.stringify(
        r.stdout,
      )}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Scenario 8 — error path: --cwd at a non-git directory                  */
  /* ---------------------------------------------------------------------- */

  await shell(`rm -rf ${NON_REPO} && mkdir -p ${NON_REPO}`);
  {
    const r = await runCheck(["--cwd", NON_REPO]);
    assert(
      r.code === 1,
      `[8] non-git: expected exit 1, got ${r.code}; stdout=${r.stdout}; stderr=${r.stderr}`,
    );
    assert(
      /(^|\n)Error:/.test(r.stderr),
      `[8] non-git: stderr should start with "Error:", got ${JSON.stringify(
        r.stderr,
      )}`,
    );
  }
});

console.log("state-machines: ok");
