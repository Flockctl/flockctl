import { test, expect } from "@playwright/test";
import { uniq } from "./_helpers";

test("schedules page lists a cron schedule created via API", async ({ page, request }) => {
  const tmplName = uniq("sched-tmpl");
  const tmplRes = await request.post("/templates", {
    data: {
      name: tmplName,
      scope: "global",
      prompt: "template prompt",
      agent: "claude-code",
      workingDir: "/tmp/template",
    },
  });
  if (tmplRes.status() !== 201) {
    throw new Error(`createTemplate failed: ${tmplRes.status()} ${await tmplRes.text()}`);
  }

  const schedRes = await request.post("/schedules", {
    data: {
      templateScope: "global",
      templateName: tmplName,
      scheduleType: "cron",
      cronExpression: "0 */6 * * *",
      timezone: "UTC",
    },
  });
  expect(schedRes.status()).toBe(201);

  await page.goto("/schedules");
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
  await expect(page.getByText(tmplName).first()).toBeVisible({ timeout: 10_000 });
});

test("schedules page calls GET /schedules on load", async ({ page }) => {
  const listed = page.waitForResponse(
    (r) => /\/schedules(\?|$)/.test(r.url()) && r.request().method() === "GET",
  );
  await page.goto("/schedules");
  const res = await listed;
  expect(res.status()).toBe(200);
});
