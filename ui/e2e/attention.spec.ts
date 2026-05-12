/**
 * Attention page — structural smokes + visual baselines (slice
 * `24-ui-redesign-working-surfaces/04-attention`, T03).
 *
 * The attention surface is the redesigned global inbox at `/attention`. The
 * page assembles three blocks:
 *
 *   <SectionHeader title="Attention" subtitle="{n} items" />
 *   <AttentionSection priority="critical" /> (failed tasks)
 *   <AttentionSection priority="normal"   /> (agent questions, mission proposals)
 *   — or, when both buckets are empty —
 *   <EmptyState />
 *
 * This spec ships:
 *
 *   1. **Structural smokes** — the page header is the new `Attention` h1
 *      from `SectionHeader size="page"`, the bucketed sections render with
 *      the right priority subtitles, the empty state mounts when both
 *      sources return nothing.
 *
 *   2. **Visual baselines** — six full-page screenshots covering the
 *      content × theme matrix:
 *        - attention-default-{light,dark}.png       (critical + normal)
 *        - attention-critical-only-{light,dark}.png (failed tasks only)
 *        - attention-empty-{light,dark}.png         (no items at all)
 *
 *      Each shot pins theme via `flockctl-theme` localStorage, freezes
 *      animations, and stubs the network so the snapshot does not drift
 *      with whatever is in the seeded e2e backend.
 *
 * Network stubs
 * -------------
 * `useAttentionInbox` merges three sources:
 *   - `useAgentQuestionsAll` → derives from `GET /attention` (filters for
 *     `task_question` / `chat_question` rows). We stub `/attention`.
 *   - `useFailedTasks24h` → derives from `GET /tasks?status=failed&...`.
 *     We stub `/tasks*` to control the critical bucket.
 *   - `useMissionProposalsAll` → currently returns an empty array client-
 *     side (the parent slice's audit findings flagged this). No network.
 *
 * Regenerate baselines with:
 *   cd ui && npm run e2e:update -- e2e/attention.spec.ts
 */

import { test, expect, type Page, type Route } from "@playwright/test";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FIXTURE_NOW_ISO = "2026-05-07T12:00:00.000Z";

interface AttentionFixtureItem {
  kind: "task_question" | "chat_question";
  request_id: string;
  task_id?: string;
  chat_id?: string;
  project_id: string | null;
  question: string;
  multi_select: boolean;
  created_at: string;
}

interface FailedTaskFixture {
  id: string;
  status: "failed";
  prompt: string;
  prompt_file: null;
  agent: "claude-code";
  model: null;
  actual_model_used: null;
  timeout_seconds: number;
  project_id: string | null;
  assigned_key_id: null;
  assigned_key_label: null;
  exit_code: 1;
  started_at: string;
  completed_at: string;
  working_dir: null;
  created_at: string;
  updated_at: string;
  git_commit_before: null;
  git_commit_after: null;
  git_diff_summary: null;
  requires_approval: false;
  approval_status: null;
  approved_at: null;
  approval_note: null;
  permission_mode: null;
  parent_task_id: null;
}

function makeFailedTask(
  overrides: Partial<FailedTaskFixture> & Pick<FailedTaskFixture, "id" | "prompt">,
): FailedTaskFixture {
  return {
    status: "failed",
    prompt_file: null,
    agent: "claude-code",
    model: null,
    actual_model_used: null,
    timeout_seconds: 600,
    project_id: "1",
    assigned_key_id: null,
    assigned_key_label: null,
    exit_code: 1,
    started_at: FIXTURE_NOW_ISO,
    completed_at: FIXTURE_NOW_ISO,
    working_dir: null,
    created_at: FIXTURE_NOW_ISO,
    updated_at: FIXTURE_NOW_ISO,
    git_commit_before: null,
    git_commit_after: null,
    git_diff_summary: null,
    requires_approval: false,
    approval_status: null,
    approved_at: null,
    approval_note: null,
    permission_mode: null,
    parent_task_id: null,
    ...overrides,
  };
}

function defaultAttentionFixture(): AttentionFixtureItem[] {
  // Agent questions surface as `normal`-priority rows in the inbox merge.
  return [
    {
      kind: "task_question",
      request_id: "req-1",
      task_id: "100",
      project_id: "1",
      question: "Which file should I edit first — index.ts or app.ts?",
      multi_select: false,
      created_at: FIXTURE_NOW_ISO,
    },
    {
      kind: "chat_question",
      request_id: "req-2",
      chat_id: "200",
      project_id: "1",
      question: "Should I run the migration before or after deploying?",
      multi_select: false,
      created_at: FIXTURE_NOW_ISO,
    },
  ];
}

function defaultFailedTasksFixture(): FailedTaskFixture[] {
  return [
    makeFailedTask({
      id: "300",
      prompt: "Run e2e against the local daemon",
    }),
    makeFailedTask({
      id: "301",
      prompt: "Lint the UI package end-to-end",
    }),
  ];
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
 * Stub the two endpoints the inbox sources read. Pin the route handlers
 * to the e2e backend's loopback origin so that the SPA's own page
 * navigation (served by Vite at localhost:5174) is not shadowed — bare
 * `**\/attention` would also intercept the SPA navigation itself.
 */
async function stubInboxSources(
  page: Page,
  fixture: {
    attention?: AttentionFixtureItem[];
    failedTasks?: FailedTaskFixture[];
  },
) {
  const backendPort = Number(process.env.E2E_BACKEND_PORT ?? 52078);
  const apiOrigin = `http://127.0.0.1:${backendPort}`;

  const attentionItems = fixture.attention ?? [];
  const failedTasks = fixture.failedTasks ?? [];

  const respond = async (route: Route, payload: unknown) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  };

  // /attention drives both `useAttention` and the agent-questions source.
  await page.route(`${apiOrigin}/attention`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, { items: attentionItems, total: attentionItems.length });
      return;
    }
    await route.fallback();
  });
  await page.route(`${apiOrigin}/attention?**`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, { items: attentionItems, total: attentionItems.length });
      return;
    }
    await route.fallback();
  });

  // /tasks?... drives `useFailedTasks24h`. Match both bare and querystring
  // forms — Playwright's globbing is not regex-aware for query strings.
  await page.route(`${apiOrigin}/tasks?**`, async (route) => {
    if (route.request().method() === "GET") {
      await respond(route, { items: failedTasks, total: failedTasks.length });
      return;
    }
    await route.fallback();
  });
}

async function waitForAttentionReady(page: Page) {
  await expect(page.getByTestId("attention-page")).toBeVisible({
    timeout: 15_000,
  });
  // Either the empty state or one of the priority sections has to land
  // before we snapshot. We anchor on the page wrapper above; the visual
  // assertions below pin per-fixture sentinels.
}

// ---------------------------------------------------------------------------
// Structural smokes
// ---------------------------------------------------------------------------

test.describe("attention page — structural smokes", () => {
  test("page chrome mounts with the redesigned SectionHeader", async ({
    page,
  }) => {
    await stubInboxSources(page, {
      attention: defaultAttentionFixture(),
      failedTasks: defaultFailedTasksFixture(),
    });

    await page.goto("/attention");
    await waitForAttentionReady(page);

    // h1 from `SectionHeader size="page"`.
    await expect(
      page.getByRole("heading", { name: "Attention", level: 1 }),
    ).toBeVisible();

    // Both buckets render given the seeded fixture.
    await expect(
      page.getByTestId("attention-section-critical"),
    ).toBeVisible();
    await expect(page.getByTestId("attention-section-normal")).toBeVisible();

    // Section headers carry their counts.
    await expect(
      page.getByTestId("attention-section-header-critical"),
    ).toContainText("2 items");
    await expect(
      page.getByTestId("attention-section-header-normal"),
    ).toContainText("2 items");
  });

  test("empty state mounts when both sources return nothing", async ({
    page,
  }) => {
    await stubInboxSources(page, { attention: [], failedTasks: [] });
    await page.goto("/attention");
    await waitForAttentionReady(page);

    await expect(page.getByTestId("attention-empty-state")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByText("All caught up · 0 items waiting"),
    ).toBeVisible();
    // Neither section renders — they short-circuit on empty `items`.
    await expect(page.getByTestId("attention-section-critical")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("attention-section-normal")).toHaveCount(0);
  });

  test("critical-only fixture renders just the Critical section", async ({
    page,
  }) => {
    await stubInboxSources(page, {
      attention: [],
      failedTasks: defaultFailedTasksFixture(),
    });
    await page.goto("/attention");
    await waitForAttentionReady(page);

    await expect(
      page.getByTestId("attention-section-critical"),
    ).toBeVisible();
    // Normal bucket short-circuits to null when its items array is empty.
    await expect(page.getByTestId("attention-section-normal")).toHaveCount(0);
    await expect(page.getByTestId("attention-empty-state")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Visual baselines — content × theme matrix
// ---------------------------------------------------------------------------

const VISUAL_VARIANTS = [
  {
    slug: "default",
    fixture: () => ({
      attention: defaultAttentionFixture(),
      failedTasks: defaultFailedTasksFixture(),
    }),
    sentinel: (page: Page) =>
      expect(page.getByTestId("attention-section-normal")).toBeVisible(),
  },
  {
    slug: "critical-only",
    fixture: () => ({
      attention: [] as AttentionFixtureItem[],
      failedTasks: defaultFailedTasksFixture(),
    }),
    sentinel: (page: Page) =>
      expect(page.getByTestId("attention-section-critical")).toBeVisible(),
  },
  {
    slug: "empty",
    fixture: () => ({
      attention: [] as AttentionFixtureItem[],
      failedTasks: [] as FailedTaskFixture[],
    }),
    sentinel: (page: Page) =>
      expect(page.getByTestId("attention-empty-state")).toBeVisible(),
  },
] as const;

test.describe("attention page — visual baselines", () => {
  for (const variant of VISUAL_VARIANTS) {
    for (const theme of ["light", "dark"] as const) {
      test(`attention-${variant.slug}-${theme} baseline`, async ({ page }) => {
        await pinTheme(page, theme);
        await stubInboxSources(page, variant.fixture());

        await page.goto("/attention");
        await waitForAttentionReady(page);
        await variant.sentinel(page);
        await freezeAnimations(page);

        await expect(page).toHaveScreenshot(
          `attention-${variant.slug}-${theme}.png`,
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
