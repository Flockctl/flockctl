/**
 * Settings page — structural smokes + visual baselines.
 *
 * The settings surface is the redesigned `/settings` route. The page
 * assembles three blocks:
 *
 *   <h1>Settings</h1>
 *   <SettingsTabs />          (AI Keys / Server / Secrets / Skills)
 *   <Section />               (the four sections, one mounted at a time)
 *
 * This spec ships:
 *
 *   1. **Structural smokes**
 *      - The page renders the redesigned four-tab strip, in order.
 *      - The active tab is driven by the `?tab=` query param (default
 *        `ai-keys`); clicking a tab updates the URL.
 *      - The four section components mount when their tab is active.
 *      - Negative regressions: secrets list endpoint is hit on the
 *        Secrets tab; existing GET /keys load is preserved.
 *
 *   2. **Visual baselines** — full-page screenshots covering each tab ×
 *      theme (4 × 2 = 8 baselines):
 *        - settings-{ai-keys,server,secrets,skills}-{light,dark}.png
 *
 *      Each shot pins theme via `flockctl-theme` localStorage, freezes
 *      animations, stubs the daemon endpoints the active section reads,
 *      and clears the per-section localStorage keys so the screenshot
 *      doesn't drift with whatever a previous test wrote.
 *
 * Regenerate baselines with:
 *   cd ui && npm run e2e:update -- e2e/settings.spec.ts
 */

import { test, expect, type Page, type Route } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_NOW_ISO = "2026-05-07T12:00:00.000Z";

interface SecretFixture {
  id: number;
  scope: "global";
  scope_id: null;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function defaultSecretsFixture(): SecretFixture[] {
  return [
    {
      id: 1,
      scope: "global",
      scope_id: null,
      name: "GITHUB_TOKEN",
      description: "GitHub PAT used by the github MCP",
      created_at: FIXTURE_NOW_ISO,
      updated_at: FIXTURE_NOW_ISO,
    },
    {
      id: 2,
      scope: "global",
      scope_id: null,
      name: "OPENAI_API_KEY",
      description: null,
      created_at: FIXTURE_NOW_ISO,
      updated_at: FIXTURE_NOW_ISO,
    },
  ];
}

async function pinTheme(page: Page, theme: "light" | "dark") {
  // Reset the localStorage keys that each section hydrates from so the
  // baseline doesn't pick up mutations from earlier tests in the run.
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("flockctl-theme", t);
      // Clear sections that hydrate from localStorage so the snapshot
      // represents the empty-state shape.
      for (const key of [
        "flockctl.skills.source.system",
        "flockctl.skills.source.user",
        "flockctl.skills.source.project",
      ]) {
        window.localStorage.removeItem(key);
      }
    } catch {
      /* private mode etc. */
    }
  }, theme);
}

async function freezeAnimations(page: Page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
    `,
  });
}

/**
 * Stub the daemon endpoints the settings sections read so baselines
 * don't drift with whatever the seeded e2e backend happens to return.
 *
 * Endpoints stubbed:
 *   GET /meta/version  — Server tab version display.
 *   GET /meta/update   — Server tab update-state poll.
 *   GET /secrets/global — Secrets tab list.
 *   GET /keys?...      — preserves the existing AI-keys load (for the
 *                         Account tab's parent shell, if any consumer
 *                         renders during navigation).
 */
async function stubSettingsBackend(
  page: Page,
  options: {
    secrets?: SecretFixture[];
  } = {},
) {
  const backendPort = Number(process.env.E2E_BACKEND_PORT ?? 52078);
  const apiOrigin = `http://127.0.0.1:${backendPort}`;
  const secrets = options.secrets ?? defaultSecretsFixture();

  const respond = async (route: Route, payload: unknown, status = 200) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  };

  await page.route(`${apiOrigin}/meta/version`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, {
        current: "0.42.0",
        latest: "0.42.0",
        update_available: false,
        install_mode: "npm",
      });
      return;
    }
    await route.fallback();
  });

  await page.route(`${apiOrigin}/meta/update`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, { status: "idle" });
      return;
    }
    await route.fallback();
  });

  await page.route(`${apiOrigin}/secrets/global`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, { secrets });
      return;
    }
    await route.fallback();
  });

  await page.route(`${apiOrigin}/keys?**`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, { items: [], total: 0 });
      return;
    }
    await route.fallback();
  });
}

async function waitForSettingsReady(page: Page) {
  await expect(page.getByTestId("settings-page")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("settings-tabs")).toBeVisible();
  // Wait out the shell's "Connecting to Local…" banner so screenshots
  // don't capture a layout shift from its eventual disappearance.
  await expect(page.locator("text=/^Connecting to /")).toHaveCount(0, {
    timeout: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Structural smokes
// ---------------------------------------------------------------------------

test.describe("Settings page — structural smokes", () => {
  test("renders the page heading and the four-tab strip in order", async ({
    page,
  }) => {
    await stubSettingsBackend(page);
    await page.goto("/settings");
    await waitForSettingsReady(page);

    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).toBeVisible();

    const tabs = page.getByTestId("settings-tabs").getByRole("tab");
    await expect(tabs).toHaveCount(4);
    const labels = await tabs.allTextContents();
    expect(labels.map((l) => l.trim())).toEqual([
      "AI Keys",
      "Server",
      "Secrets",
      "Skills",
    ]);
  });

  test("default URL renders the AI Keys section", async ({ page }) => {
    await stubSettingsBackend(page);
    await page.goto("/settings");
    await waitForSettingsReady(page);

    await expect(page.getByTestId("settings-tabpanel-ai-keys")).toBeVisible();
  });

  test("clicking a tab swaps the section and updates the URL", async ({
    page,
  }) => {
    await stubSettingsBackend(page);
    await page.goto("/settings");
    await waitForSettingsReady(page);

    await page.getByTestId("settings-tab-skills").click();
    await expect(page).toHaveURL(/\/settings\?tab=skills$/);
    await expect(page.getByTestId("skills-section")).toBeVisible();
    await expect(page.getByTestId("settings-tabpanel-skills")).toBeVisible();
  });

  test("each tab mounts its own section component", async ({ page }) => {
    await stubSettingsBackend(page);
    await page.goto("/settings");
    await waitForSettingsReady(page);

    const matrix: Array<{ tab: string; sectionTestId: string }> = [
      { tab: "settings-tab-server", sectionTestId: "server-section-header" },
      { tab: "settings-tab-secrets", sectionTestId: "secrets-section" },
      { tab: "settings-tab-skills", sectionTestId: "skills-section" },
    ];
    for (const { tab, sectionTestId } of matrix) {
      await page.getByTestId(tab).click();
      await expect(page.getByTestId(sectionTestId)).toBeVisible();
    }
  });
});

// ---------------------------------------------------------------------------
// Negative-path tests called out in the slice spec
// ---------------------------------------------------------------------------

test.describe("Settings page — negative paths", () => {
  test("opening the Secrets tab fires GET /secrets/global", async ({
    page,
  }) => {
    await stubSettingsBackend(page);
    const listed = page.waitForResponse(
      (r) =>
        r.url().includes("/secrets/global") &&
        r.request().method() === "GET",
    );
    await page.goto("/settings?tab=secrets");
    await waitForSettingsReady(page);
    const res = await listed;
    expect(res.status()).toBe(200);
    await expect(page.getByTestId("secrets-list")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Visual baselines — tab × theme matrix
// ---------------------------------------------------------------------------

const VISUAL_TABS = [
  {
    slug: "ai-keys",
    url: "/settings",
    sentinel: "settings-tabpanel-ai-keys",
  },
  {
    slug: "server",
    url: "/settings?tab=server",
    sentinel: "server-section-header",
  },
  {
    slug: "secrets",
    url: "/settings?tab=secrets",
    sentinel: "secrets-section",
  },
  {
    slug: "skills",
    url: "/settings?tab=skills",
    sentinel: "skills-section",
  },
] as const;

test.describe("Settings page — visual baselines", () => {
  for (const variant of VISUAL_TABS) {
    for (const theme of ["light", "dark"] as const) {
      test(`settings-${variant.slug}-${theme} baseline`, async ({ page }) => {
        await pinTheme(page, theme);
        await stubSettingsBackend(page);

        await page.goto(variant.url);
        await waitForSettingsReady(page);
        await expect(page.getByTestId(variant.sentinel)).toBeVisible({
          timeout: 10_000,
        });
        await freezeAnimations(page);

        await expect(page).toHaveScreenshot(
          `settings-${variant.slug}-${theme}.png`,
          {
            fullPage: true,
            threshold: 0.1,
            maxDiffPixelRatio: 0.02,
          },
        );
      });
    }
  }
});
