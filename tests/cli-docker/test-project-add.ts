#!/usr/bin/env tsx
/**
 * CLI-docker coverage for `flockctl project add` and `flockctl project add-cwd`.
 *
 * Each case targets a specific branch of `buildImportActions` in
 * src/cli-commands/project.ts plus the two `runAdd` entry points. The
 * fixtures under tests/cli-docker/fixtures/ are mounted read-only at
 * /fixtures by the harness; for each case we copy the tree we need to a
 * writable path under /flockctl-home/work/<label>/, run `git init && git
 * commit` inside the container, then drive the CLI at that path.
 *
 * Branches covered (by case #):
 *   1 clean repo, no conflicts                      → actions=[], unresolved=[]
 *   2 AGENTS.md unmanaged, no flag                  → unresolved (adopt-agents)
 *   3 AGENTS.md unmanaged + --adopt-agents-md       → actions=[adoptAgentsMd]
 *   4 AGENTS.md unmanaged + --yes                   → actions=[adoptAgentsMd]
 *   5 CLAUDE.md differs, no flag                    → unresolved (merge-claude)
 *   6 CLAUDE.md differs + --merge-claude-md         → actions=[mergeClaudeMd]
 *   7 CLAUDE.md same as AGENTS.md (managed)         → skipped automatically
 *   8 .mcp.json w/ servers, no flag                 → unresolved (import-mcp)
 *   9 .mcp.json w/ servers + --import-mcp-json      → actions=[importMcpJson]
 *  10 every conflict + --yes                        → all 3 actions emitted
 *  11 project add-cwd, happy path                   → runAdd via process.cwd()
 *  12 --workspace <existing-name>                   → resolver hits /workspaces
 *  13 --workspace <missing-name>                    → resolver error, exit 1
 *  14 --repo-url <url>                              → repoUrl persisted on row
 *  15 .claude/skills/<name> dir + --yes              → actions=[importClaudeSkill]
 *  16 alreadyManaged path without --yes              → exit 1 with "overwrite" hint
 *  17 invalid --allowed-key-ids <bad>                → CLI-side parse error, exit 1
 *  18 --json flag                                    → runAdd JSON short-circuit
 *  19 path="/" with no --name                        → derive-name guard, exit 1
 *
 * Verification:
 *   npm run test:cli-docker -- --grep 'project-add'
 */
import { assert, withCliDocker, type CliDockerContext } from "./_harness.js";

/** Strip ANSI escapes so regex assertions don't straddle them. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

interface ProjectRow {
  id: number;
  name: string;
  path: string | null;
  repoUrl: string | null;
  workspaceId: number | null;
}

/**
 * Copy a fixture into a writable working dir and make it a committed git
 * repo. Returns the absolute container path.
 *
 * The fixtures dir is mounted read-only at /fixtures — we need a fresh
 * writable copy for every case because:
 *   - applyImportActions writes .flockctl/ inside the dir
 *   - `project add` seeds AGENTS.md / TODO.md on first creation
 *   - /projects POST calls `git init` if no .git directory is present
 *
 * We commit the fixture state up-front so `detectGit` in project-import.ts
 * finds a real repo (exercising the origin-less branch at line 389).
 */
async function seedFixture(
  ctx: CliDockerContext,
  fixture: string,
  label: string,
): Promise<string> {
  const dest = `/flockctl-home/work/${label}`;
  const script =
    `set -e; ` +
    `rm -rf ${JSON.stringify(dest)}; ` +
    `mkdir -p /flockctl-home/work; ` +
    `cp -a /fixtures/${fixture} ${JSON.stringify(dest)}; ` +
    `cd ${JSON.stringify(dest)}; ` +
    `git init -q -b main >/dev/null 2>&1 || git init -q >/dev/null; ` +
    `git config user.email test@flockctl.invalid; ` +
    `git config user.name "cli-docker"; ` +
    `git add -A; ` +
    `git commit -q -m seed >/dev/null`;
  const r = await ctx.exec(["sh", "-c", script], { raw: true, timeoutMs: 15_000 });
  assert(
    r.code === 0,
    `seedFixture(${fixture} → ${label}) failed: exit ${r.code}; stderr=${r.stderr}; stdout=${r.stdout}`,
  );
  return dest;
}

/**
 * Fetch the created project row via the daemon HTTP API from the host so
 * assertions can inspect repoUrl / workspaceId / etc. without having to
 * parse CLI output. We rely on ctx.daemonUrl being reachable from the host.
 */
async function fetchProjectByName(
  daemonUrl: string,
  name: string,
): Promise<ProjectRow | null> {
  const res = await fetch(`${daemonUrl}/projects?perPage=500`);
  assert(res.ok, `GET /projects failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { items: ProjectRow[] };
  return body.items.find((p) => p.name === name) ?? null;
}

/**
 * Wipe a freshly-seeded dir (used after destructive cases so the next seed
 * on the same label starts clean).
 */
async function cleanDir(ctx: CliDockerContext, path: string): Promise<void> {
  await ctx.exec(["sh", "-c", `rm -rf ${JSON.stringify(path)}`], {
    raw: true,
    timeoutMs: 10_000,
  });
}

await withCliDocker(async (ctx) => {
  // Bring the daemon up once — all cases drive the same DB.
  const start = await ctx.exec(
    ["start", "--host", "0.0.0.0", "--allow-insecure-public"],
    { timeoutMs: 30_000 },
  );
  assert(start.code === 0, `flockctl start failed: ${start.stderr}`);
  await ctx.waitForDaemon();

  // The daemon refuses project creation without allowedKeyIds (see
  // src/routes/_allowed-keys.ts). Seed one active AI key up front so the
  // CLI's --allowed-key-ids <id> flag has a valid target for every case.
  const seedKeyRes = await fetch(`${ctx.daemonUrl}/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "anthropic",
      providerType: "sdk",
      label: "test-key",
      keyValue: "sk-ant-api03-test-fixture",
      priority: 1,
      isActive: true,
    }),
  });
  const seedKeyText = await seedKeyRes.text();
  assert(
    seedKeyRes.ok,
    `failed to seed AI key: ${seedKeyRes.status} ${seedKeyRes.statusText} — ${seedKeyText}`,
  );
  const seededKey = JSON.parse(seedKeyText) as { id: number };
  const KEY_FLAG = ["--allowed-key-ids", String(seededKey.id)];

  // ─────────────────────────────────────────────────────────────────────
  // 1. Clean repo, no conflicts → exit 0, no prompts, no actions applied.
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-clean", "case-01");
    const r = await ctx.exec(
      ["project", "add", path, "--name", "p-clean", ...KEY_FLAG],
      { timeoutMs: 20_000 },
    );
    assert(r.code === 0, `case 1: expected exit 0, got ${r.code}; stderr=${r.stderr}; stdout=${r.stdout}`);
    const out = stripAnsi(r.stdout);
    assert(/Created project/.test(out), `case 1: expected "Created project" line, got ${JSON.stringify(out)}`);
    assert(
      !/import actions applied/.test(out),
      `case 1: did not expect any import actions, got ${JSON.stringify(out)}`,
    );

    const row = await fetchProjectByName(ctx.daemonUrl, "p-clean");
    assert(row !== null, `case 1: project p-clean should exist in DB`);
    assert(row.path === path, `case 1: stored path mismatch, expected ${path} got ${row.path}`);
    assert(row.workspaceId === null, `case 1: expected standalone project, got workspaceId=${row.workspaceId}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 2. AGENTS.md unmanaged + no flag → exit 1 with adopt hint.
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-with-agents-md", "case-02");
    const r = await ctx.exec(["project", "add", path, "--name", "p-agents-fail"], {
      timeoutMs: 20_000,
    });
    assert(r.code === 1, `case 2: expected exit 1, got ${r.code}; stdout=${r.stdout}; stderr=${r.stderr}`);
    const err = stripAnsi(r.stderr);
    assert(
      /rerun with --adopt-agents-md/.test(err),
      `case 2: stderr should hint at --adopt-agents-md, got ${JSON.stringify(err)}`,
    );
    assert(
      /AGENTS\.md/.test(err),
      `case 2: stderr should mention AGENTS.md, got ${JSON.stringify(err)}`,
    );
    // Project must not have been created.
    const row = await fetchProjectByName(ctx.daemonUrl, "p-agents-fail");
    assert(row === null, `case 2: project must not be created when unresolved, got ${JSON.stringify(row)}`);
    await cleanDir(ctx, path);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 3. AGENTS.md unmanaged + --adopt-agents-md → exit 0, action emitted.
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-with-agents-md", "case-03");
    const r = await ctx.exec(
      [
        "project",
        "add",
        path,
        "--name",
        "p-agents-adopt",
        "--adopt-agents-md",
        ...KEY_FLAG,
      ],
      { timeoutMs: 20_000 },
    );
    assert(r.code === 0, `case 3: expected exit 0, got ${r.code}; stderr=${r.stderr}`);
    const out = stripAnsi(r.stdout);
    assert(
      /import actions applied: adoptAgentsMd/.test(out),
      `case 3: expected "adoptAgentsMd" in output, got ${JSON.stringify(out)}`,
    );
    // Post-apply: root AGENTS.md should have been moved into .flockctl/AGENTS.md.
    const check = await ctx.exec(
      [
        "sh",
        "-c",
        `test -f ${JSON.stringify(path + "/.flockctl/AGENTS.md")} && echo HAVE || echo MISSING`,
      ],
      { raw: true, timeoutMs: 5_000 },
    );
    assert(
      /HAVE/.test(check.stdout),
      `case 3: expected .flockctl/AGENTS.md to exist after adopt, got ${JSON.stringify(check.stdout)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 4. AGENTS.md unmanaged + --yes → same effect as --adopt-agents-md.
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-with-agents-md", "case-04");
    const r = await ctx.exec(
      ["project", "add", path, "--name", "p-agents-yes", "--yes", ...KEY_FLAG],
      { timeoutMs: 20_000 },
    );
    assert(r.code === 0, `case 4: expected exit 0, got ${r.code}; stderr=${r.stderr}`);
    const out = stripAnsi(r.stdout);
    assert(
      /import actions applied: adoptAgentsMd/.test(out),
      `case 4: --yes should emit adoptAgentsMd, got ${JSON.stringify(out)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 5. CLAUDE.md differs, no flag → unresolved (merge-claude-md hint).
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-with-claude-md", "case-05");
    const r = await ctx.exec(
      ["project", "add", path, "--name", "p-claude-fail", "--adopt-agents-md"],
      { timeoutMs: 20_000 },
    );
    assert(r.code === 1, `case 5: expected exit 1, got ${r.code}; stdout=${r.stdout}; stderr=${r.stderr}`);
    const err = stripAnsi(r.stderr);
    assert(
      /rerun with --merge-claude-md/.test(err),
      `case 5: stderr should hint at --merge-claude-md, got ${JSON.stringify(err)}`,
    );
    await cleanDir(ctx, path);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 6. CLAUDE.md differs + --merge-claude-md (+ --adopt-agents-md) → exit 0.
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-with-claude-md", "case-06");
    const r = await ctx.exec(
      [
        "project",
        "add",
        path,
        "--name",
        "p-claude-merge",
        "--adopt-agents-md",
        "--merge-claude-md",
        ...KEY_FLAG,
      ],
      { timeoutMs: 20_000 },
    );
    assert(r.code === 0, `case 6: expected exit 0, got ${r.code}; stderr=${r.stderr}`);
    const out = stripAnsi(r.stdout);
    assert(
      /adoptAgentsMd/.test(out) && /mergeClaudeMd/.test(out),
      `case 6: expected both adoptAgentsMd and mergeClaudeMd in output, got ${JSON.stringify(out)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 7. CLAUDE.md identical to (managed) AGENTS.md → auto-skipped, exit 0
  //    without any flags.
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-with-claude-md-same", "case-07");
    const r = await ctx.exec(
      ["project", "add", path, "--name", "p-claude-same", ...KEY_FLAG],
      { timeoutMs: 20_000 },
    );
    assert(r.code === 0, `case 7: expected exit 0, got ${r.code}; stderr=${r.stderr}; stdout=${r.stdout}`);
    const out = stripAnsi(r.stdout);
    assert(
      !/import actions applied/.test(out),
      `case 7: expected no import actions for sameAsAgents CLAUDE.md, got ${JSON.stringify(out)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 8. .mcp.json w/ servers, no flag → unresolved (import-mcp-json hint).
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-with-mcp-json", "case-08");
    const r = await ctx.exec(["project", "add", path, "--name", "p-mcp-fail"], {
      timeoutMs: 20_000,
    });
    assert(r.code === 1, `case 8: expected exit 1, got ${r.code}; stdout=${r.stdout}; stderr=${r.stderr}`);
    const err = stripAnsi(r.stderr);
    assert(
      /rerun with --import-mcp-json/.test(err),
      `case 8: stderr should hint at --import-mcp-json, got ${JSON.stringify(err)}`,
    );
    assert(/demo/.test(err), `case 8: stderr should list "demo" server, got ${JSON.stringify(err)}`);
    await cleanDir(ctx, path);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 9. .mcp.json + --import-mcp-json → exit 0, action emitted.
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-with-mcp-json", "case-09");
    const r = await ctx.exec(
      [
        "project",
        "add",
        path,
        "--name",
        "p-mcp-ok",
        "--import-mcp-json",
        ...KEY_FLAG,
      ],
      { timeoutMs: 20_000 },
    );
    assert(r.code === 0, `case 9: expected exit 0, got ${r.code}; stderr=${r.stderr}`);
    const out = stripAnsi(r.stdout);
    assert(
      /importMcpJson/.test(out),
      `case 9: expected importMcpJson in output, got ${JSON.stringify(out)}`,
    );
    // Per-server file should have landed at <project>/.flockctl/mcp/demo.json.
    const check = await ctx.exec(
      [
        "sh",
        "-c",
        `test -f ${JSON.stringify(path + "/.flockctl/mcp/demo.json")} && echo HAVE || echo MISSING`,
      ],
      { raw: true, timeoutMs: 5_000 },
    );
    assert(
      /HAVE/.test(check.stdout),
      `case 9: expected .flockctl/mcp/demo.json, got ${JSON.stringify(check.stdout)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 10. Every conflict + --yes → three actions in one call.
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-with-all-conflicts", "case-10");
    const r = await ctx.exec(
      ["project", "add", path, "--name", "p-all-yes", "--yes", ...KEY_FLAG],
      { timeoutMs: 20_000 },
    );
    assert(r.code === 0, `case 10: expected exit 0, got ${r.code}; stderr=${r.stderr}`);
    const out = stripAnsi(r.stdout);
    assert(
      /adoptAgentsMd/.test(out) && /mergeClaudeMd/.test(out) && /importMcpJson/.test(out),
      `case 10: expected all three actions, got ${JSON.stringify(out)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 11. `project add-cwd` — happy path, run from inside the fixture.
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-clean", "case-11");
    const r = await ctx.exec(
      ["project", "add-cwd", "--name", "p-cwd", ...KEY_FLAG],
      { timeoutMs: 20_000, cwd: path },
    );
    assert(r.code === 0, `case 11: expected exit 0, got ${r.code}; stderr=${r.stderr}; stdout=${r.stdout}`);
    const row = await fetchProjectByName(ctx.daemonUrl, "p-cwd");
    assert(row !== null, `case 11: project p-cwd should be created`);
    assert(
      row.path === path,
      `case 11: add-cwd must record the cwd path; expected ${path} got ${row.path}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 12. --workspace <existing-name> → workspace assignment succeeds.
  // ─────────────────────────────────────────────────────────────────────
  {
    const wsCreate = await ctx.exec(
      [
        "workspace",
        "create",
        "team-alpha",
        "--path",
        "/flockctl-home/ws-alpha",
        ...KEY_FLAG,
      ],
      { timeoutMs: 30_000 },
    );
    assert(
      wsCreate.code === 0,
      `case 12 setup: workspace create failed, exit ${wsCreate.code}; stderr=${wsCreate.stderr}`,
    );

    const path = await seedFixture(ctx, "repo-clean", "case-12");
    const r = await ctx.exec(
      [
        "project",
        "add",
        path,
        "--name",
        "p-in-ws",
        "--workspace",
        "team-alpha",
        ...KEY_FLAG,
      ],
      { timeoutMs: 20_000 },
    );
    assert(r.code === 0, `case 12: expected exit 0, got ${r.code}; stderr=${r.stderr}`);
    const row = await fetchProjectByName(ctx.daemonUrl, "p-in-ws");
    assert(row !== null, `case 12: project should exist`);
    assert(
      row.workspaceId !== null && row.workspaceId > 0,
      `case 12: expected non-null workspaceId, got ${row.workspaceId}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 13. --workspace <missing-name> → resolver error, exit 1.
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-clean", "case-13");
    const r = await ctx.exec(
      [
        "project",
        "add",
        path,
        "--name",
        "p-nope",
        "--workspace",
        "does-not-exist",
      ],
      { timeoutMs: 20_000 },
    );
    assert(r.code === 1, `case 13: expected exit 1, got ${r.code}; stdout=${r.stdout}; stderr=${r.stderr}`);
    const err = stripAnsi(r.stderr);
    assert(
      /No workspace found with name "does-not-exist"/.test(err),
      `case 13: stderr should report the missing workspace, got ${JSON.stringify(err)}`,
    );
    const row = await fetchProjectByName(ctx.daemonUrl, "p-nope");
    assert(row === null, `case 13: project must not be created on resolver failure`);
    await cleanDir(ctx, path);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 15. .claude/skills/<name> directory + --yes → importClaudeSkill action.
  //     Covers the `claudeSkills.length > 0 && yes` branch of
  //     buildImportActions. The fixture tree carries no .claude/ dir
  //     (host sandboxes dislike authoring dot-prefixed paths), so we
  //     scaffold it inside the container just before the CLI call.
  //     Named 15 to sit after the --repo-url case numerically; executed
  //     before case 14 so both branches are covered without reordering
  //     prose docs.
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-clean", "case-15");
    const setup = await ctx.exec(
      [
        "sh",
        "-c",
        `set -e; cd ${JSON.stringify(path)}; ` +
          `mkdir -p .claude/skills/demo-skill; ` +
          `printf '# demo-skill\\n\\nScaffolded by the test.\\n' > .claude/skills/demo-skill/SKILL.md; ` +
          `git add -A; git commit -q -m "seed skill"`,
      ],
      { raw: true, timeoutMs: 10_000 },
    );
    assert(
      setup.code === 0,
      `case 15 setup: skill scaffold failed, exit ${setup.code}; stderr=${setup.stderr}`,
    );

    const r = await ctx.exec(
      ["project", "add", path, "--name", "p-skills", "--yes", ...KEY_FLAG],
      { timeoutMs: 20_000 },
    );
    assert(r.code === 0, `case 15: expected exit 0, got ${r.code}; stderr=${r.stderr}`);
    const out = stripAnsi(r.stdout);
    assert(
      /importClaudeSkill/.test(out),
      `case 15: expected importClaudeSkill in output, got ${JSON.stringify(out)}`,
    );
    // The skill dir should have moved to .flockctl/skills/demo-skill.
    const check = await ctx.exec(
      [
        "sh",
        "-c",
        `test -f ${JSON.stringify(path + "/.flockctl/skills/demo-skill/SKILL.md")} && echo HAVE || echo MISSING`,
      ],
      { raw: true, timeoutMs: 5_000 },
    );
    assert(
      /HAVE/.test(check.stdout),
      `case 15: expected .flockctl/skills/demo-skill/SKILL.md, got ${JSON.stringify(check.stdout)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 16. alreadyManaged path without --yes → exit 1 with "overwrite" hint.
  //     Covers the `scan.alreadyManaged && !opts.yes` guard in runAdd.
  // ─────────────────────────────────────────────────────────────────────
  {
    // case-04's project had AGENTS.md adopted, so its .flockctl/ exists.
    // Re-running `project add` on that path without --yes must refuse.
    const path = "/flockctl-home/work/case-04";
    const r = await ctx.exec(
      ["project", "add", path, "--name", "p-already", ...KEY_FLAG],
      { timeoutMs: 20_000 },
    );
    assert(r.code === 1, `case 16: expected exit 1, got ${r.code}; stdout=${r.stdout}; stderr=${r.stderr}`);
    const err = stripAnsi(r.stderr);
    assert(
      /already a flockctl project/.test(err),
      `case 16: stderr should mention "already a flockctl project", got ${JSON.stringify(err)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 17. Invalid --allowed-key-ids → CLI-side parse error, exit 1.
  //     Covers parseAllowedKeyIdsFlag's rejection branch.
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-clean", "case-17");
    const r = await ctx.exec(
      [
        "project",
        "add",
        path,
        "--name",
        "p-bad-key",
        "--allowed-key-ids",
        "abc",
      ],
      { timeoutMs: 20_000 },
    );
    assert(r.code === 1, `case 17: expected exit 1, got ${r.code}; stdout=${r.stdout}; stderr=${r.stderr}`);
    const err = stripAnsi(r.stderr);
    assert(
      /Invalid --allowed-key-ids entry: abc/.test(err),
      `case 17: stderr should surface the CLI parse error, got ${JSON.stringify(err)}`,
    );
    await cleanDir(ctx, path);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 14. --repo-url <url> with an explicit path → repoUrl persisted on row.
  //    We mock the remote via a bare repo at /flockctl-home/bare/remote.git
  //    so no network is required; the CLI's explicit-path invocation skips
  //    the server-side clone branch and records the URL verbatim.
  // ─────────────────────────────────────────────────────────────────────
  {
    const makeBare = await ctx.exec(
      [
        "sh",
        "-c",
        `set -e; rm -rf /flockctl-home/bare; mkdir -p /flockctl-home/bare; ` +
          `git clone --bare /flockctl-home/work/case-01 /flockctl-home/bare/remote.git >/dev/null 2>&1`,
      ],
      { raw: true, timeoutMs: 15_000 },
    );
    assert(
      makeBare.code === 0,
      `case 14 setup: bare clone failed, exit ${makeBare.code}; stderr=${makeBare.stderr}`,
    );

    const path = await seedFixture(ctx, "repo-clean", "case-14");
    const url = "file:///flockctl-home/bare/remote.git";
    const r = await ctx.exec(
      [
        "project",
        "add",
        path,
        "--name",
        "p-with-url",
        "--repo-url",
        url,
        ...KEY_FLAG,
      ],
      { timeoutMs: 30_000 },
    );
    assert(r.code === 0, `case 14: expected exit 0, got ${r.code}; stderr=${r.stderr}`);
    const row = await fetchProjectByName(ctx.daemonUrl, "p-with-url");
    assert(row !== null, `case 14: project should exist`);
    assert(
      row.repoUrl === url,
      `case 14: expected repoUrl=${url}, got ${JSON.stringify(row.repoUrl)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 18. --json prints the created row as JSON and returns early.
  //     Covers the `if (opts.json) { printJson(created); return; }` branch
  //     in runAdd.
  // ─────────────────────────────────────────────────────────────────────
  {
    const path = await seedFixture(ctx, "repo-clean", "case-18");
    const r = await ctx.exec(
      [
        "project",
        "add",
        path,
        "--name",
        "p-json",
        "--json",
        ...KEY_FLAG,
      ],
      { timeoutMs: 30_000 },
    );
    assert(r.code === 0, `case 18: expected exit 0, got ${r.code}; stderr=${r.stderr}`);
    const out = stripAnsi(r.stdout).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch (e) {
      throw new Error(`case 18: stdout must be valid JSON; got ${JSON.stringify(out)}`);
    }
    const row = parsed as { id?: unknown; name?: unknown };
    assert(typeof row.id === "number", `case 18: JSON must include numeric id`);
    assert(row.name === "p-json", `case 18: JSON.name mismatch, got ${JSON.stringify(row.name)}`);
    // --json short-circuits before the "Created project…" log line.
    assert(
      !/Created project/.test(out),
      `case 18: --json must suppress human-readable output, got ${JSON.stringify(out)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // 19. path="/" produces an empty derived name and no --name override →
  //     CLI guards with "could not derive project name" and exits 1.
  //     Covers the `if (!name) { … exit(1) }` branch in runAdd.
  // ─────────────────────────────────────────────────────────────────────
  {
    const r = await ctx.exec(["project", "add", "/"], { timeoutMs: 10_000 });
    assert(r.code === 1, `case 19: expected exit 1, got ${r.code}; stderr=${r.stderr}`);
    const err = stripAnsi(r.stderr);
    assert(
      /could not derive project name/.test(err),
      `case 19: expected derive-name error, got ${JSON.stringify(err)}`,
    );
  }
});

console.log("project-add: ok");
