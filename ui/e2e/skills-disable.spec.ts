import { test, expect } from "@playwright/test";
import { uniq, createWorkspace, createProject } from "./_helpers";

test("workspace skill can be disabled and re-enabled via API", async ({ request }) => {
  const ws = await createWorkspace(request);

  // Create a workspace-level skill
  const createRes = await request.post(`/skills/workspaces/${ws.id}/skills`, {
    data: { name: uniq("ws-skill"), content: "# skill body" },
  });
  expect(createRes.status()).toBe(201);
  const skill = await createRes.json();

  // Disable at workspace level
  const disableRes = await request.post(`/skills/workspaces/${ws.id}/disabled`, {
    data: { name: skill.name, level: "workspace" },
  });
  expect(disableRes.status()).toBe(200);
  const disabledBody = await disableRes.json();
  expect(disabledBody.disabledSkills).toContainEqual({ name: skill.name, level: "workspace" });

  // GET reflects disabled list
  const getRes = await request.get(`/skills/workspaces/${ws.id}/disabled`);
  expect(getRes.status()).toBe(200);
  expect((await getRes.json()).disabledSkills).toContainEqual({ name: skill.name, level: "workspace" });

  // Re-enable via DELETE
  const enableRes = await request.delete(`/skills/workspaces/${ws.id}/disabled`, {
    data: { name: skill.name, level: "workspace" },
  });
  expect(enableRes.status()).toBe(200);
  expect((await enableRes.json()).disabledSkills).not.toContainEqual({
    name: skill.name,
    level: "workspace",
  });
});

test("project can disable a workspace-level skill (inherited disable)", async ({ request }) => {
  const ws = await createWorkspace(request);
  const proj = await createProject(request, undefined, { workspaceId: ws.id });

  // Create a workspace skill — project should see it in resolved
  const skillName = uniq("inh-skill");
  const createRes = await request.post(`/skills/workspaces/${ws.id}/skills`, {
    data: { name: skillName, content: "# inherited" },
  });
  expect(createRes.status()).toBe(201);

  // Project disables the workspace skill
  const disableRes = await request.post(`/skills/projects/${proj.id}/disabled`, {
    data: { name: skillName, level: "workspace" },
  });
  expect(disableRes.status()).toBe(200);
  expect((await disableRes.json()).disabledSkills).toContainEqual({
    name: skillName,
    level: "workspace",
  });

  // Resolved list for the project should not include this skill
  const resolvedRes = await request.get(`/skills/resolved?projectId=${proj.id}`);
  expect(resolvedRes.status()).toBe(200);
  const resolved = await resolvedRes.json();
  expect(resolved.find((s: { name: string }) => s.name === skillName)).toBeUndefined();

  // GET project disabled to confirm persistence
  const projDisabled = await request.get(`/skills/projects/${proj.id}/disabled`);
  expect(projDisabled.status()).toBe(200);
  expect((await projDisabled.json()).disabledSkills).toContainEqual({
    name: skillName,
    level: "workspace",
  });
});

test("skills-mcp page renders scope selectors", async ({ page }) => {
  await page.goto("/skills-mcp");
  await expect(page.getByRole("heading", { name: /Skills & MCP/i })).toBeVisible();
  // Scope labels
  await expect(page.getByText("Workspace", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Project", { exact: true }).first()).toBeVisible();
});

test("disable button is present on own workspace skill row", async ({ page, request }) => {
  const ws = await createWorkspace(request);
  const skillName = uniq("ui-skill");
  const createRes = await request.post(`/skills/workspaces/${ws.id}/skills`, {
    data: { name: skillName, content: "# ui" },
  });
  expect(createRes.status()).toBe(201);

  await page.goto("/skills-mcp");

  // Select the workspace from the dropdown
  await page.locator("button").filter({ hasText: /All \/ Global only/ }).first().click();
  await page.getByRole("option", { name: ws.name }).click();

  // The skill row should be visible
  await expect(page.getByText(skillName).first()).toBeVisible({ timeout: 10_000 });

  // The "Disable skill" toggle should be present for own skills
  await expect(
    page.getByRole("button", { name: /Disable skill|Enable skill/ }).first(),
  ).toBeVisible();
});
