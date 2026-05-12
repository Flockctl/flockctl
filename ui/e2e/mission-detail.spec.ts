/**
 * Mission detail page — structural smokes + visual baselines (slice 24-01 / T04).
 *
 * The page is the closing surface for the supervisor pipeline: header +
 * KPI strip + events feed + proposals queue. This spec ships:
 *
 *   1. **Structural smokes** — header, KPI strip, 3-column grid, events
 *      feed, proposals queue all mount; pending-proposals count is
 *      surfaced on the KPI strip.
 *
 *   2. **Visual baselines** — eight full-page screenshots covering the
 *      state × theme matrix:
 *        - mission-detail-default-{light,dark}.png       (mixed events + 1 pending proposal)
 *        - mission-detail-budget-warning-{light,dark}.png (high spend close to budget cap)
 *        - mission-detail-completed-{light,dark}.png      (status=completed, no proposals)
 *        - mission-detail-empty-proposals-{light,dark}.png (no events, no proposals)
 *
 *      Each shot freezes animations and pins theme via localStorage
 *      before the first paint, mirroring `dashboard.spec.ts`.
 *
 * Test data is seeded directly into the e2e SQLite file the daemon
 * reads — same pattern as `missions-ui.spec.ts`. The supervisor service
 * is not exercised under FLOCKCTL_MOCK_AI=1 so we don't try to drive the
 * pipeline; we just plant the row shapes the renderer cares about.
 *
 * Regenerate baselines with:
 *   cd ui && npm run e2e:update -- e2e/mission-detail.spec.ts
 */

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createProject, uniq } from "./_helpers";

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(here, "..", "..", ".e2e-data", "flockctl.db");

// ─── DB helpers (lifted from missions-ui.spec.ts) ──────────────────────────

interface SeededMission {
  id: string;
}

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

interface SeedMissionOpts {
  status?: "drafting" | "active" | "paused" | "completed" | "failed" | "aborted";
  autonomy?: "manual" | "suggest" | "auto";
  budgetTokens?: number;
  budgetUsdCents?: number;
  spentTokens?: number;
  spentUsdCents?: number;
}

function seedMission(
  projectId: number,
  objective: string,
  opts: SeedMissionOpts = {},
): SeededMission {
  const id = randomUUID();
  const status = opts.status ?? "active";
  const autonomy = opts.autonomy ?? "suggest";
  const budgetTokens = opts.budgetTokens ?? 1_000_000;
  const budgetUsdCents = opts.budgetUsdCents ?? 5_000;
  const spentTokens = opts.spentTokens ?? 0;
  const spentUsdCents = opts.spentUsdCents ?? 0;
  withDb((db) => {
    db.prepare(
      `INSERT INTO missions
       (id, project_id, objective, status, autonomy,
        budget_tokens, budget_usd_cents,
        spent_tokens, spent_usd_cents,
        supervisor_prompt_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'v1')`,
    ).run(
      id,
      projectId,
      objective,
      status,
      autonomy,
      budgetTokens,
      budgetUsdCents,
      spentTokens,
      spentUsdCents,
    );
  });
  return { id };
}

/**
 * Seed a `mission_events` row. `kind` MUST be one of the canonical
 * 13 from the DB CHECK (see `src/db/schema.ts` lines 596-606); kinds
 * outside that set fail the constraint at INSERT time.
 */
function seedEvent(
  missionId: string,
  kind: string,
  payload: unknown,
  opts: {
    costTokens?: number;
    costUsdCents?: number;
    depth?: number;
    /** Seconds offset into the past from `now`. Defaults to 0. */
    pastSec?: number;
  } = {},
): void {
  const id = randomUUID();
  const createdAt = Math.floor(Date.now() / 1000) - (opts.pastSec ?? 0);
  withDb((db) => {
    db.prepare(
      `INSERT INTO mission_events
       (id, mission_id, kind, payload,
        cost_tokens, cost_usd_cents, depth, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      missionId,
      kind,
      JSON.stringify(payload),
      opts.costTokens ?? 0,
      opts.costUsdCents ?? 0,
      opts.depth ?? 0,
      createdAt,
    );
  });
}

/**
 * Seed a single pending proposal (`remediation_proposed`) carrying the
 * canonical proposalSchema shape so the right-rail card narrows the
 * payload correctly.
 */
function seedProposal(
  missionId: string,
  rationale: string,
  candidate: { action: string; target_id?: string; target_type?: string },
  opts: { costTokens?: number; costUsdCents?: number; depth?: number; pastSec?: number } = {},
): string {
  const id = randomUUID();
  const payload = {
    rationale,
    proposal: {
      target_type: candidate.target_type ?? "task",
      candidate: {
        action: candidate.action,
        target_id: candidate.target_id,
      },
    },
  };
  const createdAt = Math.floor(Date.now() / 1000) - (opts.pastSec ?? 60);
  withDb((db) => {
    db.prepare(
      `INSERT INTO mission_events
       (id, mission_id, kind, payload,
        cost_tokens, cost_usd_cents, depth, created_at)
       VALUES (?, ?, 'remediation_proposed', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      missionId,
      JSON.stringify(payload),
      opts.costTokens ?? 4_500,
      opts.costUsdCents ?? 72,
      opts.depth ?? 1,
      createdAt,
    );
  });
  return id;
}

function deleteMissionsForProject(projectId: number): void {
  withDb((db) => {
    db.prepare(`DELETE FROM missions WHERE project_id = ?`).run(projectId);
  });
}

// ─── Page helpers ──────────────────────────────────────────────────────────

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("flockctl-theme", t);
    } catch {
      /* swallow — Safari private mode etc. */
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

async function waitForMissionDetailReady(page: Page) {
  await expect(page.getByTestId("mission-detail-page")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("mission-header")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("mission-kpi-strip")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("mission-detail-grid")).toBeVisible({
    timeout: 15_000,
  });
}

// ─── Scenario seeders ──────────────────────────────────────────────────────

interface ScenarioContext {
  projectId: number;
  missionId: string;
}

async function seedDefault(request: APIRequestContext): Promise<ScenarioContext> {
  const proj = await createProject(request, uniq("md-default"));
  const mission = seedMission(proj.id, "Stabilise the auto-executor", {
    spentTokens: 120_000,
    spentUsdCents: 1_500,
    budgetTokens: 1_000_000,
    budgetUsdCents: 5_000,
  });
  // Mix of canonical event kinds — the renderer falls back to the
  // neutral row for kinds outside its 9-name table, which is the
  // correct production behaviour.
  seedEvent(
    mission.id,
    "task_observed",
    {
      task_id: "T-001",
      status: "completed",
      summary: "added migration 0027",
      task_output: "applied 0027_add_chat_attachments.sql",
    },
    { costTokens: 1_240, costUsdCents: 18, depth: 1, pastSec: 30 * 60 },
  );
  seedEvent(
    mission.id,
    "no_action",
    { rationale: "Nothing to remediate; supervisor stood down." },
    { costTokens: 800, costUsdCents: 12, pastSec: 20 * 60 },
  );
  seedEvent(
    mission.id,
    "heartbeat",
    { reason: "periodic heartbeat", trigger_kind: "heartbeat" },
    { pastSec: 10 * 60 },
  );
  seedProposal(
    mission.id,
    "T-001 finished cleanly; the next blocker is the upload pipeline (slice 02). Filing this so the operator can approve.",
    {
      action: "create slice 02 — chat attachment upload pipeline",
      target_type: "slice",
    },
    { costTokens: 4_520, costUsdCents: 72, depth: 2, pastSec: 5 * 60 },
  );
  return { projectId: proj.id, missionId: mission.id };
}

async function seedBudgetWarning(
  request: APIRequestContext,
): Promise<ScenarioContext> {
  const proj = await createProject(request, uniq("md-warn"));
  const mission = seedMission(proj.id, "Drive a remediation cycle", {
    // 85% of the cap — the budget bar tone flips to amber.
    spentTokens: 850_000,
    spentUsdCents: 4_250,
    budgetTokens: 1_000_000,
    budgetUsdCents: 5_000,
  });
  seedEvent(
    mission.id,
    "budget_warning",
    {
      pct_used: 85,
      spent_usd_cents: 4_250,
      budget_usd_cents: 5_000,
    },
    { pastSec: 10 * 60 },
  );
  seedEvent(
    mission.id,
    "task_observed",
    {
      task_id: "T-021",
      status: "failed",
      summary: "merge gate verification failed",
      task_output: "ERR: rate-limited by upstream provider",
    },
    { costTokens: 12_400, costUsdCents: 180, depth: 2, pastSec: 30 * 60 },
  );
  seedProposal(
    mission.id,
    "Add a verifying retry on the merge-gate so transient upstream rate-limits don't bleed budget.",
    {
      action: "Add a verifying retry on the merge-gate",
      target_type: "task",
      target_id: "T-021",
    },
    { costTokens: 5_200, costUsdCents: 88, depth: 3, pastSec: 4 * 60 },
  );
  return { projectId: proj.id, missionId: mission.id };
}

async function seedCompleted(
  request: APIRequestContext,
): Promise<ScenarioContext> {
  const proj = await createProject(request, uniq("md-done"));
  const mission = seedMission(proj.id, "Ship the supervisor onboarding flow", {
    status: "completed",
    spentTokens: 482_000,
    spentUsdCents: 3_200,
    budgetTokens: 1_000_000,
    budgetUsdCents: 5_000,
  });
  // Pure read-only timeline — no pending proposals.
  seedEvent(
    mission.id,
    "task_observed",
    {
      task_id: "T-007",
      status: "completed",
      summary: "all four slices of M04 landed",
    },
    { costTokens: 9_400, costUsdCents: 142, depth: 1, pastSec: 90 * 60 },
  );
  seedEvent(
    mission.id,
    "objective_met",
    {
      summary: "All four slices of M04 landed; CI green; mission objective met.",
      spent_tokens: 482_000,
      spent_usd_cents: 3_200,
    },
    { pastSec: 60 * 60 },
  );
  return { projectId: proj.id, missionId: mission.id };
}

async function seedEmpty(
  request: APIRequestContext,
): Promise<ScenarioContext> {
  const proj = await createProject(request, uniq("md-empty"));
  const mission = seedMission(proj.id, "Fresh mission — nothing scheduled yet", {
    status: "drafting",
    spentTokens: 0,
    spentUsdCents: 0,
  });
  // No events, no proposals — pins down the "empty proposals" + empty
  // events-feed branch.
  return { projectId: proj.id, missionId: mission.id };
}

// ─── Structural smokes ─────────────────────────────────────────────────────

test.describe("mission-detail — structural smokes", () => {
  test("page chrome mounts with header + KPI strip + 3-column grid", async ({
    page,
    request,
  }) => {
    const ctx = await seedDefault(request);
    try {
      await page.goto(`/missions/${ctx.missionId}`);
      await waitForMissionDetailReady(page);

      // Header surfaces the objective.
      await expect(page.getByTestId("mission-header-objective")).toContainText(
        "Stabilise the auto-executor",
      );

      // KPI strip — five mini tiles.
      await expect(page.getByTestId("mission-kpi-depth")).toBeVisible();
      await expect(page.getByTestId("mission-kpi-budget")).toBeVisible();
      await expect(page.getByTestId("mission-kpi-tokens")).toBeVisible();
      await expect(page.getByTestId("mission-kpi-triggers")).toBeVisible();
      await expect(page.getByTestId("mission-kpi-pending")).toBeVisible();

      // Grid + occupants.
      const grid = page.getByTestId("mission-detail-grid");
      await expect(grid).toBeVisible();
      await expect(page.getByTestId("mission-detail-events-col")).toBeVisible();
      await expect(page.getByTestId("mission-detail-proposals-col")).toBeVisible();
      await expect(page.getByTestId("mission-events-feed")).toBeVisible();
      await expect(page.getByTestId("mission-proposals-queue")).toBeVisible();
    } finally {
      deleteMissionsForProject(ctx.projectId);
    }
  });

  test("pending-proposals KPI tile reflects the seed count", async ({
    page,
    request,
  }) => {
    const ctx = await seedDefault(request);
    try {
      await page.goto(`/missions/${ctx.missionId}`);
      await waitForMissionDetailReady(page);
      const pending = page.getByTestId("mission-kpi-pending");
      await expect(pending).toContainText("1");
      await expect(pending).toHaveAttribute("data-tone", "warning");
    } finally {
      deleteMissionsForProject(ctx.projectId);
    }
  });

  test("empty proposals branch renders the empty card", async ({
    page,
    request,
  }) => {
    const ctx = await seedEmpty(request);
    try {
      await page.goto(`/missions/${ctx.missionId}`);
      await waitForMissionDetailReady(page);
      await expect(
        page.getByTestId("mission-proposals-queue-empty"),
      ).toBeVisible();
      await expect(page.getByTestId("mission-events-feed-empty")).toBeVisible();
    } finally {
      deleteMissionsForProject(ctx.projectId);
    }
  });
});

// ─── Visual baselines — state × theme matrix ───────────────────────────────

interface Scenario {
  name: "default" | "budget-warning" | "completed" | "empty-proposals";
  seed: (request: APIRequestContext) => Promise<ScenarioContext>;
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  { name: "default", seed: seedDefault },
  { name: "budget-warning", seed: seedBudgetWarning },
  { name: "completed", seed: seedCompleted },
  { name: "empty-proposals", seed: seedEmpty },
];

test.describe("mission-detail — visual baselines", () => {
  for (const scenario of SCENARIOS) {
    for (const theme of ["light", "dark"] as const) {
      test(`mission-detail-${scenario.name}-${theme} baseline`, async ({
        page,
        request,
      }) => {
        const ctx = await scenario.seed(request);
        try {
          await setTheme(page, theme);
          await page.goto(`/missions/${ctx.missionId}`);
          await waitForMissionDetailReady(page);
          await freezeAnimations(page);

          await expect(page).toHaveScreenshot(
            `mission-detail-${scenario.name}-${theme}.png`,
            {
              fullPage: true,
              threshold: 0.1,
              maxDiffPixelRatio: 0.02,
            },
          );
        } finally {
          deleteMissionsForProject(ctx.projectId);
        }
      });
    }
  }
});
