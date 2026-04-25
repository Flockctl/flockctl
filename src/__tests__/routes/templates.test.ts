import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects, workspaces } from "../../db/schema.js";
import Database from "better-sqlite3";

let db: FlockctlDb;
let sqlite: Database.Database;
let homeDir: string;
let origHome: string | undefined;
let wsId: number;
let wsPath: string;
let projId: number;
let projPath: string;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);

  origHome = process.env.FLOCKCTL_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "flockctl-tpl-"));
  process.env.FLOCKCTL_HOME = homeDir;

  wsPath = mkdtempSync(join(tmpdir(), "flockctl-tpl-ws-"));
  wsId = db.insert(workspaces).values({ name: "ws-a", path: wsPath }).returning().get()!.id;
  projPath = mkdtempSync(join(tmpdir(), "flockctl-tpl-proj-"));
  projId = db.insert(projects).values({ name: "proj-a", path: projPath }).returning().get()!.id;
});

afterAll(() => {
  sqlite.close();
  if (origHome === undefined) delete process.env.FLOCKCTL_HOME;
  else process.env.FLOCKCTL_HOME = origHome;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(wsPath, { recursive: true, force: true });
  rmSync(projPath, { recursive: true, force: true });
});

beforeEach(() => {
  // Wipe every on-disk template between tests so each starts clean.
  rmSync(join(homeDir, "templates"), { recursive: true, force: true });
  rmSync(join(wsPath, ".flockctl", "templates"), { recursive: true, force: true });
  rmSync(join(projPath, ".flockctl", "templates"), { recursive: true, force: true });
});

describe("Templates routes", () => {
  it("GET /templates returns empty list when no files exist", async () => {
    const res = await app.request("/templates");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("POST /templates creates a global template", async () => {
    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "run-tests",
        scope: "global",
        description: "Run all tests",
        prompt: "Execute npm test",
        model: "claude-sonnet-4-20250514",
      }),
    });
    expect(res.status).toBe(201);
    const tmpl = await res.json();
    expect(tmpl.name).toBe("run-tests");
    expect(tmpl.scope).toBe("global");
    expect(tmpl.model).toBe("claude-sonnet-4-20250514");
  });

  it("GET /templates/:scope/:name returns template", async () => {
    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "lookup",
        scope: "global",
        prompt: "hi",
        model: "claude-sonnet-4-20250514",
      }),
    });
    const res = await app.request("/templates/global/lookup");
    expect(res.status).toBe(200);
    const tmpl = await res.json();
    expect(tmpl.name).toBe("lookup");
    expect(tmpl.model).toBe("claude-sonnet-4-20250514");
  });

  it("PATCH /templates/:scope/:name updates a template", async () => {
    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "patchable",
        scope: "global",
        description: "old",
      }),
    });
    const res = await app.request("/templates/global/patchable", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "new" }),
    });
    expect(res.status).toBe(200);
    const tmpl = await res.json();
    expect(tmpl.description).toBe("new");
    // Name + scope are identity — must not change.
    expect(tmpl.name).toBe("patchable");
    expect(tmpl.scope).toBe("global");
  });

  it("DELETE /templates/:scope/:name deletes a template", async () => {
    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "tombstone", scope: "global" }),
    });
    const delRes = await app.request("/templates/global/tombstone", { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const getRes = await app.request("/templates/global/tombstone");
    expect(getRes.status).toBe(404);
  });

  it("POST /templates requires name", async () => {
    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", description: "no name" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /templates requires scope", async () => {
    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "noscope" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /templates with all optional fields round-trips via GET", async () => {
    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "full-template",
        scope: "global",
        description: "desc",
        prompt: "p",
        agent: "claude-code",
        model: "claude-sonnet-4-6",
        image: "ubuntu:22.04",
        workingDir: "/work",
        envVars: { FOO: "bar" },
        timeoutSeconds: 600,
        labelSelector: "team=backend",
      }),
    });
    expect(res.status).toBe(201);
    const tmpl = await res.json();
    expect(tmpl.name).toBe("full-template");
    expect(tmpl.image).toBe("ubuntu:22.04");
    expect(tmpl.envVars).toEqual({ FOO: "bar" });
    expect(tmpl.workingDir).toBe("/work");
    expect(tmpl.timeoutSeconds).toBe(600);

    const patchRes = await app.request("/templates/global/full-template", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "new",
        prompt: "p2",
        agent: "openai",
        model: "gpt-x",
        image: "node:20",
        workingDir: "/repo",
        envVars: { BAZ: "qux" },
        timeoutSeconds: 30,
        labelSelector: "team=ops",
      }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.description).toBe("new");
    expect(patched.workingDir).toBe("/repo");
    expect(patched.envVars).toEqual({ BAZ: "qux" });
  });

  it("PATCH /templates with envVars cleared sets envVars null", async () => {
    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "clear-env",
        scope: "global",
        envVars: { A: "1" },
      }),
    });
    const res = await app.request("/templates/global/clear-env", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envVars: null }),
    });
    expect(res.status).toBe(200);
    const patched = await res.json();
    expect(patched.envVars).toBeNull();
  });

  it("GET /templates with no filter aggregates globals + every workspace/project", async () => {
    // Drop one template in each scope, then hit the unfiltered list —
    // all three should come back (the Templates page's "All" scope view
    // relies on this).
    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "g-one", scope: "global" }),
    });
    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "w-one", scope: "workspace", workspace_id: wsId }),
    });
    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "p-one", scope: "project", project_id: projId }),
    });

    const res = await app.request("/templates");
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = body.items.map((t: any) => t.name).sort();
    expect(names).toEqual(["g-one", "p-one", "w-one"]);
    const scopes = new Set(body.items.map((t: any) => t.scope));
    expect(scopes).toEqual(new Set(["global", "workspace", "project"]));
  });

  it("POST /templates accepts snake_case body fields (UI payload shape)", async () => {
    // The UI's TaskTemplateCreate type is snake_case; the route must accept
    // that shape (in addition to camelCase) or fields get silently dropped.
    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "ui-shape",
        scope: "project",
        project_id: projId,
        timeout_seconds: 600,
        working_dir: "/tmp/repo",
        env_vars: { FOO: "bar" },
        label_selector: "team=qa",
      }),
    });
    expect(res.status).toBe(201);
    const tmpl = await res.json();
    expect(tmpl.project_id ?? tmpl.projectId).toBe(projId);
    expect(tmpl.timeout_seconds ?? tmpl.timeoutSeconds).toBe(600);
    expect(tmpl.working_dir ?? tmpl.workingDir).toBe("/tmp/repo");
    expect(tmpl.env_vars ?? tmpl.envVars).toEqual({ FOO: "bar" });
    expect(tmpl.label_selector ?? tmpl.labelSelector).toBe("team=qa");
  });

  it("PATCH /templates accepts snake_case body fields (UI payload shape)", async () => {
    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ui-patch", scope: "global" }),
    });
    const res = await app.request("/templates/global/ui-patch", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timeout_seconds: 900,
        working_dir: "/var/repo",
      }),
    });
    expect(res.status).toBe(200);
    const tmpl = await res.json();
    expect(tmpl.timeout_seconds ?? tmpl.timeoutSeconds).toBe(900);
    expect(tmpl.working_dir ?? tmpl.workingDir).toBe("/var/repo");
  });

  it("PATCH /templates returns 404 for missing template", async () => {
    const res = await app.request("/templates/global/not-there", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /templates returns 404 for missing template", async () => {
    const res = await app.request("/templates/global/not-there", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("GET /templates filters by project_id", async () => {
    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "proj-scoped",
        scope: "project",
        projectId: projId,
        description: "project one",
      }),
    });
    // Create an unrelated global template to make sure the filter excludes it.
    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "global-one", scope: "global" }),
    });

    const res = await app.request(`/templates?scope=project&project_id=${projId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.some((t: any) => t.name === "proj-scoped")).toBe(true);
    expect(body.items.every((t: any) => t.scope === "project")).toBe(true);
    expect(body.items.every((t: any) => t.project_id === projId || t.projectId === projId)).toBe(true);
  });

  it("GET /templates filters by workspace_id", async () => {
    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "ws-scoped",
        scope: "workspace",
        workspaceId: wsId,
      }),
    });

    const res = await app.request(`/templates?scope=workspace&workspace_id=${wsId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.some((t: any) => t.name === "ws-scoped")).toBe(true);
    expect(body.items.every((t: any) => t.scope === "workspace")).toBe(true);
  });

  it("POST /templates rejects workspace scope without workspaceId", async () => {
    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad-ws", scope: "workspace" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /templates rejects project scope without projectId", async () => {
    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad-proj", scope: "project" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /templates returns 409 when a template with the same (scope, name) already exists", async () => {
    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dup", scope: "global" }),
    });
    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dup", scope: "global" }),
    });
    expect(res.status).toBe(409);
  });

  // ── parseOptionalInt rejection branches (non-finite + non-integer + <= 0) ──
  it("GET /templates?workspace_id=abc rejects non-numeric string with 422", async () => {
    const res = await app.request("/templates?workspace_id=abc");
    expect(res.status).toBe(422);
  });

  it("GET /templates?workspace_id=1.5 rejects non-integer with 422", async () => {
    const res = await app.request("/templates?workspace_id=1.5");
    expect(res.status).toBe(422);
  });

  it("GET /templates?workspace_id=0 rejects zero with 422", async () => {
    const res = await app.request("/templates?workspace_id=0");
    expect(res.status).toBe(422);
  });

  it("GET /templates?workspace_id=-1 rejects negative with 422", async () => {
    const res = await app.request("/templates?workspace_id=-1");
    expect(res.status).toBe(422);
  });

  // ── POST body = non-object → 422 ──
  it("POST /templates rejects non-object JSON body (bare string)", async () => {
    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("not an object"),
    });
    expect(res.status).toBe(422);
  });

  // ── PATCH body = non-object → 422 ──
  it("PATCH /templates/:scope/:name rejects non-object JSON body", async () => {
    // Seed a template so PATCH gets past the lookup step (though it won't here).
    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "patch-target", scope: "global" }),
    });
    const res = await app.request("/templates/global/patch-target", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("nope"),
    });
    expect(res.status).toBe(422);
  });

  // ── toTemplateError: non-TemplateError bubble-through ──
  it("POST /templates with invalid name surfaces invalid_name → 400", async () => {
    // TemplateService validates names strictly — path-traversal components fail.
    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "../escape", scope: "global" }),
    });
    expect(res.status).toBe(400);
  });
});
