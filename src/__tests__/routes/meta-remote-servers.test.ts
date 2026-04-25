import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import Database from "better-sqlite3";
import { remoteServersPostDeps } from "../../routes/meta.js";
import { _resetRcCache } from "../../config/paths.js";

// Slice 01/02 schema tests + slice 03 validation-surface coverage.
//
// The POST handler now runs the full create pipeline (ssh-exec bootstrap,
// rc persistence, tunnel open). For the schema-layer tests below we stub
// every IO-heavy dep so a validation-valid body resolves to a 201 without
// touching a real ssh child, the real rc file, or a real tunnel manager.
//
// The rich pipeline-behavior tests live in remote-servers-post.test.ts.

let db: FlockctlDb;
let sqlite: Database.Database;
let tmpHome: string;
const origHome = process.env.HOME;
const origDeps = { ...remoteServersPostDeps };

beforeAll(() => {
  // Isolate rc file writes so a valid POST doesn't mutate the developer's
  // real ~/.flockctlrc. `process.env.HOME` is re-read by os.homedir() on
  // every rc load, so flipping it here is sufficient (no module reload).
  tmpHome = mkdtempSync(join(tmpdir(), "flockctl-meta-rs-schema-"));
  process.env.HOME = tmpHome;
  _resetRcCache();

  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  _resetRcCache();
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  Object.assign(remoteServersPostDeps, origDeps);
  sqlite.close();
});

// Install happy-path stubs for every test in this file. The goal here is
// only to exercise validation — we do NOT want a real ssh child or a real
// tunnel. Individual tests can overwrite a field if they need a different
// observable state, and the afterAll hook restores the real deps.
beforeEach(() => {
  remoteServersPostDeps.sshExec = async () => ({
    stdout: "a".repeat(43),
    stderr: "",
    exitCode: 0,
  });
  remoteServersPostDeps.manager = {
    async start(server) {
      return {
        serverId: server.id,
        localPort: 52078,
        status: "ready",
        readyAt: Date.now(),
      };
    },
  };
  remoteServersPostDeps.hostname = () => "test-host";
  delete remoteServersPostDeps.afterSaveBeforeStart;
  _resetRcCache();
});

async function postJson(body: unknown) {
  return app.request("/meta/remote-servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function patchJson(id: string, body: unknown) {
  return app.request(`/meta/remote-servers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /meta/remote-servers validation", () => {
  it("runs the full pipeline and returns 201 when a minimal valid body is accepted", async () => {
    // Happy path: schema accepts, stubs short-circuit the pipeline, handler
    // returns 201 with the slice-03 response shape.
    const res = await postJson({ name: "Prod", ssh: { host: "web01" } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      name: "Prod",
      ssh: { host: "web01" },
      tunnelPort: 52078,
      tunnelStatus: "ready",
    });
    expect(typeof body.id).toBe("string");
  });

  it("accepts a fully-populated ssh block", async () => {
    const res = await postJson({
      name: "Staging",
      ssh: {
        host: "stage.example.com",
        user: "deploy",
        port: 2222,
        identityFile: "/home/me/.ssh/id_ed25519",
        remotePort: 52077,
      },
    });
    expect(res.status).toBe(201);
  });

  describe("legacy_transport_rejected", () => {
    // Anything that looks like the pre-SSH payload shape — `url` and/or
    // `token` at the top level — is mapped to the legacy errorCode so the
    // client can surface a dedicated "this daemon is SSH-only now" message.
    it("rejects a body with a top-level `url` key", async () => {
      const res = await postJson({ name: "Legacy", url: "http://10.0.0.2:52077" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("legacy_transport_rejected");
      expect(typeof body.message).toBe("string");
      expect(body.message.length).toBeGreaterThan(0);
    });

    it("rejects a body with a top-level `token` key", async () => {
      const res = await postJson({ name: "Legacy", token: "secret-123" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("legacy_transport_rejected");
    });

    it("rejects even when the body is otherwise a valid ssh config", async () => {
      // `url` still wins — the discriminator is a raw-body presence check,
      // not a "only if validation would have failed" check.
      const res = await postJson({
        name: "Legacy",
        ssh: { host: "web01" },
        url: "http://10.0.0.2:52077",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("legacy_transport_rejected");
    });

    it("does not leak the token value back in the error message", async () => {
      const res = await postJson({ name: "Legacy", token: "supersecret-xyz" });
      const bodyText = await res.text();
      expect(bodyText).not.toContain("supersecret-xyz");
    });
  });

  describe("invalid_ssh_config", () => {
    it("rejects a missing `ssh` block", async () => {
      const res = await postJson({ name: "NoSsh" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("invalid_ssh_config");
    });

    it("rejects a missing `ssh.host`", async () => {
      const res = await postJson({ name: "NoHost", ssh: {} });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("invalid_ssh_config");
    });

    it("rejects an empty-string `name`", async () => {
      const res = await postJson({ name: "   ", ssh: { host: "web01" } });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("invalid_ssh_config");
    });

    it("rejects an out-of-range ssh.port", async () => {
      const res = await postJson({
        name: "BadPort",
        ssh: { host: "web01", port: 70000 },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("invalid_ssh_config");
    });

    it("rejects an out-of-range ssh.remotePort", async () => {
      const res = await postJson({
        name: "BadRemotePort",
        ssh: { host: "web01", remotePort: 0 },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("invalid_ssh_config");
    });

    it("rejects extra unknown top-level keys via .strict()", async () => {
      const res = await postJson({
        name: "Extra",
        ssh: { host: "web01" },
        nonsense: true,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("invalid_ssh_config");
    });

    it("rejects extra unknown keys nested inside ssh via .strict()", async () => {
      const res = await postJson({
        name: "ExtraNested",
        ssh: { host: "web01", dragons: "here" },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("invalid_ssh_config");
    });

    it("rejects a malformed JSON body", async () => {
      const res = await postJson("{ not json");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("invalid_ssh_config");
    });

    it("rejects a non-object JSON body (array)", async () => {
      const res = await postJson([{ name: "x" }]);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("invalid_ssh_config");
    });
  });

  describe("ssh_host_regex_matches_valid_forms", () => {
    // Every form users actually type should be accepted. The handler is
    // still stubbed so success is observable via the 501 return code.
    const validHosts = [
      "host",
      "user@host",
      "host.domain.tld",
      "host:22",
      "host-alias-from-ssh-config",
      "192.168.1.1",
    ];

    for (const host of validHosts) {
      it(`accepts ssh.host = ${JSON.stringify(host)}`, async () => {
        const res = await postJson({ name: "Accept", ssh: { host } });
        expect(res.status).toBe(201);
      });
    }
  });

  describe("ssh_host_regex_rejects_control_chars", () => {
    // Shell metacharacters, control characters, whitespace, and non-ASCII
    // should all be rejected up front so users get a 400 instead of an
    // opaque ssh-spawn failure later.
    const invalidHosts: Array<[string, string]> = [
      ["newline", "host\nname"],
      ["tab", "host\tname"],
      ["backtick", "host`rm -rf /`"],
      ["command substitution", "host$(whoami)"],
      ["space", "host name"],
      ["unicode smiley", "host\u{1F600}"],
    ];

    for (const [label, host] of invalidHosts) {
      it(`rejects ssh.host containing ${label}`, async () => {
        const res = await postJson({ name: "Bad", ssh: { host } });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.errorCode).toBe("invalid_ssh_config");
      });
    }
  });
});

describe("PATCH /meta/remote-servers/:id validation", () => {
  // NB: these tests focus on the validation surface only. The handler is
  // now wired end-to-end (see remote-servers-crud.test.ts for the full
  // PATCH behavior), so a validation-valid body against an *unknown* id
  // returns 404 rather than the historical 501 placeholder.
  it("returns 404 when a minimal valid body targets an unknown id", async () => {
    const res = await patchJson("srv-1", { name: "Renamed" });
    expect(res.status).toBe(404);
  });

  it("accepts a partial ssh update (404 because id is unknown)", async () => {
    const res = await patchJson("srv-1", { ssh: { port: 2222 } });
    expect(res.status).toBe(404);
  });

  it("accepts an empty object (no-op update) — schema permits it", async () => {
    // PATCH bodies in REST are allowed to be empty; the handler no-ops
    // when no field changes but the validator must not reject it. Still
    // 404 because `srv-1` is not in the rc store.
    const res = await patchJson("srv-1", {});
    expect(res.status).toBe(404);
  });

  describe("legacy_transport_rejected", () => {
    it("rejects a PATCH with top-level `url`", async () => {
      const res = await patchJson("srv-1", { url: "http://10.0.0.2:52077" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("legacy_transport_rejected");
    });

    it("rejects a PATCH with top-level `token`", async () => {
      const res = await patchJson("srv-1", { token: "abc" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("legacy_transport_rejected");
    });

    it("rejects a PATCH with top-level `token: null` (legacy clear)", async () => {
      // Even `null` counts — the legacy client used `{token: null}` to clear
      // the stored token. The discriminator is presence of the key, not the
      // value.
      const res = await patchJson("srv-1", { token: null });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("legacy_transport_rejected");
    });
  });

  describe("invalid_ssh_config", () => {
    it("rejects an empty-string `name`", async () => {
      const res = await patchJson("srv-1", { name: "   " });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("invalid_ssh_config");
    });

    it("rejects an out-of-range ssh.port", async () => {
      const res = await patchJson("srv-1", { ssh: { port: 70000 } });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("invalid_ssh_config");
    });

    it("rejects ssh.host containing control characters", async () => {
      const res = await patchJson("srv-1", { ssh: { host: "host\nname" } });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("invalid_ssh_config");
    });

    it("rejects extra unknown top-level keys", async () => {
      const res = await patchJson("srv-1", { nonsense: 1 });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("invalid_ssh_config");
    });

    it("rejects malformed JSON", async () => {
      const res = await patchJson("srv-1", "{ not json");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe("invalid_ssh_config");
    });
  });
});
