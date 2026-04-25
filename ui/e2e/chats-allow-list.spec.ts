import { test, expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { uniq } from "./_helpers";

/**
 * End-to-end coverage for the project allow-list → chat key auto-select bug.
 *
 * Regression scenario (reported by a user): when a project restricts its AI
 * providers to a single key (e.g. only "Work" is enabled) and a chat is
 * created against that project without an explicit `aiProviderKeyId`, both
 * the backend POST /chats handler AND the UI auto-select effect must land
 * on the Work key — never on the rc-level default (e.g. "Personal") that
 * the project's allow-list excludes.
 *
 * Two entry points must work:
 *   1. Project detail → "New chat from this project" dialog flow (seeded via
 *      POST /chats with `projectId` only, matches the UI code path).
 *   2. Deep-link to `/chats/:id` directly (what the UI does after dialog
 *      close, and what a reload from another tab would hit).
 *
 * These tests intentionally create every prerequisite (keys, workspace,
 * project, chat) via the API so they are hermetic with respect to whatever
 * the seeded default claude_cli key happens to look like in `.e2e-data`.
 */

async function createKey(
  request: APIRequestContext,
  label: string,
): Promise<{ id: number; label: string }> {
  // claude_cli provider doesn't require a keyValue — only provider +
  // providerType are mandatory. The label is what the UI renders in the
  // composer dropdown (`k.name` falls back to `label` on the list view).
  const res = await request.post("/keys", {
    data: {
      provider: "claude_cli",
      providerType: "claude-agent-sdk",
      label,
      isActive: true,
    },
  });
  if (res.status() !== 201) {
    throw new Error(`createKey failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: number; label: string };
  return { id: body.id, label: body.label };
}

async function createWorkspaceWithKeys(
  request: APIRequestContext,
  allowedKeyIds: number[],
): Promise<{ id: number; name: string }> {
  const name = uniq("ws-allow");
  const res = await request.post("/workspaces", {
    data: { name, path: `/tmp/${name}`, allowedKeyIds },
  });
  if (res.status() !== 201) {
    throw new Error(
      `createWorkspaceWithKeys failed: ${res.status()} ${await res.text()}`,
    );
  }
  return res.json();
}

async function createProjectWithKeys(
  request: APIRequestContext,
  workspaceId: number,
  allowedKeyIds: number[],
): Promise<{ id: number; name: string }> {
  const name = uniq("proj-allow");
  const res = await request.post("/projects", {
    data: {
      name,
      path: `/tmp/${name}`,
      workspaceId,
      allowedKeyIds,
    },
  });
  if (res.status() !== 201) {
    throw new Error(
      `createProjectWithKeys failed: ${res.status()} ${await res.text()}`,
    );
  }
  return res.json();
}

test("POST /chats with a project-restricted key auto-fills allowed key", async ({ request }) => {
  // Two distinct active keys. Personal is the rc-level default candidate
  // (lower priority = higher preference in the fallback picker), Work is
  // the one and only entry on the project's allow-list.
  const personal = await createKey(request, uniq("Personal"));
  const work = await createKey(request, uniq("Work"));

  // Workspace allows BOTH — so the narrowing is unambiguously the project's
  // doing. This mirrors the original bug report: workspace was permissive,
  // project locked down to Work only.
  const ws = await createWorkspaceWithKeys(request, [personal.id, work.id]);
  const proj = await createProjectWithKeys(request, ws.id, [work.id]);

  // Create a chat against the project WITHOUT specifying aiProviderKeyId —
  // this is exactly what the New-Chat dialog does from the project page.
  const chatRes = await request.post("/chats", {
    data: {
      title: uniq("chat-allow"),
      projectId: proj.id,
      workspaceId: ws.id,
    },
  });
  expect([200, 201]).toContain(chatRes.status());
  const chat = (await chatRes.json()) as {
    id: number;
    aiProviderKeyId: number | null;
  };

  // Backend contract: the stored key MUST be the allow-list member, never
  // NULL (would leak to rc-default = Personal at send time) and never
  // Personal (explicitly excluded by the project).
  expect(chat.aiProviderKeyId).toBe(work.id);
});

test("chat composer shows the allowed key when opened from the project path", async ({ page, request }) => {
  const personal = await createKey(request, uniq("Personal"));
  const work = await createKey(request, uniq("Work"));
  const ws = await createWorkspaceWithKeys(request, [personal.id, work.id]);
  const proj = await createProjectWithKeys(request, ws.id, [work.id]);

  const title = uniq("chat-ui-allow");
  const chatRes = await request.post("/chats", {
    data: { title, projectId: proj.id, workspaceId: ws.id },
  });
  expect([200, 201]).toContain(chatRes.status());
  const chat = (await chatRes.json()) as { id: number };

  // Navigate directly — this is the path the UI actually renders (dialog
  // close pushes to `/chats/:id`). The auto-select effect must settle on
  // the Work key and NOT flash Personal even momentarily-then-stick.
  await page.goto(`/chats/${chat.id}`);
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 });

  const trigger = page.getByTestId("chat-key-select");
  await expect(trigger).toBeVisible({ timeout: 10_000 });

  // Assert the rendered label. The trigger shows the <SelectValue> which
  // mirrors `k.name` (backend maps `name = label`). We wait via `toHaveText`
  // to ride out the allow-list fetch + key-list fetch race.
  await expect(trigger).toContainText(work.label, { timeout: 10_000 });
  // Negative: Personal must NEVER win the race. Check text strictly does
  // not contain the personal label — a stray flip would leave it showing.
  await expect(trigger).not.toContainText(personal.label);
});

test("switching chats between two allow-listed projects updates the key selector", async ({ page, request }) => {
  // Two projects, each with a distinct single-key allow-list. Opening a
  // chat from each must land on its own project's key — proves the UI
  // doesn't cache the first pick when the allow-list changes under it.
  const personal = await createKey(request, uniq("Personal"));
  const work = await createKey(request, uniq("Work"));
  const ws = await createWorkspaceWithKeys(request, [personal.id, work.id]);

  const workProj = await createProjectWithKeys(request, ws.id, [work.id]);
  const personalProj = await createProjectWithKeys(request, ws.id, [personal.id]);

  const workChat = await request
    .post("/chats", {
      data: {
        title: uniq("chat-work"),
        projectId: workProj.id,
        workspaceId: ws.id,
      },
    })
    .then((r) => r.json() as Promise<{ id: number; aiProviderKeyId: number | null }>);
  const personalChat = await request
    .post("/chats", {
      data: {
        title: uniq("chat-personal"),
        projectId: personalProj.id,
        workspaceId: ws.id,
      },
    })
    .then((r) => r.json() as Promise<{ id: number; aiProviderKeyId: number | null }>);

  expect(workChat.aiProviderKeyId).toBe(work.id);
  expect(personalChat.aiProviderKeyId).toBe(personal.id);

  await page.goto(`/chats/${workChat.id}`);
  const trigger = page.getByTestId("chat-key-select");
  await expect(trigger).toContainText(work.label, { timeout: 10_000 });

  await page.goto(`/chats/${personalChat.id}`);
  await expect(trigger).toContainText(personal.label, { timeout: 10_000 });
});
