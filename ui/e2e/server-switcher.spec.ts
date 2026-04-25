import { test, expect } from "@playwright/test";

/**
 * Basic coverage for the <ServerSwitcher /> mounted in the sidebar. Verifies
 * the dropdown renders, exposes the Local server by default, and provides a
 * "Manage Servers…" link to /settings. The WS-reconnect-on-switch contract
 * is covered in the Vitest unit suite (`src/__tests__/lib/ws.test.tsx`)
 * because it requires mocking WebSocket — jumping between servers in a real
 * browser would need two live daemons plus a registered token pair, which
 * the e2e harness deliberately doesn't provision.
 */
test.describe("ServerSwitcher", () => {
  test("shows the Local server and can be opened", async ({ page }) => {
    await page.goto("/dashboard");

    const trigger = page.getByRole("button", { name: /switch server/i });
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText(/local/i);
    await expect(trigger).toContainText(/this machine/i);

    await trigger.click();
    // The dropdown label should be visible once opened.
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByText("Servers", { exact: true })).toBeVisible();
  });

  test("exposes a Manage Servers link that navigates to /settings", async ({ page }) => {
    await page.goto("/dashboard");

    const trigger = page.getByRole("button", { name: /switch server/i });
    await trigger.click();

    const manageLink = page.getByRole("menuitem", { name: /manage servers/i });
    await expect(manageLink).toBeVisible();
    await manageLink.click();

    await expect(page).toHaveURL(/\/settings$/);
    await expect(
      page.getByRole("heading", { name: /^Settings$/ }).first(),
    ).toBeVisible();
  });

  test("renders a connection status indicator", async ({ page }) => {
    await page.goto("/dashboard");

    const trigger = page.getByRole("button", { name: /switch server/i });
    await expect(trigger).toBeVisible();

    // Each of the three possible states exposes an aria-label on the dot.
    // We don't assert a specific state (order of health check vs. render is
    // non-deterministic) — just that one of the three is present.
    const states = ["connected", "checking", "error"];
    let found = false;
    for (const s of states) {
      const dot = trigger.locator(`[aria-label="${s}"]`);
      if ((await dot.count()) > 0) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
