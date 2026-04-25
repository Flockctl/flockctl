import type { APIRequestContext } from "@playwright/test";

export function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

/**
 * Fetch the first active AI provider key id from the seeded defaults.
 *
 * POST /workspaces and POST /projects now REQUIRE a non-empty
 * `allowedKeyIds`. Every e2e test that creates a workspace/project
 * via the helpers indirectly depends on this, so we centralize the
 * lookup here and default to the seeded Claude CLI key that
 * `seedDefaultKey` always inserts on a fresh `.e2e-data` boot.
 *
 * Caller can still override by passing `allowedKeyIds` explicitly
 * in the `extra` bag — that path short-circuits this lookup.
 */
async function pickDefaultKeyId(request: APIRequestContext): Promise<number> {
  const res = await request.get("/keys?page=1&perPage=100");
  if (res.status() !== 200) {
    throw new Error(`GET /keys failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    items: Array<{ id: number; is_active?: boolean; isActive?: boolean }>;
  };
  const active = body.items.find((k) => (k.is_active ?? k.isActive) !== false);
  if (!active) {
    throw new Error("No active AI provider key available in e2e backend");
  }
  return active.id;
}

export async function createWorkspace(
  request: APIRequestContext,
  name?: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: number; name: string; path: string }> {
  const n = name ?? uniq("ws");
  const allowedKeyIds =
    (extra.allowedKeyIds as number[] | undefined) ?? [await pickDefaultKeyId(request)];
  const res = await request.post("/workspaces", {
    data: { name: n, path: `/tmp/${n}`, allowedKeyIds, ...extra },
  });
  if (res.status() !== 201) {
    throw new Error(`createWorkspace failed: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

export async function createProject(
  request: APIRequestContext,
  name?: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: number; name: string; path: string }> {
  const n = name ?? uniq("proj");
  const allowedKeyIds =
    (extra.allowedKeyIds as number[] | undefined) ?? [await pickDefaultKeyId(request)];
  const res = await request.post("/projects", {
    data: { name: n, path: `/tmp/${n}`, allowedKeyIds, ...extra },
  });
  if (res.status() !== 201) {
    throw new Error(`createProject failed: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

export async function createTask(
  request: APIRequestContext,
  projectId: number,
  extra: Record<string, unknown> = {},
): Promise<{ id: number }> {
  const res = await request.post("/tasks", {
    data: {
      projectId,
      prompt: `e2e prompt ${Date.now()}`,
      agent: "claude-code",
      workingDir: `/tmp/e2e-${Date.now()}`,
      ...extra,
    },
  });
  if (res.status() !== 201) {
    throw new Error(`createTask failed: ${res.status()} ${await res.text()}`);
  }
  const task = (await res.json()) as { id: number };
  await request.post(`/tasks/${task.id}/cancel`).catch(() => undefined);
  return task;
}

export async function createTemplate(
  request: APIRequestContext,
  name?: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: number; name: string }> {
  const n = name ?? uniq("tmpl");
  const res = await request.post("/templates", {
    data: {
      name: n,
      prompt: "template prompt",
      agent: "claude-code",
      workingDir: "/tmp/template",
      ...extra,
    },
  });
  if (res.status() !== 201) {
    throw new Error(`createTemplate failed: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}
