#!/usr/bin/env tsx
/**
 * CLI-Docker tier — `flockctl project` CRUD coverage (non-import paths).
 *
 * The import-heavy `project add` / `add-cwd` / `scan` surface gets its own
 * test file; this one seeds projects through the HTTP API directly (via
 * `fetch` against the mapped host port) and then drives every branch of
 * `project list`, `project show`, `project update`, and `project rm`.
 *
 * Scenarios covered (mirrors src/cli-commands/project.ts):
 *
 *   list:
 *     - empty (no projects) prints "(none)"
 *     - populated table lists every project
 *     - --json emits a JSON array
 *     - --workspace <id> filters
 *     - --workspace <name> resolves name → id and filters
 *     - --workspace <missing-name> surfaces the shared resolver error
 *
 *   show:
 *     - by numeric id
 *     - by unique name
 *     - --json payload contains expected keys
 *     - not-found (unknown id and unknown name)
 *     - ambiguous name (two projects share a name) → resolver error
 *
 *   update:
 *     - no flags at all → exits 1 with "no update flags passed"
 *     - each DB-backed flag individually: --name, --description, --path, --repo-url
 *     - each config-backed flag individually: --model, --planning-model,
 *       --base-branch, --permission-mode (verified via GET /projects/:id/config)
 *     - multiple flags in a single invocation
 *     - --json output mode
 *
 *   rm / remove:
 *     - refuses without --yes (exit 1, no deletion)
 *     - --yes drops the DB row, but the on-disk directory is untouched
 *     - --yes --purge also removes the project directory from disk
 *     - `remove` alias works the same as `rm`
 *     - not-found surfaces a readable error
 *
 * Verification:
 *   npm run test:cli-docker -- --grep project-crud
 */
import { assert, withCliDocker, type CliDockerContext } from "./_harness.js";

const DAEMON_BOOT_TIMEOUT_MS = 30_000;

interface Project {
  id: number;
  name: string;
  description: string | null;
  path: string | null;
  repoUrl: string | null;
  workspaceId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Workspace {
  id: number;
  name: string;
  path: string | null;
}

/**
 * Minimal API client bound to the daemon running inside the container.
 *
 * Using raw fetch here rather than the in-repo `DaemonClient` keeps the test
 * independent of production-code paths; seeding regressions should surface as
 * API-shape errors, not CLI-client wiring errors.
 */
function api(ctx: CliDockerContext) {
  async function call<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${ctx.daemonUrl}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }
  let cachedKeyId: number | null = null;
  async function ensureActiveKey(): Promise<number> {
    if (cachedKeyId !== null) return cachedKeyId;
    // Workspace/project POST both require at least one active AI-provider
    // key referenced in `allowedKeyIds`. The key never gets exercised by
    // this test (we never kick off a task) so claude_cli + a stub label is
    // enough — `is_active: true` is the only thing the validator checks.
    const key = await call<{ id: number }>("POST", "/keys", {
      provider: "claude_cli",
      providerType: "claude-agent-sdk",
      label: "crud-test-key",
      isActive: true,
    });
    cachedKeyId = key.id;
    return key.id;
  }
  return {
    async createWorkspace(name: string) {
      const keyId = await ensureActiveKey();
      return call<Workspace>("POST", "/workspaces", {
        name,
        allowedKeyIds: [keyId],
      });
    },
    async createProject(body: {
      name: string;
      description?: string | null;
      workspaceId?: number;
    }) {
      const keyId = await ensureActiveKey();
      return call<Project>("POST", "/projects", { ...body, allowedKeyIds: [keyId] });
    },
    listProjects: async () =>
      (await call<{ items: Project[] }>("GET", "/projects?perPage=500")).items,
    getConfig: (id: number) =>
      call<Record<string, unknown>>("GET", `/projects/${id}/config`),
  };
}

/**
 * Container-side stat helper. Returns true if the given absolute path exists
 * inside the container. Used to assert `--purge` actually touched the
 * filesystem.
 */
async function pathExistsInContainer(ctx: CliDockerContext, path: string): Promise<boolean> {
  const probe = await ctx.exec(
    ["sh", "-c", `test -e ${JSON.stringify(path)} && echo yes || echo no`],
    { raw: true, timeoutMs: 5_000 },
  );
  return probe.stdout.trim() === "yes";
}

async function runListScenarios(ctx: CliDockerContext, seeded: Project[], ws: Workspace): Promise<void> {
  // --json emits a JSON array the shape of which we can round-trip.
  const listJson = await ctx.exec(["project", "list", "--json"], { timeoutMs: 15_000 });
  assert(listJson.code === 0, `list --json exit: stderr=${listJson.stderr}`);
  const parsed = JSON.parse(listJson.stdout) as Project[];
  assert(Array.isArray(parsed), "list --json should emit an array");
  assert(
    parsed.length === seeded.length,
    `expected ${seeded.length} projects from list --json, got ${parsed.length}`,
  );
  for (const s of seeded) {
    assert(
      parsed.some((p) => p.id === s.id && p.name === s.name),
      `list --json missing seeded project ${s.name}`,
    );
  }

  // Plain (non-JSON) table mentions every seeded project's name.
  const listTable = await ctx.exec(["project", "list"], { timeoutMs: 15_000 });
  assert(listTable.code === 0, `list exit: stderr=${listTable.stderr}`);
  for (const s of seeded) {
    assert(
      listTable.stdout.includes(s.name),
      `list (table) missing project name ${s.name}: ${listTable.stdout}`,
    );
  }

  // --workspace <id> filter.
  const filterById = await ctx.exec(
    ["project", "list", "--workspace", String(ws.id), "--json"],
    { timeoutMs: 15_000 },
  );
  assert(filterById.code === 0, `list --workspace <id> exit: ${filterById.stderr}`);
  const byId = JSON.parse(filterById.stdout) as Project[];
  assert(
    byId.every((p) => p.workspaceId === ws.id),
    `list --workspace <id> leaked a non-workspace project: ${JSON.stringify(byId)}`,
  );
  assert(byId.length >= 1, `list --workspace <id> should include seeded workspace project`);

  // --workspace <name> resolves the name → id and filters identically.
  const filterByName = await ctx.exec(
    ["project", "list", "--workspace", ws.name, "--json"],
    { timeoutMs: 15_000 },
  );
  assert(filterByName.code === 0, `list --workspace <name> exit: ${filterByName.stderr}`);
  const byName = JSON.parse(filterByName.stdout) as Project[];
  assert(
    byName.length === byId.length,
    "list --workspace by name should match by-id result",
  );

  // Unknown workspace name → resolver throws, CLI exits 1 with a helpful msg.
  const missingWs = await ctx.exec(
    ["project", "list", "--workspace", "does-not-exist-xyz"],
    { timeoutMs: 15_000 },
  );
  assert(missingWs.code !== 0, "list --workspace <missing-name> should exit non-zero");
  assert(
    /No workspace found/i.test(missingWs.stderr),
    `list --workspace <missing-name> stderr: ${missingWs.stderr}`,
  );
}

async function runShowScenarios(ctx: CliDockerContext, seeded: Project): Promise<void> {
  // Show by id.
  const byId = await ctx.exec(["project", "show", String(seeded.id)], { timeoutMs: 15_000 });
  assert(byId.code === 0, `show <id> exit: ${byId.stderr}`);
  assert(byId.stdout.includes(`#${seeded.id}`), `show <id> missing id marker: ${byId.stdout}`);
  assert(byId.stdout.includes(seeded.name), `show <id> missing name: ${byId.stdout}`);

  // Show by name.
  const byName = await ctx.exec(["project", "show", seeded.name], { timeoutMs: 15_000 });
  assert(byName.code === 0, `show <name> exit: ${byName.stderr}`);
  assert(byName.stdout.includes(seeded.name), `show <name> missing name: ${byName.stdout}`);

  // --json output mode.
  const jsonOut = await ctx.exec(
    ["project", "show", String(seeded.id), "--json"],
    { timeoutMs: 15_000 },
  );
  assert(jsonOut.code === 0, `show --json exit: ${jsonOut.stderr}`);
  const parsed = JSON.parse(jsonOut.stdout) as Project;
  assert(parsed.id === seeded.id, "show --json id mismatch");
  assert(parsed.name === seeded.name, "show --json name mismatch");

  // Not-found by id.
  const missingId = await ctx.exec(
    ["project", "show", "999999"],
    { timeoutMs: 15_000 },
  );
  assert(missingId.code !== 0, "show <missing-id> should exit non-zero");

  // Not-found by name.
  const missingName = await ctx.exec(
    ["project", "show", "no-such-project-zzz"],
    { timeoutMs: 15_000 },
  );
  assert(missingName.code !== 0, "show <missing-name> should exit non-zero");
  assert(
    /No project found/i.test(missingName.stderr),
    `show <missing-name> stderr: ${missingName.stderr}`,
  );
}

async function runAmbiguousNameScenario(
  ctx: CliDockerContext,
  seed: ReturnType<typeof api>,
): Promise<void> {
  // Seed two projects with the same name; resolveByIdOrName must refuse.
  const dupName = "crud-dup-name";
  const p1 = await seed.createProject({ name: dupName });
  const p2 = await seed.createProject({ name: dupName });

  const ambig = await ctx.exec(["project", "show", dupName], { timeoutMs: 15_000 });
  assert(ambig.code !== 0, "show <ambiguous-name> should exit non-zero");
  assert(
    /Multiple projects named/i.test(ambig.stderr),
    `show <ambiguous-name> stderr: ${ambig.stderr}`,
  );
  // Clean up dups so later list-length asserts don't drift.
  await fetch(`${ctx.daemonUrl}/projects/${p1.id}`, { method: "DELETE" });
  await fetch(`${ctx.daemonUrl}/projects/${p2.id}`, { method: "DELETE" });
}

async function runUpdateScenarios(
  ctx: CliDockerContext,
  seed: ReturnType<typeof api>,
): Promise<void> {
  // No-flags invocation → exits 1 with guidance. Use a fresh project so
  // nothing accidentally sticks around from a previous partial update.
  const blank = await seed.createProject({ name: "crud-update-blank" });
  const noFlags = await ctx.exec(
    ["project", "update", String(blank.id)],
    { timeoutMs: 15_000 },
  );
  assert(noFlags.code !== 0, "update with no flags should exit non-zero");
  assert(
    /no update flags passed/i.test(noFlags.stderr),
    `update no-flags stderr: ${noFlags.stderr}`,
  );

  // Daemon-error catch branch: resolveByIdOrName throws DaemonError(404) for
  // an unknown id, which must be caught and rendered via exitWithDaemonError.
  const updateMissing = await ctx.exec(
    ["project", "update", "999999", "--name", "ghost"],
    { timeoutMs: 15_000 },
  );
  assert(updateMissing.code !== 0, "update <missing-id> should exit non-zero");

  // Each DB-backed flag, individually.
  const dbProject = await seed.createProject({ name: "crud-update-db" });
  const setName = await ctx.exec(
    ["project", "update", String(dbProject.id), "--name", "crud-update-db-renamed"],
    { timeoutMs: 15_000 },
  );
  assert(setName.code === 0, `update --name exit: ${setName.stderr}`);

  const setDesc = await ctx.exec(
    ["project", "update", String(dbProject.id), "--description", "desc-only"],
    { timeoutMs: 15_000 },
  );
  assert(setDesc.code === 0, `update --description exit: ${setDesc.stderr}`);

  const setPath = await ctx.exec(
    ["project", "update", String(dbProject.id), "--path", "/flockctl-home/update-path"],
    { timeoutMs: 15_000 },
  );
  assert(setPath.code === 0, `update --path exit: ${setPath.stderr}`);

  const setRepoUrl = await ctx.exec(
    [
      "project",
      "update",
      String(dbProject.id),
      "--repo-url",
      "https://example.invalid/repo.git",
    ],
    { timeoutMs: 15_000 },
  );
  assert(setRepoUrl.code === 0, `update --repo-url exit: ${setRepoUrl.stderr}`);

  // Confirm every DB-backed flag round-trips via show --json.
  const after = await ctx.exec(
    ["project", "show", String(dbProject.id), "--json"],
    { timeoutMs: 15_000 },
  );
  assert(after.code === 0, `show after DB updates exit: ${after.stderr}`);
  const afterParsed = JSON.parse(after.stdout) as Project;
  assert(
    afterParsed.name === "crud-update-db-renamed",
    `--name did not persist: ${afterParsed.name}`,
  );
  assert(
    afterParsed.description === "desc-only",
    `--description did not persist: ${afterParsed.description}`,
  );
  assert(
    afterParsed.path === "/flockctl-home/update-path",
    `--path did not persist: ${afterParsed.path}`,
  );
  assert(
    afterParsed.repoUrl === "https://example.invalid/repo.git",
    `--repo-url did not persist: ${afterParsed.repoUrl}`,
  );

  // Config-backed flags (live in <project>/.flockctl/config.json). Use a
  // project whose path points at a real directory so the reconciler doesn't
  // trip on the synthetic /flockctl-home/update-path we set above.
  const cfgProject = await seed.createProject({ name: "crud-update-cfg" });
  const setModel = await ctx.exec(
    ["project", "update", String(cfgProject.id), "--model", "claude-sonnet-4-5-20250929"],
    { timeoutMs: 15_000 },
  );
  assert(setModel.code === 0, `update --model exit: ${setModel.stderr}`);

  const setPlanningModel = await ctx.exec(
    [
      "project",
      "update",
      String(cfgProject.id),
      "--planning-model",
      "claude-opus-4-5-20250929",
    ],
    { timeoutMs: 15_000 },
  );
  assert(setPlanningModel.code === 0, `update --planning-model exit: ${setPlanningModel.stderr}`);

  const setBaseBranch = await ctx.exec(
    ["project", "update", String(cfgProject.id), "--base-branch", "develop"],
    { timeoutMs: 15_000 },
  );
  assert(setBaseBranch.code === 0, `update --base-branch exit: ${setBaseBranch.stderr}`);

  const setPermMode = await ctx.exec(
    [
      "project",
      "update",
      String(cfgProject.id),
      "--permission-mode",
      "acceptEdits",
    ],
    { timeoutMs: 15_000 },
  );
  assert(setPermMode.code === 0, `update --permission-mode exit: ${setPermMode.stderr}`);

  // Round-trip all four via GET /projects/:id/config.
  const cfg = await seed.getConfig(cfgProject.id);
  assert(
    cfg.model === "claude-sonnet-4-5-20250929",
    `config.model did not persist: ${JSON.stringify(cfg)}`,
  );
  assert(
    cfg.planningModel === "claude-opus-4-5-20250929",
    `config.planningModel did not persist: ${JSON.stringify(cfg)}`,
  );
  assert(cfg.baseBranch === "develop", `config.baseBranch did not persist: ${JSON.stringify(cfg)}`);
  assert(
    cfg.permissionMode === "acceptEdits",
    `config.permissionMode did not persist: ${JSON.stringify(cfg)}`,
  );

  // Multiple flags in a single invocation — exercises the combined-body branch
  // on the PATCH handler.
  const combo = await ctx.exec(
    [
      "project",
      "update",
      String(cfgProject.id),
      "--name",
      "crud-update-cfg-combo",
      "--description",
      "combo",
      "--model",
      "claude-haiku-4-5-20250929",
    ],
    { timeoutMs: 15_000 },
  );
  assert(combo.code === 0, `update combo exit: ${combo.stderr}`);
  const afterCombo = await ctx.exec(
    ["project", "show", String(cfgProject.id), "--json"],
    { timeoutMs: 15_000 },
  );
  const comboParsed = JSON.parse(afterCombo.stdout) as Project;
  assert(
    comboParsed.name === "crud-update-cfg-combo" && comboParsed.description === "combo",
    `combo update did not land: ${JSON.stringify(comboParsed)}`,
  );
  const cfgAfterCombo = await seed.getConfig(cfgProject.id);
  assert(
    cfgAfterCombo.model === "claude-haiku-4-5-20250929",
    `combo update did not refresh model: ${JSON.stringify(cfgAfterCombo)}`,
  );

  // --json output mode.
  const jsonUpdate = await ctx.exec(
    [
      "project",
      "update",
      String(cfgProject.id),
      "--description",
      "json-mode",
      "--json",
    ],
    { timeoutMs: 15_000 },
  );
  assert(jsonUpdate.code === 0, `update --json exit: ${jsonUpdate.stderr}`);
  const jsonUpdated = JSON.parse(jsonUpdate.stdout) as Project;
  assert(
    jsonUpdated.id === cfgProject.id && jsonUpdated.description === "json-mode",
    `update --json payload wrong: ${jsonUpdate.stdout}`,
  );

  // Clean up helper projects so the rm scenarios below start from a known set.
  await fetch(`${ctx.daemonUrl}/projects/${blank.id}`, { method: "DELETE" });
  await fetch(`${ctx.daemonUrl}/projects/${dbProject.id}`, { method: "DELETE" });
  await fetch(`${ctx.daemonUrl}/projects/${cfgProject.id}`, { method: "DELETE" });
}

async function runRmScenarios(
  ctx: CliDockerContext,
  seed: ReturnType<typeof api>,
): Promise<void> {
  // 1. Refuses without --yes.
  const victim1 = await seed.createProject({ name: "crud-rm-no-yes" });
  const refusal = await ctx.exec(
    ["project", "rm", String(victim1.id)],
    { timeoutMs: 15_000 },
  );
  assert(refusal.code !== 0, "rm without --yes should exit non-zero");
  assert(
    /Refusing to delete/i.test(refusal.stderr),
    `rm without --yes stderr: ${refusal.stderr}`,
  );
  // Project must still exist after the refusal.
  const stillThere = await fetch(`${ctx.daemonUrl}/projects/${victim1.id}`);
  assert(stillThere.ok, "project should not have been deleted when --yes was omitted");

  // 2. --yes drops the DB row but leaves the directory on disk.
  const victim2 = await seed.createProject({ name: "crud-rm-yes-only" });
  assert(victim2.path !== null, "seeded project must have a path");
  const preExists = await pathExistsInContainer(ctx, victim2.path!);
  assert(preExists, `seeded project dir ${victim2.path} should exist pre-rm`);
  const rmYes = await ctx.exec(
    ["project", "rm", String(victim2.id), "--yes"],
    { timeoutMs: 15_000 },
  );
  assert(rmYes.code === 0, `rm --yes exit: ${rmYes.stderr}`);
  const gone = await fetch(`${ctx.daemonUrl}/projects/${victim2.id}`);
  assert(gone.status === 404, "rm --yes should have removed the DB row");
  const stillOnDisk = await pathExistsInContainer(ctx, victim2.path!);
  assert(
    stillOnDisk,
    `rm --yes (no --purge) must not touch the on-disk path ${victim2.path}`,
  );

  // 3. --yes --purge also scrubs the on-disk path.
  const victim3 = await seed.createProject({ name: "crud-rm-purge" });
  assert(victim3.path !== null, "seeded project must have a path");
  const rmPurge = await ctx.exec(
    ["project", "rm", String(victim3.id), "--yes", "--purge"],
    { timeoutMs: 15_000 },
  );
  assert(rmPurge.code === 0, `rm --yes --purge exit: ${rmPurge.stderr}`);
  assert(
    /purged/.test(rmPurge.stdout),
    `rm --yes --purge stdout should mention purge: ${rmPurge.stdout}`,
  );
  const afterPurge = await pathExistsInContainer(ctx, victim3.path!);
  assert(
    !afterPurge,
    `rm --yes --purge left ${victim3.path} on disk`,
  );

  // 4. `remove` alias goes through the same code path.
  const victim4 = await seed.createProject({ name: "crud-rm-alias-remove" });
  const rmAlias = await ctx.exec(
    ["project", "remove", String(victim4.id), "--yes"],
    { timeoutMs: 15_000 },
  );
  assert(rmAlias.code === 0, `remove alias exit: ${rmAlias.stderr}`);
  const aliasGone = await fetch(`${ctx.daemonUrl}/projects/${victim4.id}`);
  assert(aliasGone.status === 404, "remove alias should have dropped the DB row");

  // 5. Not-found: unknown id → DaemonError(404).
  const notFound = await ctx.exec(
    ["project", "rm", "999999", "--yes"],
    { timeoutMs: 15_000 },
  );
  assert(notFound.code !== 0, "rm <missing-id> should exit non-zero");
}

await withCliDocker(async (ctx) => {
  // Boot the daemon. Bind to 0.0.0.0 inside the container so the host-mapped
  // port is reachable from the test process (see _harness.ts for why this is
  // safe in a container: docker only publishes 127.0.0.1:<hostPort>).
  const start = await ctx.exec(
    ["start", "--host", "0.0.0.0", "--allow-insecure-public"],
    { timeoutMs: DAEMON_BOOT_TIMEOUT_MS },
  );
  assert(start.code === 0, `flockctl start exit ${start.code}; stderr=${start.stderr}`);
  await ctx.waitForDaemon();

  const seed = api(ctx);

  // Empty-list scenario runs before any seeding so we exercise the "(none)"
  // branch in printRowTable.
  const empty = await ctx.exec(["project", "list"], { timeoutMs: 15_000 });
  assert(empty.code === 0, `initial list exit: ${empty.stderr}`);
  assert(
    /\(none\)/.test(empty.stdout),
    `expected initial list to print "(none)", got ${JSON.stringify(empty.stdout)}`,
  );

  // Seed: 1 workspace + 2 projects inside it + 1 standalone project.
  const ws = await seed.createWorkspace("crud-ws");
  const p1 = await seed.createProject({
    name: "crud-project-a",
    description: "first seeded project",
    workspaceId: ws.id,
  });
  const p2 = await seed.createProject({
    name: "crud-project-b",
    workspaceId: ws.id,
  });
  const p3 = await seed.createProject({ name: "crud-standalone" });
  const seeded = [p1, p2, p3];

  await runListScenarios(ctx, seeded, ws);
  await runShowScenarios(ctx, p1);
  await runAmbiguousNameScenario(ctx, seed);
  await runUpdateScenarios(ctx, seed);
  await runRmScenarios(ctx, seed);
});

console.log("project-crud: ok");
