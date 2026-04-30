/**
 * Unit tests for `resolveMcpServersForSession` — the per-AgentSession bridge
 * that maps the project's effective MCP server set into the shape the Claude
 * Agent SDK consumes via `query({ mcpServers })`.
 *
 * These tests pin a contract that is easy to break and silent when broken:
 *
 *   The `${secret:NAME}` placeholders inside MCP env values MUST be resolved
 *   BEFORE the configs are handed to the SDK, because the SDK option
 *   overrides any on-disk `.mcp.json`. Without this resolution the spawned
 *   MCP child process receives literal "${secret:NAME}" strings in its env
 *   and any auth-bearing tool silently fails.
 *
 * The reconcile path (`reconcileMcpForProject` → `.mcp.json`) is covered in
 * `claude-sync-full.test.ts`. This file covers the sibling code path.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects, workspaces } from "../../db/schema.js";

let tmpBase: string;
let db: FlockctlDb;
let sqlite: Database.Database;

vi.mock("../../config", async () => {
  const actual = await vi.importActual<any>("../../config");
  return {
    ...actual,
    getFlockctlHome: () => tmpBase,
    getGlobalSkillsDir: () => join(tmpBase, "global-skills"),
    getGlobalMcpDir: () => join(tmpBase, "global-mcp"),
  };
});

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tmpBase = mkdtempSync(join(tmpdir(), "flockctl-session-mcp-"));
  mkdirSync(join(tmpBase, "global-mcp"), { recursive: true });
});

afterAll(() => {
  sqlite.close();
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(async () => {
  sqlite.exec(`DELETE FROM projects; DELETE FROM workspaces; DELETE FROM secrets;`);
  const mod = await import("../../services/secrets.js");
  mod._resetMasterKeyCache();
});

import { resolveMcpServersForSession } from "../../services/agent-session/session-mcp.js";

describe("resolveMcpServersForSession", () => {
  it("returns undefined when project has no MCP servers", () => {
    const projPath = mkdtempSync(join(tmpBase, "proj-empty-"));
    const proj = db
      .insert(projects)
      .values({ name: "p-empty", path: projPath })
      .returning()
      .get()!;

    expect(resolveMcpServersForSession(proj.id, "test-empty")).toBeUndefined();
  });

  it(
    "resolves ${secret:NAME} placeholders in env BEFORE handing configs to the SDK " +
      "(regression: SDK ignores .mcp.json when mcpServers option is provided)",
    async () => {
      const { upsertSecret } = await import("../../services/secrets.js");

      const wsPath = mkdtempSync(join(tmpBase, "ws-sess-secret-"));
      const ws = db
        .insert(workspaces)
        .values({ name: "ws-sess", path: wsPath })
        .returning()
        .get()!;
      const projPath = mkdtempSync(join(tmpBase, "proj-sess-secret-"));
      const proj = db
        .insert(projects)
        .values({ name: "p-sess", workspaceId: ws.id, path: projPath })
        .returning()
        .get()!;

      mkdirSync(join(projPath, ".flockctl", "mcp"), { recursive: true });
      writeFileSync(
        join(projPath, ".flockctl", "mcp", "github.json"),
        JSON.stringify({
          command: "npx",
          args: ["server-github"],
          env: { GITHUB_TOKEN: "${secret:GITHUB_TOKEN}", OTHER: "literal" },
        }),
      );
      upsertSecret({
        scope: "project",
        scopeId: proj.id,
        name: "GITHUB_TOKEN",
        value: "ghp_real_value",
      });

      const out = resolveMcpServersForSession(proj.id, "test-resolve");
      expect(out).toBeDefined();
      const cfg = (out as Record<string, Record<string, any>>)["github"];
      expect(cfg).toBeDefined();
      // The key invariant: the SDK must see the REAL secret value, not the
      // placeholder. Before the fix this assertion would fail because
      // `resolveMcpServersForProject` was forwarded straight to the SDK
      // without going through `resolveServerSecrets`.
      expect(cfg.env.GITHUB_TOKEN).toBe("ghp_real_value");
      expect(cfg.env.OTHER).toBe("literal");
    },
  );

  it("walks project > workspace > global precedence for secret values", async () => {
    const { upsertSecret } = await import("../../services/secrets.js");

    const wsPath = mkdtempSync(join(tmpBase, "ws-shadow-"));
    const ws = db
      .insert(workspaces)
      .values({ name: "ws-shadow", path: wsPath })
      .returning()
      .get()!;
    const projPath = mkdtempSync(join(tmpBase, "proj-shadow-"));
    const proj = db
      .insert(projects)
      .values({ name: "p-shadow", workspaceId: ws.id, path: projPath })
      .returning()
      .get()!;

    mkdirSync(join(projPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(projPath, ".flockctl", "mcp", "srv.json"),
      JSON.stringify({
        command: "node",
        env: { TOKEN: "${secret:TOKEN}" },
      }),
    );

    // Same name at all three scopes — project value must win.
    upsertSecret({ scope: "global", scopeId: null, name: "TOKEN", value: "global-val" });
    upsertSecret({ scope: "workspace", scopeId: ws.id, name: "TOKEN", value: "workspace-val" });
    upsertSecret({ scope: "project", scopeId: proj.id, name: "TOKEN", value: "project-val" });

    const out = resolveMcpServersForSession(proj.id, "test-shadow");
    const cfg = (out as Record<string, Record<string, any>>)["srv"];
    expect(cfg.env.TOKEN).toBe("project-val");
  });

  it("substitutes multiple placeholders + literal text in a single env value", async () => {
    const { upsertSecret } = await import("../../services/secrets.js");
    const projPath = mkdtempSync(join(tmpBase, "proj-multi-"));
    const proj = db
      .insert(projects)
      .values({ name: "p-multi", path: projPath })
      .returning()
      .get()!;

    mkdirSync(join(projPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(projPath, ".flockctl", "mcp", "db.json"),
      JSON.stringify({
        command: "pg-mcp",
        env: {
          DB_URL: "postgres://${secret:DB_USER}:${secret:DB_PASS}@db.local:5432/app",
        },
      }),
    );
    upsertSecret({ scope: "project", scopeId: proj.id, name: "DB_USER", value: "alice" });
    upsertSecret({ scope: "project", scopeId: proj.id, name: "DB_PASS", value: "p@ssw0rd" });

    const out = resolveMcpServersForSession(proj.id, "test-multi");
    const cfg = (out as Record<string, Record<string, any>>)["db"];
    expect(cfg.env.DB_URL).toBe("postgres://alice:p@ssw0rd@db.local:5432/app");
  });

  it("does NOT substitute placeholders inside args (env-only by design)", async () => {
    const { upsertSecret } = await import("../../services/secrets.js");
    const projPath = mkdtempSync(join(tmpBase, "proj-args-"));
    const proj = db
      .insert(projects)
      .values({ name: "p-args", path: projPath })
      .returning()
      .get()!;

    mkdirSync(join(projPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(projPath, ".flockctl", "mcp", "srv.json"),
      JSON.stringify({
        command: "node",
        // Placeholder in `args` — flockctl deliberately leaves these alone
        // so secrets never reach `ps`/argv. Documented in `mcp-sync.ts`.
        args: ["--token=${secret:TOKEN}"],
        env: {},
      }),
    );
    upsertSecret({ scope: "project", scopeId: proj.id, name: "TOKEN", value: "should-not-leak" });

    const out = resolveMcpServersForSession(proj.id, "test-args");
    const cfg = (out as Record<string, Record<string, any>>)["srv"];
    expect(cfg.args).toEqual(["--token=${secret:TOKEN}"]);
  });

  it("keeps placeholder + warns when the referenced secret is missing", () => {
    const projPath = mkdtempSync(join(tmpBase, "proj-miss-"));
    const proj = db
      .insert(projects)
      .values({ name: "p-miss", path: projPath })
      .returning()
      .get()!;

    mkdirSync(join(projPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(projPath, ".flockctl", "mcp", "srv.json"),
      JSON.stringify({ command: "node", env: { K: "${secret:UNKNOWN}" } }),
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = resolveMcpServersForSession(proj.id, "test-missing");
    const cfg = (out as Record<string, Record<string, any>>)["srv"];
    expect(cfg.env.K).toBe("${secret:UNKNOWN}");
    expect(warn).toHaveBeenCalled();
    const msg = (warn.mock.calls.find((c) => String(c[0]).includes("UNKNOWN"))?.[0]) as string | undefined;
    expect(msg).toMatch(/UNKNOWN/);
    warn.mockRestore();
  });

  it("preserves a value containing special chars (quotes, newlines) intact", async () => {
    const { upsertSecret } = await import("../../services/secrets.js");
    const projPath = mkdtempSync(join(tmpBase, "proj-special-"));
    const proj = db
      .insert(projects)
      .values({ name: "p-special", path: projPath })
      .returning()
      .get()!;

    mkdirSync(join(projPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(projPath, ".flockctl", "mcp", "srv.json"),
      JSON.stringify({ command: "node", env: { K: "${secret:WEIRD}" } }),
    );
    const weird = 'line1\nline2"with-quote\\and-backslash';
    upsertSecret({ scope: "project", scopeId: proj.id, name: "WEIRD", value: weird });

    const out = resolveMcpServersForSession(proj.id, "test-special");
    const cfg = (out as Record<string, Record<string, any>>)["srv"];
    // The bridge passes the raw value through to the SDK as a JS object;
    // string equality (not JSON re-encoding) is the right assertion.
    expect(cfg.env.K).toBe(weird);
  });
});
