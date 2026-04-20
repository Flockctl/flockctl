import type { APIRequestContext } from "@playwright/test";

export function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

export async function createWorkspace(
  request: APIRequestContext,
  name?: string,
): Promise<{ id: number; name: string; path: string }> {
  const n = name ?? uniq("ws");
  const res = await request.post("/workspaces", {
    data: { name: n, path: `/tmp/${n}` },
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
  const res = await request.post("/projects", {
    data: { name: n, path: `/tmp/${n}`, ...extra },
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
