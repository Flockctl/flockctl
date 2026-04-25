#!/usr/bin/env tsx
/**
 * flockctl workspace CRUD tests.
 *
 * Exercises every subcommand defined in `src/cli-commands/workspace.ts`:
 *   create (aka "add"), list, show, rm (aka "remove"), link, unlink.
 *
 * NOTE: workspace.ts does not expose an `update` subcommand — the /workspaces
 * PATCH endpoint is not wrapped by the CLI, so there is nothing to exercise
 * for updates here. The brief's "add/list/show/update/remove" was a rough
 * sketch; the authoritative list is whatever `registerWorkspaceCommand`
 * registers.
 *
 * For each subcommand we cover:
 *   - Happy path with minimal args.
 *   - Every optional flag exposed by Commander (read straight off the
 *     .option(...) calls in workspace.ts — --path, --description, --repo-url,
 *     --allowed-key-ids, --json, --yes).
 *   - Argument resolution via `resolveByIdOrName` — both numeric id and name.
 *   - Ambiguous-name path of the resolver. Workspace `name` is UNIQUE in the
 *     schema, but the resolver lowercases both sides, so two rows whose names
 *     differ only in case collide and hit the "Multiple workspaces named …"
 *     branch.
 *   - Not-found path (missing numeric id → DaemonError 404 rendered by
 *     exitWithDaemonError, missing name → "No workspace found" from the
 *     resolver).
 *   - `--json` output parses as JSON and matches the non-JSON row by id/name.
 *   - Daemon-unreachable path: stop the daemon mid-run, call a command, and
 *     assert the "Is it running? Start with: flockctl start" hint comes out
 *     of `exitWithDaemonError`.
 *
 * We deliberately do not poke the daemon's git scaffold or .flockctl/ layout.
 * Those belong to workspace-route tests; this file only asserts the CLI wires
 * args to the API correctly and renders responses. The one domain fact we
 * have to acknowledge is `parseRequiredAllowedKeyIdsOnCreate` — the /workspaces
 * POST now requires an active AI-provider-key id. We seed exactly one key via
 * the host-side daemon URL (not via the CLI, which has no `key add` command)
 * and hand that id to every `workspace create` invocation.
 *
 * Verification:
 *   npm run test:cli-docker -- --grep workspace
 */
import { assert, withCliDocker, type CliDockerContext, type ExecResult } from "./_harness.js";

function unique(label: string): string {
  return `${label}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Run a CLI command and fail loudly with the captured stderr if the exit code is wrong. */
async function runOk(ctx: CliDockerContext, cmd: string[], label: string): Promise<ExecResult> {
  const res = await ctx.exec(cmd);
  assert(
    res.code === 0,
    `${label}: expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
  );
  return res;
}

async function runFail(
  ctx: CliDockerContext,
  cmd: string[],
  label: string,
  needle: RegExp,
): Promise<ExecResult> {
  const res = await ctx.exec(cmd);
  assert(
    res.code !== 0,
    `${label}: expected non-zero exit, got 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
  );
  const combined = `${res.stdout}\n${res.stderr}`;
  assert(
    needle.test(combined),
    `${label}: expected output to match ${needle}, got:\n${combined}`,
  );
  return res;
}

/**
 * Create an AI provider key so `workspace create` has something valid to
 * point --allowed-key-ids at. The CLI has no `key add` command yet; go via
 * the daemon URL directly. claude_cli is used because its create path has
 * no keyValue requirement (unlike github_copilot).
 */
async function seedAiKey(daemonUrl: string): Promise<number> {
  const res = await fetch(`${daemonUrl}/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "claude_cli",
      providerType: "claude-agent-sdk",
      label: "workspace-test-key",
      isActive: true,
    }),
  });
  const text = await res.text();
  assert(res.ok, `POST /keys failed: ${res.status} ${text}`);
  const row = JSON.parse(text) as { id: number };
  assert(typeof row.id === "number", "POST /keys: no id in response");
  return row.id;
}

/**
 * Seed a project directly through the daemon (not the CLI) so that link /
 * unlink have something to attach. `project add` on the CLI is outside the
 * scope of this file and also requires allowedKeyIds plumbing we'd rather
 * not double-test here.
 */
async function seedProject(
  daemonUrl: string,
  name: string,
  path: string,
  keyId: number,
): Promise<number> {
  const res = await fetch(`${daemonUrl}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      path,
      allowedKeyIds: [keyId],
      importActions: [],
    }),
  });
  const text = await res.text();
  assert(res.ok, `POST /projects failed: ${res.status} ${text}`);
  const row = JSON.parse(text) as { id: number };
  assert(typeof row.id === "number", "POST /projects: no id in response");
  return row.id;
}

/**
 * Seed a bare git repo inside the container so we can exercise the
 * `--repo-url` branch of `workspace create` without hitting the network.
 * The repo has a single empty commit so `git clone` succeeds cleanly.
 */
async function seedBareRepo(ctx: CliDockerContext, barePath: string): Promise<void> {
  const script = [
    "set -e",
    `rm -rf /tmp/seed-src ${barePath}`,
    "mkdir -p /tmp/seed-src",
    "cd /tmp/seed-src",
    "git -c init.defaultBranch=main init -q",
    "git -c user.email=t@t.local -c user.name=seed commit --allow-empty -q -m init",
    "cd /",
    `git clone -q --bare /tmp/seed-src ${barePath}`,
  ].join(" && ");
  const res = await ctx.exec(["sh", "-c", script], { raw: true, timeoutMs: 30_000 });
  assert(
    res.code === 0,
    `seedBareRepo failed (exit ${res.code}): ${res.stderr || res.stdout}`,
  );
}

await withCliDocker(async (ctx) => {
  // ── 1. Boot the daemon ────────────────────────────────────────────────
  const start = await ctx.exec(
    ["start", "--host", "0.0.0.0", "--allow-insecure-public"],
    { timeoutMs: 30_000 },
  );
  assert(start.code === 0, `flockctl start failed: ${start.stderr}`);
  await ctx.waitForDaemon();

  // ── 2. Seed the bare git repo + AI key + project. None of these touch
  //    the workspace CLI; they set up the world the CLI will operate in.
  const barePath = "/flockctl-home/seed.git";
  await seedBareRepo(ctx, barePath);

  const keyId = await seedAiKey(ctx.daemonUrl);
  const allowedKeys = String(keyId);

  const tag = unique("ws");
  const nameA = `${tag}-a`;
  const nameB = `${tag}-b`;
  const nameC = `${tag}-c`;
  const nameD = `${tag}-d`;
  const nameDupLower = `${tag}-dup`;
  // Same text when lowercased → triggers the ambiguous-name branch in
  // resolveByIdOrName despite the UNIQUE index on workspaces.name.
  const nameDupUpper = nameDupLower.toUpperCase();
  const projName = `${tag}-proj`;
  const projPath = `/flockctl-home/${projName}`;

  // Make sure the project dir exists before the daemon tries to insert it.
  const mk = await ctx.exec(["mkdir", "-p", projPath], { raw: true, timeoutMs: 5_000 });
  assert(mk.code === 0, `mkdir project path: ${mk.stderr}`);
  const projectId = await seedProject(ctx.daemonUrl, projName, projPath, keyId);

  // ── 3. create — happy path with minimal args (no --path, no --description,
  //    no --repo-url, no --json). Covers the "Created workspace #N" path,
  //    the `created.path` log, and the falsy branch of `if (created.repoUrl)`.
  const createC = await runOk(
    ctx,
    ["workspace", "create", nameC, "--allowed-key-ids", allowedKeys],
    "create minimal",
  );
  assert(
    /Created workspace #\d+: /.test(createC.stdout),
    `create minimal: unexpected stdout:\n${createC.stdout}`,
  );
  assert(
    createC.stdout.includes(`  path: `),
    `create minimal: should log path line:\n${createC.stdout}`,
  );
  assert(
    !createC.stdout.includes("repoUrl:"),
    `create minimal: should NOT log repoUrl line (none was set):\n${createC.stdout}`,
  );

  // ── 4. create with --path + --description, no --repo-url.
  //    Covers the `if (opts.path)` and `if (opts.description)` branches.
  const createA = await runOk(
    ctx,
    [
      "workspace", "create", nameA,
      "--path", `/flockctl-home/${nameA}`,
      "--description", "Workspace A",
      "--allowed-key-ids", allowedKeys,
    ],
    "create --path --description",
  );
  assert(createA.stdout.includes(nameA), "create A: stdout should include name");

  // ── 5. create with --repo-url. Covers the `if (opts.repoUrl)` branch and
  //    the truthy branch of `if (created.repoUrl)`.
  const createB = await runOk(
    ctx,
    [
      "workspace", "create", nameB,
      "--path", `/flockctl-home/${nameB}`,
      "--repo-url", `file://${barePath}`,
      "--allowed-key-ids", allowedKeys,
    ],
    "create --repo-url",
  );
  assert(
    createB.stdout.includes(`repoUrl: file://${barePath}`),
    `create --repo-url: should echo the repoUrl line:\n${createB.stdout}`,
  );

  // ── 6. create with --json. Covers the `if (opts.json) printJson` branch.
  const createD = await runOk(
    ctx,
    [
      "workspace", "create", nameD,
      "--path", `/flockctl-home/${nameD}`,
      "--description", "JSON output",
      "--allowed-key-ids", allowedKeys,
      "--json",
    ],
    "create --json",
  );
  let createdDRow: { id: number; name: string; description: string | null };
  try {
    createdDRow = JSON.parse(createD.stdout);
  } catch (err) {
    throw new Error(
      `create --json: stdout was not valid JSON: ${(err as Error).message}\n${createD.stdout}`,
    );
  }
  assert(
    typeof createdDRow.id === "number" && createdDRow.name === nameD,
    `create --json: payload missing expected fields: ${createD.stdout}`,
  );
  assert(
    createdDRow.description === "JSON output",
    `create --json: description should round-trip: ${createD.stdout}`,
  );

  // ── 7. list — non-json. Covers printRowTable branch of `list`.
  const listPlain = await runOk(ctx, ["workspace", "list"], "list plain");
  for (const name of [nameA, nameB, nameC, nameD]) {
    assert(
      listPlain.stdout.includes(name),
      `list plain: should include ${name}\n${listPlain.stdout}`,
    );
  }

  // ── 8. list --json. Covers the `if (opts.json)` branch of `list`.
  const listJson = await runOk(ctx, ["workspace", "list", "--json"], "list --json");
  let listItems: Array<{ id: number; name: string }>;
  try {
    listItems = JSON.parse(listJson.stdout);
  } catch (err) {
    throw new Error(
      `list --json: output is not valid JSON: ${(err as Error).message}\n${listJson.stdout}`,
    );
  }
  assert(Array.isArray(listItems), "list --json: payload must be an array");
  const namesInList = new Set(listItems.map((r) => r.name));
  for (const name of [nameA, nameB, nameC, nameD]) {
    assert(namesInList.has(name), `list --json: should include ${name}`);
  }
  // Cross-check: D row in the list matches the create --json payload.
  const listedD = listItems.find((r) => r.id === createdDRow.id);
  assert(
    listedD !== undefined && listedD.name === createdDRow.name,
    "list --json: D row should match the id/name returned from create --json",
  );

  // ── 9. link — covers the link subcommand happy path. The project arg goes
  //    by name (resolver list-and-filter branch for "projects"), the
  //    workspace arg goes by numeric id (resolver fast path).
  const cRow = listItems.find((r) => r.name === nameC);
  assert(cRow, "could not find workspace C in list --json payload");
  const linkRes = await runOk(
    ctx,
    ["workspace", "link", String(cRow.id), projName],
    "link by id + name",
  );
  assert(
    /Linked project #\d+ ".+" into workspace #\d+ /.test(linkRes.stdout),
    `link: unexpected stdout:\n${linkRes.stdout}`,
  );

  // ── 10. show — by numeric id (resolver /^\d+$/ branch). Workspace A has a
  //    description and no linked projects → covers the description-present
  //    path AND the "(none)" projects branch.
  const aRow = listItems.find((r) => r.name === nameA);
  assert(aRow, "could not find workspace A in list --json payload");
  const showARes = await runOk(
    ctx,
    ["workspace", "show", String(aRow.id)],
    "show A by id",
  );
  assert(
    showARes.stdout.includes(`Workspace #${aRow.id}: ${nameA}`),
    `show A by id: unexpected header:\n${showARes.stdout}`,
  );
  assert(
    showARes.stdout.includes("description: Workspace A"),
    `show A by id: description line missing:\n${showARes.stdout}`,
  );
  assert(
    showARes.stdout.includes("repoUrl:     (none)"),
    `show A by id: should render "(none)" for null repoUrl:\n${showARes.stdout}`,
  );
  assert(
    showARes.stdout.includes("projects:    (none)"),
    `show A by id: should render "(none)" for empty projects list:\n${showARes.stdout}`,
  );

  // ── 11. show — by name (resolver list-and-filter branch). Workspace B has
  //    no description and a non-null repoUrl → covers the complementary
  //    branches to step 10.
  const showBRes = await runOk(
    ctx,
    ["workspace", "show", nameB],
    "show B by name",
  );
  assert(
    showBRes.stdout.includes(`Workspace #`) && showBRes.stdout.includes(nameB),
    `show B: unexpected stdout:\n${showBRes.stdout}`,
  );
  assert(
    !showBRes.stdout.includes("description:"),
    `show B: should NOT render description line (none was set):\n${showBRes.stdout}`,
  );
  assert(
    showBRes.stdout.includes(`repoUrl:     file://${barePath}`),
    `show B: should echo the repoUrl:\n${showBRes.stdout}`,
  );

  // ── 12. show --json — JSON path round-trips + matches the non-JSON row.
  const showBJson = await runOk(
    ctx,
    ["workspace", "show", nameB, "--json"],
    "show B --json",
  );
  let bRow: { id: number; name: string; repoUrl: string | null };
  try {
    bRow = JSON.parse(showBJson.stdout);
  } catch (err) {
    throw new Error(
      `show --json: not valid JSON: ${(err as Error).message}\n${showBJson.stdout}`,
    );
  }
  assert(bRow.name === nameB, "show --json: name mismatch");
  assert(
    bRow.repoUrl === `file://${barePath}`,
    `show --json: repoUrl mismatch (${bRow.repoUrl})`,
  );
  assert(
    showBRes.stdout.includes(`Workspace #${bRow.id}:`),
    `show --json: id ${bRow.id} should also appear in non-json show header:\n${showBRes.stdout}`,
  );

  // ── 13. show workspace C (has a linked project) → covers the
  //    `projects.length > 0` branch: the "projects (1):" header and the row.
  const showCRes = await runOk(
    ctx,
    ["workspace", "show", String(cRow.id)],
    "show C with linked project",
  );
  assert(
    /projects \(1\):/.test(showCRes.stdout),
    `show C: should report one linked project:\n${showCRes.stdout}`,
  );
  assert(
    showCRes.stdout.includes(projName),
    `show C: should list the linked project name:\n${showCRes.stdout}`,
  );

  // ── 13b. Null-path project rendering. projects.path is nullable in the
  //    schema, so the `p.path ?? ""` fallback on line 147 of workspace.ts is
  //    reachable — we just need a linked project whose path is NULL. Nudge
  //    the seeded project's path to NULL through the daemon DB (the REST
  //    API auto-derives path on create, so the easiest way is to side-door
  //    via better-sqlite3 inside the container), then re-show workspace C.
  //    Restore the path afterwards so later steps (unlink-by-name, etc.) see
  //    a well-formed row.
  const nullPathScript =
    `const Database=require('better-sqlite3');` +
    `const db=new Database('/flockctl-home/flockctl.db');` +
    `db.prepare('UPDATE projects SET path=NULL WHERE id=?').run(${projectId});`;
  const nullPath = await ctx.exec(
    ["node", "-e", nullPathScript],
    { raw: true, timeoutMs: 10_000 },
  );
  assert(
    nullPath.code === 0,
    `could not NULL project.path: exit ${nullPath.code}\n${nullPath.stderr}`,
  );
  const showCNullProjRes = await runOk(
    ctx,
    ["workspace", "show", String(cRow.id)],
    "show C with null-path linked project",
  );
  // The linked project row ends with two trailing spaces followed by ""
  // — `  ${projName}  ${p.path ?? ""}`. Assert on the projName + no path
  // substring, which only shows up when the `??` fallback branch fires.
  assert(
    new RegExp(`#${projectId}\\s+${projName}\\s*$`, "m").test(showCNullProjRes.stdout),
    `show C null-path: expected projName with empty path tail:\n${showCNullProjRes.stdout}`,
  );
  // Restore path so the rest of the test sees the original fixture.
  const restoreScript =
    `const Database=require('better-sqlite3');` +
    `const db=new Database('/flockctl-home/flockctl.db');` +
    `db.prepare('UPDATE projects SET path=? WHERE id=?').run(${JSON.stringify(projPath)}, ${projectId});`;
  const restore = await ctx.exec(
    ["node", "-e", restoreScript],
    { raw: true, timeoutMs: 10_000 },
  );
  assert(
    restore.code === 0,
    `could not restore project.path: exit ${restore.code}\n${restore.stderr}`,
  );

  // ── 13c. Null-path workspace rendering. `workspaces.path` is NOT NULL in
  //    the schema, so the `ws.path ?? "(none)"` fallback on line 141 of
  //    workspace.ts is not reachable by any normal DB path. To exercise it we
  //    temporarily rewrite the `workspaces` CREATE TABLE in sqlite_master via
  //    PRAGMA writable_schema, bump schema_version so the daemon's long-lived
  //    connection re-parses, UPDATE path=NULL, run `workspace show`, then
  //    restore the original schema + path. This is the only way to cover
  //    line 141 without editing workspace.ts itself.
  const bypassScript =
    `const Database=require('better-sqlite3');` +
    `const fs=require('fs');` +
    `const db=new Database('/flockctl-home/flockctl.db');` +
    `db.unsafeMode(true);` +
    `const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workspaces'").get();` +
    `const original=row.sql;` +
    `const relaxed=original.replace(/path\\s+TEXT\\s+NOT\\s+NULL/i,'path TEXT').replace(/'/g,"''");` +
    `if(relaxed===original.replace(/'/g,"''")){console.error('schema rewrite failed');process.exit(2);}` +
    // Capture the current path before nulling it so the restore step can put
    // the exact value back (the daemon derives path from homedir+slug, which
    // we don't want to replicate here).
    `const wsRow=db.prepare('SELECT path FROM workspaces WHERE id=?').get(${cRow.id});` +
    `fs.writeFileSync('/tmp/ws-schema.sql',original);` +
    `fs.writeFileSync('/tmp/ws-path.txt',wsRow.path);` +
    // better-sqlite3's prepare() refuses statements targeting sqlite_master
    // even with writable_schema on, so we go through db.exec which runs raw
    // SQL directly.
    `db.exec("PRAGMA writable_schema = 1");` +
    `db.exec("UPDATE sqlite_master SET sql='"+relaxed+"' WHERE type='table' AND name='workspaces'");` +
    `const ver=db.pragma('schema_version',{simple:true});` +
    `db.exec('PRAGMA schema_version = '+(ver+1));` +
    `db.exec("PRAGMA writable_schema = 0");` +
    `db.prepare('UPDATE workspaces SET path=NULL WHERE id=?').run(${cRow.id});`;
  const bypass = await ctx.exec(
    ["node", "-e", bypassScript],
    { raw: true, timeoutMs: 10_000 },
  );
  assert(
    bypass.code === 0,
    `could not NULL workspace.path: exit ${bypass.code}\n${bypass.stderr}`,
  );
  const showCNullWsRes = await runOk(
    ctx,
    ["workspace", "show", String(cRow.id)],
    "show C with null workspace path",
  );
  assert(
    /path:\s+\(none\)/.test(showCNullWsRes.stdout),
    `show C null-path ws: expected "(none)" fallback:\n${showCNullWsRes.stdout}`,
  );
  // Restore original schema + a valid path value so subsequent steps (e.g. the
  // ambiguous-name check, rm with --yes) see a well-formed row.
  const restoreWsScript =
    `const Database=require('better-sqlite3');` +
    `const fs=require('fs');` +
    `const db=new Database('/flockctl-home/flockctl.db');` +
    `db.unsafeMode(true);` +
    `const original=fs.readFileSync('/tmp/ws-schema.sql','utf8').replace(/'/g,"''");` +
    `const origPath=fs.readFileSync('/tmp/ws-path.txt','utf8');` +
    `db.prepare('UPDATE workspaces SET path=? WHERE id=?').run(origPath,${cRow.id});` +
    `db.exec("PRAGMA writable_schema = 1");` +
    `db.exec("UPDATE sqlite_master SET sql='"+original+"' WHERE type='table' AND name='workspaces'");` +
    `const ver=db.pragma('schema_version',{simple:true});` +
    `db.exec('PRAGMA schema_version = '+(ver+1));` +
    `db.exec("PRAGMA writable_schema = 0");`;
  const restoreWs = await ctx.exec(
    ["node", "-e", restoreWsScript],
    { raw: true, timeoutMs: 10_000 },
  );
  assert(
    restoreWs.code === 0,
    `could not restore workspace schema/path: exit ${restoreWs.code}\n${restoreWs.stderr}`,
  );

  // ── 14. unlink — inverse of link; covers the unlink subcommand happy path.
  //    Use name for workspace and numeric id for project to exercise both
  //    branches of resolveByIdOrName in the unlink action.
  const unlinkRes = await runOk(
    ctx,
    ["workspace", "unlink", nameC, String(projectId)],
    "unlink by name + id",
  );
  assert(
    /Unlinked project #\d+ ".+" from workspace #\d+ /.test(unlinkRes.stdout),
    `unlink: unexpected stdout:\n${unlinkRes.stdout}`,
  );

  // ── 15. not-found by id — DaemonError 404 rendered by exitWithDaemonError.
  await runFail(
    ctx,
    ["workspace", "show", "999999"],
    "show 404 id",
    /Error \(404\)/,
  );

  // ── 16. not-found by name — resolver throws a plain Error, still exit 1.
  await runFail(
    ctx,
    ["workspace", "show", "does-not-exist-anywhere"],
    "show missing name",
    /No workspace found with name/,
  );

  // ── 17. Ambiguous-name branch of resolveByIdOrName. workspaces.name is
  //    UNIQUE at the DB level, but the resolver lowercases before comparing,
  //    so rows that differ only in case collide.
  await runOk(
    ctx,
    [
      "workspace", "create", nameDupLower,
      "--path", `/flockctl-home/dup-lower`,
      "--allowed-key-ids", allowedKeys,
    ],
    "create dup lower",
  );
  await runOk(
    ctx,
    [
      "workspace", "create", nameDupUpper,
      "--path", `/flockctl-home/dup-upper`,
      "--allowed-key-ids", allowedKeys,
    ],
    "create dup upper",
  );
  await runFail(
    ctx,
    ["workspace", "show", nameDupLower],
    "show ambiguous",
    /Multiple workspaces named/,
  );

  // ── 18. rm — refusing without --yes (covers the `if (!opts.yes)` guard).
  await runFail(
    ctx,
    ["workspace", "rm", nameA],
    "rm without --yes",
    /Refusing to delete workspace #\d+/,
  );

  // ── 19. rm — happy path with --yes.
  const rmA = await runOk(
    ctx,
    ["workspace", "rm", nameA, "--yes"],
    "rm --yes",
  );
  assert(
    /Deleted workspace #\d+: /.test(rmA.stdout),
    `rm --yes: unexpected stdout:\n${rmA.stdout}`,
  );

  // ── 20. rm — not-found path. DaemonError 404 bubbles through
  //    exitWithDaemonError. Numeric ref so the 404 comes from the resolver's
  //    GET /workspaces/:id direct fetch (not the list filter).
  await runFail(
    ctx,
    ["workspace", "rm", "999999", "--yes"],
    "rm 404 id",
    /Error \(404\)/,
  );

  // ── 21. link — error path (workspace ref resolves to nothing). Exercises
  //    the catch/exitWithDaemonError branch in the link action.
  await runFail(
    ctx,
    ["workspace", "link", "does-not-exist-anywhere", projName],
    "link missing workspace",
    /No workspace found with name/,
  );

  // ── 22. unlink — same error shape for the unlink action's catch branch.
  await runFail(
    ctx,
    ["workspace", "unlink", "does-not-exist-anywhere", projName],
    "unlink missing workspace",
    /No workspace found with name/,
  );

  // ── 22b. create without --allowed-key-ids. The CLI's `if (opts.allowedKeyIds)`
  //    guard is falsy, the body goes out without the field, and the daemon
  //    returns a 400 (`parseRequiredAllowedKeyIdsOnCreate` requires ≥1 id).
  //    The exit-1 + DaemonError rendering round-trip exercises the create
  //    action's catch branch through exitWithDaemonError on the 4xx path too.
  await runFail(
    ctx,
    ["workspace", "create", `${tag}-no-key`],
    "create without --allowed-key-ids",
    /Error \(\d{3}\)/,
  );

  // ── 23. Invalid --allowed-key-ids entry. The CLI parses each comma-separated
  //    token with parseInt + Number.isFinite + > 0 guards and throws a plain
  //    Error when a token fails. That Error travels into the `create` catch
  //    block and out through exitWithDaemonError (non-DaemonError branch).
  //    This covers both the `throw new Error("Invalid --allowed-key-ids entry…")`
  //    inside the .map() callback and the action's catch branch.
  await runFail(
    ctx,
    [
      "workspace", "create", `${tag}-bad-key`,
      "--allowed-key-ids", "not-a-number",
    ],
    "create invalid --allowed-key-ids",
    /Invalid --allowed-key-ids entry: not-a-number/,
  );

  // ── 24. Daemon-unreachable path. Stop the daemon; the next CLI call
  //    should bubble a connect error through exitWithDaemonError and print
  //    the "Is it running?" hint from daemon-client.ts.
  const stop = await ctx.exec(["stop"], { timeoutMs: 15_000 });
  assert(stop.code === 0, `flockctl stop failed: ${stop.stderr}`);

  const unreachable = await ctx.exec(["workspace", "list"], { timeoutMs: 15_000 });
  assert(
    unreachable.code !== 0,
    `workspace list after stop should exit non-zero, got ${unreachable.code}`,
  );
  const combined = `${unreachable.stdout}\n${unreachable.stderr}`;
  assert(
    /Cannot reach Flockctl daemon at /.test(combined),
    `unreachable: expected "Cannot reach Flockctl daemon at" in output:\n${combined}`,
  );
  assert(
    /Is it running\? Start with: flockctl start/.test(combined),
    `unreachable: expected "Is it running? Start with: flockctl start" hint:\n${combined}`,
  );
});

console.log("workspace: ok");
