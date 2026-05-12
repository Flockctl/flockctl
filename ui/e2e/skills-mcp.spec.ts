import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * E2E coverage for the redesigned `/skills-mcp` page (slice
 * `25-ui-redesign-library-surfaces/01-skills-mcp` T03).
 *
 * Two halves:
 *
 *   1. Behavioural — page heading visible, two-pane grid renders,
 *      independent error states per pane, "+ Add MCP" opens the
 *      shared M21 dialog.
 *
 *   2. Visual baselines (slice T03 expected_output) — default
 *      two-pane grid × light/dark + the empty state. Baselines live
 *      under `e2e/__screenshots__/skills-mcp.spec.ts/` per the
 *      `snapshotPathTemplate` in `playwright.config.ts`.
 *
 * Visual specs intercept the daemon's list endpoints so the snapshot
 * is reproducible regardless of whatever skills/servers the e2e
 * backend has accumulated. The clock is pinned so any "Xm ago"
 * footers (none today, but cheap insurance) render the same string
 * on every run.
 */

// ---------------------------------------------------------------------------
// Fixtures + freeze helpers
// ---------------------------------------------------------------------------

async function freeze(page: Page) {
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

async function pinTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("flockctl-theme", t);
    } catch {
      /* private mode etc. */
    }
  }, theme);
}

const T_NOW = "2026-05-07T10:00:00.000Z";

const FIXTURE_GLOBAL_SKILLS = [
  {
    name: "planning",
    level: "global" as const,
    content:
      "Decompose features into milestone → slice → task plans.\n\n# Planning skill\n\nMore content...",
  },
  {
    name: "debugging",
    level: "global" as const,
    content:
      "Reproduce the bug, isolate the root cause, then verify the fix.\n",
  },
  {
    name: "testing",
    level: "global" as const,
    content: "Run tests after every change. Verify green before claiming done.",
  },
];

const FIXTURE_GLOBAL_MCP = [
  {
    name: "github",
    level: "global" as const,
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${secret:GITHUB_TOKEN}" },
    },
  },
  {
    name: "filesystem",
    level: "global" as const,
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    },
  },
];

interface StubOpts {
  skills?: typeof FIXTURE_GLOBAL_SKILLS;
  mcpServers?: typeof FIXTURE_GLOBAL_MCP;
  /** When set, /skills/global returns 500 — the skills pane should
   *  flip to its error branch while the MCP pane stays healthy. */
  skillsFail?: boolean;
  /** Symmetric: /mcp/global → 500. Skills pane stays healthy. */
  mcpFail?: boolean;
}

/**
 * Stub every endpoint the page hydrates off so the visual baselines
 * never drift with the backend's accumulated seed state.
 */
async function stubSkillsMcpEndpoints(
  page: Page,
  opts: StubOpts = {},
): Promise<void> {
  const skills = opts.skills ?? FIXTURE_GLOBAL_SKILLS;
  const mcp = opts.mcpServers ?? FIXTURE_GLOBAL_MCP;
  const json = (o: unknown) => JSON.stringify(o);

  async function handleGlobalSkills(route: Route) {
    if (route.request().method() !== "GET") return route.fallback();
    if (opts.skillsFail) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: json({ error: "global skills lookup failed" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: json(skills),
    });
  }

  async function handleGlobalMcp(route: Route) {
    if (route.request().method() !== "GET") return route.fallback();
    if (opts.mcpFail) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: json({ error: "global mcp lookup failed" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: json(mcp),
    });
  }

  async function handleEmptyList(route: Route) {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: json({ items: [], total: 0 }),
    });
  }

  // /skills/global — Skill[] (NOT a paged envelope, see lib/api.ts)
  await page.route(/\/skills\/global(\?[^/]*)?$/, handleGlobalSkills);
  // /mcp/global — McpServer[]
  await page.route(/\/mcp\/global(\?[^/]*)?$/, handleGlobalMcp);
  // Workspaces / projects fetched for the scope selectors.
  await page.route(/\/workspaces(\?[^/]*)?$/, handleEmptyList);
  await page.route(/\/projects(\?[^/]*)?$/, handleEmptyList);
  // Attention badge etc — keep the shell quiet.
  await page.route(/\/attention(\?[^/]*)?$/, handleEmptyList);
}

// ---------------------------------------------------------------------------
// Behavioural specs
// ---------------------------------------------------------------------------

test("skills-mcp page renders heading", async ({ page }) => {
  await page.goto("/skills-mcp");
  await expect(
    page.getByRole("heading", { name: /Skills & MCP/i }),
  ).toBeVisible();
});

test("skills-mcp page renders the two-pane grid", async ({ page }) => {
  await stubSkillsMcpEndpoints(page);
  await page.goto("/skills-mcp");

  await expect(page.getByTestId("skills-mcp-grid")).toBeVisible();
  await expect(page.getByTestId("skills-mcp-skills-column")).toBeVisible();
  await expect(page.getByTestId("skills-mcp-mcp-column")).toBeVisible();
  // Both panes resolve to their happy-path bodies.
  await expect(page.getByTestId("skills-pane")).toBeVisible();
  await expect(page.getByTestId("mcp-pane")).toBeVisible();
});

test("skills-mcp panes have independent error states", async ({ page }) => {
  // Skills endpoint fails; MCP endpoint succeeds. The skills pane must
  // surface its error branch while the MCP pane stays in the happy path.
  await stubSkillsMcpEndpoints(page, { skillsFail: true });
  await page.goto("/skills-mcp");

  await expect(page.getByTestId("skills-pane-error")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("mcp-pane")).toBeVisible();
  await expect(page.getByTestId("skills-pane")).toHaveCount(0);
});

test("skills-mcp MCP pane error doesn't blank the skills pane", async ({
  page,
}) => {
  // Symmetric of the test above.
  await stubSkillsMcpEndpoints(page, { mcpFail: true });
  await page.goto("/skills-mcp");

  await expect(page.getByTestId("mcp-pane-error")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("skills-pane")).toBeVisible();
  await expect(page.getByTestId("mcp-pane")).toHaveCount(0);
});

test("Add MCP button opens the shared M21 dialog", async ({ page }) => {
  await stubSkillsMcpEndpoints(page);
  await page.goto("/skills-mcp");

  await expect(page.getByTestId("mcp-pane")).toBeVisible();
  await page.getByTestId("mcp-pane-add-button").click();

  // The shared M21 McpServerDialog renders a `Add MCP Server (global)`
  // title in create mode; assert the dialog surfaced.
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Add MCP Server|Edit MCP Server/i }),
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// Visual baselines (slice 25-01 T03).
//
// Default two-pane × light/dark, plus the initial empty state.
// Baselines live under e2e/__screenshots__/skills-mcp.spec.ts/ per
// the `snapshotPathTemplate` in playwright.config.ts.
// ---------------------------------------------------------------------------

test.describe("skills-mcp page — visual baselines", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`two-pane layout — ${theme}`, async ({ page }) => {
      await pinTheme(page, theme);
      await page.clock.install({ time: new Date(T_NOW) });
      await stubSkillsMcpEndpoints(page);

      await page.goto("/skills-mcp");
      await expect(
        page
          .getByTestId("skills-mcp-page")
          .getByRole("heading", { name: "Skills & MCP", level: 1 }),
      ).toBeVisible();
      await expect(page.getByTestId("skills-mcp-grid")).toBeVisible({
        timeout: 10_000,
      });
      // Wait for both panes to settle on their happy-path branches
      // before snapshotting — otherwise we may capture a half-rendered
      // skeleton frame.
      await expect(page.getByTestId("skills-pane")).toBeVisible();
      await expect(page.getByTestId("mcp-pane")).toBeVisible();
      const skillRows = page.getByTestId("skill-row");
      await expect(skillRows).toHaveCount(FIXTURE_GLOBAL_SKILLS.length);
      const mcpRows = page.getByTestId("mcp-row");
      await expect(mcpRows).toHaveCount(FIXTURE_GLOBAL_MCP.length);

      await freeze(page);
      await expect(page).toHaveScreenshot(
        `skills-mcp-default-${theme}.png`,
        {
          fullPage: true,
          threshold: 0.1,
          maxDiffPixelRatio: 0.02,
        },
      );
    });
  }

  test("empty state — no skills, no MCP servers", async ({ page }) => {
    await pinTheme(page, "light");
    await page.clock.install({ time: new Date(T_NOW) });
    await stubSkillsMcpEndpoints(page, { skills: [], mcpServers: [] });

    await page.goto("/skills-mcp");
    await expect(page.getByTestId("skills-mcp-grid")).toBeVisible({
      timeout: 10_000,
    });
    // SkillsPane renders its EmptyState when the list is empty;
    // McpPane renders the inline empty paragraph.
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await expect(page.getByTestId("mcp-pane-empty")).toBeVisible();

    await freeze(page);
    await expect(page).toHaveScreenshot("skills-mcp-empty.png", {
      fullPage: true,
      threshold: 0.1,
      maxDiffPixelRatio: 0.02,
    });
  });
});
