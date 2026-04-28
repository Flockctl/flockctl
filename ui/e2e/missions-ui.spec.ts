import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createProject, uniq } from "./_helpers";

/**
 * Slice 11/07 — Missions UI end-to-end.
 *
 * Shape of the spec:
 *
 *   1. API contract — POST /missions creates a mission row that surfaces
 *      via GET /projects/:id/missions and ends up rendered in the project
 *      tree panel as a level-1 node above its child milestones.
 *   2. Approve / dismiss flow — seed a mission + a `remediation_proposed`
 *      event directly in the e2e SQLite DB (the supervisor service is not
 *      exercised under FLOCKCTL_MOCK_AI=1), then exercise the
 *      POST /:id/proposals/:pid/approve and .../dismiss endpoints.
 *   3. Visual baseline — the project-detail tree panel showing the new
 *      mission node + child milestone, captured for regression diffing.
 *   4. Accessibility — aria-tree semantics on the panel: role=tree,
 *      aria-level on every treeitem, exactly one node in the roving
 *      tabindex, accessible names on chevron buttons. We don't pull
 *      `@axe-core/playwright` (not in package.json) because the rules we
 *      care about are tree-pattern primitives that are directly observable
 *      via locator queries — same shape axe enforces, just cheaper.
 *
 * Visual baselines live under
 * `ui/e2e/__screenshots__/missions-ui.spec.ts/...` (see the
 * `snapshotPathTemplate` in playwright.config.ts). Regenerate with:
 *
 *   npm run e2e:update -- ui/e2e/missions-ui.spec.ts
 *
 * NOTE: the mission-scoped slice board variant (`DEFAULT_MISSION_COLUMNS`)
 * and the in-app create-mission dialog land in a follow-up wiring slice;
 * this spec covers the surfaces that ARE wired today (project tree panel
 * + missions API) plus the API contract for approve/dismiss. The
 * `ProposedCard`, `MissionSettingsDialog`, and `SupervisorLogTab`
 * components have unit-test coverage at the module level (see
 * `ui/src/__tests__/proposed-card.test.tsx`, etc.).
 */

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(here, "..", "..", ".e2e-data", "flockctl.db");

// ─── DB seed helpers ───────────────────────────────────────────────────────
//
// The supervisor service is not running under FLOCKCTL_MOCK_AI=1, so any
// `mission_events` row a test wants to assert on has to be inserted
// directly into the SQLite file the daemon is reading. This mirrors the
// pattern used by `notifications.spec.ts` (insertPendingApprovalTask).

interface SeededMission {
  id: string;
}

interface SeededProposal {
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

function seedMission(projectId: number, objective: string): SeededMission {
  const id = randomUUID();
  withDb((db) => {
    db.prepare(
      `INSERT INTO missions
       (id, project_id, objective, status, autonomy, budget_tokens,
        budget_usd_cents, supervisor_prompt_version)
       VALUES (?, ?, ?, 'active', 'suggest', 1000000, 5000, 'v1')`,
    ).run(id, projectId, objective);
  });
  return { id };
}

/** Seed a milestone with a mission_id so the tree shows the link. */
function seedMilestone(
  projectId: number,
  missionId: string | null,
  slug: string,
  title: string,
): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO milestones
       (slug, project_id, mission_id, title, description, status, order_index)
       VALUES (?, ?, ?, ?, '', 'pending', 0)`,
    ).run(slug, projectId, missionId, title);
  });
}

/**
 * Insert a `remediation_proposed` event with a realistic payload so the
 * approve handler can re-validate it through the same zod schema the
 * supervisor would have. See `proposalSchema` in
 * `src/services/missions/proposal-schema.ts` for the wire shape.
 */
function seedProposal(
  missionId: string,
  rationale: string,
  candidate: { action: string; target_id?: string },
): SeededProposal {
  const id = randomUUID();
  const payload = JSON.stringify({
    rationale,
    proposal: {
      target_type: "task",
      candidate: {
        action: candidate.action,
        target_id: candidate.target_id,
      },
    },
  });
  withDb((db) => {
    db.prepare(
      `INSERT INTO mission_events
       (id, mission_id, kind, payload, cost_tokens, cost_usd_cents, depth)
       VALUES (?, ?, 'remediation_proposed', ?, 0, 0, 0)`,
    ).run(id, missionId, payload);
  });
  return { id };
}

function deleteMissionsForProject(projectId: number): void {
  withDb((db) => {
    db.prepare(`DELETE FROM missions WHERE project_id = ?`).run(projectId);
  });
}

// ─── Page helpers ──────────────────────────────────────────────────────────

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

async function waitProjectTree(page: Page) {
  await expect(page.getByTestId("project-tree-panel")).toBeVisible({
    timeout: 15_000,
  });
}

// ─── 1. API contract ───────────────────────────────────────────────────────

test.describe("missions-ui — API contract", () => {
  test("POST /missions creates a row that surfaces in GET /projects/:id/missions", async ({
    request,
  }) => {
    const proj = await createProject(request);
    const objective = uniq("ship-onboarding");

    const res = await request.post("/missions", {
      data: {
        projectId: proj.id,
        objective,
        budgetTokens: 1_000_000,
        budgetUsdCents: 5_000,
      },
    });
    expect(res.status()).toBe(201);
    const created = (await res.json()) as { id: string; objective: string };
    expect(created.id).toBeTruthy();
    expect(created.objective).toBe(objective);

    // List endpoint returns the mission in `created_at DESC` order — the
    // mission we just made lands at index 0.
    const listRes = await request.get(`/projects/${proj.id}/missions`);
    expect(listRes.status()).toBe(200);
    const list = (await listRes.json()) as { items: Array<{ id: string }> };
    expect(list.items.map((m) => m.id)).toContain(created.id);

    deleteMissionsForProject(proj.id);
  });

  test("POST /missions rejects autonomy=auto with 501 (not implemented in v1)", async ({
    request,
  }) => {
    const proj = await createProject(request);
    const res = await request.post("/missions", {
      data: {
        projectId: proj.id,
        objective: "auto-mode mission",
        autonomy: "auto",
        budgetTokens: 1_000,
        budgetUsdCents: 100,
      },
    });
    expect(res.status()).toBe(501);
    deleteMissionsForProject(proj.id);
  });

  test("POST /missions rejects budget=0 with a 422 (CHECK constraint mirror)", async ({
    request,
  }) => {
    const proj = await createProject(request);
    const res = await request.post("/missions", {
      data: {
        projectId: proj.id,
        objective: "zero budget",
        budgetTokens: 0,
        budgetUsdCents: 100,
      },
    });
    expect(res.status()).toBe(422);
    deleteMissionsForProject(proj.id);
  });
});

// ─── 2. Approve / dismiss flow ─────────────────────────────────────────────

test.describe("missions-ui — proposal approve/dismiss flow", () => {
  async function seed(
    request: APIRequestContext,
  ): Promise<{
    projectId: number;
    missionId: string;
    proposalId: string;
  }> {
    const proj = await createProject(request);
    const mission = seedMission(proj.id, "Drive a remediation cycle");
    const proposal = seedProposal(mission.id, "transient failure", {
      action: "Add a verifying retry on the merge-gate",
    });
    return {
      projectId: proj.id,
      missionId: mission.id,
      proposalId: proposal.id,
    };
  }

  test("approve creates a remediation_approved event and drops the proposal from pending", async ({
    request,
  }) => {
    const { projectId, missionId, proposalId } = await seed(request);

    // Pre: the proposal is in the `pending` filter.
    let listRes = await request.get(
      `/missions/${missionId}/proposals?status=pending`,
    );
    expect(listRes.status()).toBe(200);
    let list = (await listRes.json()) as { items: Array<{ id: string }> };
    expect(list.items.map((p) => p.id)).toContain(proposalId);

    // Approve.
    const approveRes = await request.post(
      `/missions/${missionId}/proposals/${proposalId}/approve`,
    );
    expect([200, 201]).toContain(approveRes.status());
    const approved = (await approveRes.json()) as {
      decision_id?: string;
      decisionId?: string;
    };
    expect(approved.decision_id ?? approved.decisionId).toBeTruthy();

    // Idempotency: a re-approve returns the SAME decision id.
    const reApprove = await request.post(
      `/missions/${missionId}/proposals/${proposalId}/approve`,
    );
    expect([200, 201]).toContain(reApprove.status());
    const re = (await reApprove.json()) as {
      decision_id?: string;
      decisionId?: string;
    };
    expect(re.decision_id ?? re.decisionId).toBe(
      approved.decision_id ?? approved.decisionId,
    );

    // Post: pending list is now empty for that proposal id.
    listRes = await request.get(
      `/missions/${missionId}/proposals?status=pending`,
    );
    list = (await listRes.json()) as { items: Array<{ id: string }> };
    expect(list.items.map((p) => p.id)).not.toContain(proposalId);

    deleteMissionsForProject(projectId);
  });

  test("dismiss with a reason records a remediation_dismissed event", async ({
    request,
  }) => {
    const { projectId, missionId, proposalId } = await seed(request);

    const dismissRes = await request.post(
      `/missions/${missionId}/proposals/${proposalId}/dismiss`,
      { data: { reason: "looks like a duplicate" } },
    );
    expect([200, 201]).toContain(dismissRes.status());

    // The proposal is now reachable via ?status=dismissed.
    const listRes = await request.get(
      `/missions/${missionId}/proposals?status=dismissed`,
    );
    const list = (await listRes.json()) as {
      items: Array<{ id: string }>;
    };
    expect(list.items.map((p) => p.id)).toContain(proposalId);

    deleteMissionsForProject(projectId);
  });

  test("dismiss without a reason body still succeeds (reason is optional)", async ({
    request,
  }) => {
    const { projectId, missionId, proposalId } = await seed(request);

    const res = await request.post(
      `/missions/${missionId}/proposals/${proposalId}/dismiss`,
      { data: {} },
    );
    expect([200, 201]).toContain(res.status());
    deleteMissionsForProject(projectId);
  });
});

// ─── 3. Visual baseline — project tree with mission node ───────────────────

test.describe("missions-ui — visual baselines", () => {
  test("project tree panel renders the mission node above its child milestone", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request);
    const mission = seedMission(proj.id, "Stabilise the auto-executor");
    seedMilestone(proj.id, mission.id, uniq("ms-stabilise"), "Stabilise foundations");

    await page.goto(`/projects/${proj.id}?view=board`);
    await waitProjectTree(page);

    // Wait for the mission row to render — the panel auto-expands missions
    // by default (slice 11/04 — 5 peer missions side-by-side contract).
    const missionNode = page.getByTestId(`tree-mission-${mission.id}`);
    await expect(missionNode).toBeVisible({ timeout: 10_000 });
    // The mission's objective is the row label.
    await expect(missionNode).toContainText("Stabilise the auto-executor");

    await freeze(page);
    await expect(page.getByTestId("project-tree-panel")).toHaveScreenshot(
      "project-tree-with-mission.png",
      { maxDiffPixelRatio: 0.02 },
    );

    deleteMissionsForProject(proj.id);
  });

  test("project tree panel renders five peer missions side-by-side", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request);
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const m = seedMission(proj.id, `Mission ${i} — peer fixture`);
      seedMilestone(proj.id, m.id, uniq(`ms-${i}`), `Milestone ${i}`);
      ids.push(m.id);
    }

    await page.goto(`/projects/${proj.id}?view=board`);
    await waitProjectTree(page);

    // All five mission rows render at root.
    for (const id of ids) {
      await expect(page.getByTestId(`tree-mission-${id}`)).toBeVisible({
        timeout: 10_000,
      });
    }

    await freeze(page);
    await expect(page.getByTestId("project-tree-panel")).toHaveScreenshot(
      "project-tree-five-peer-missions.png",
      { maxDiffPixelRatio: 0.02 },
    );

    deleteMissionsForProject(proj.id);
  });
});

// ─── 4. Accessibility — aria-tree semantics ────────────────────────────────

test.describe("missions-ui — accessibility (aria-tree compliance)", () => {
  test("tree panel exposes role=tree with aria-labelled landmark", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request);
    const mission = seedMission(proj.id, "A11y mission");
    seedMilestone(proj.id, mission.id, uniq("ms-a11y"), "A11y milestone");

    await page.goto(`/projects/${proj.id}?view=board`);
    await waitProjectTree(page);

    const panel = page.getByTestId("project-tree-panel");
    await expect(panel).toHaveAttribute(
      "aria-label",
      "Project planning tree",
    );
    // The inner ul has role=tree.
    await expect(panel.locator("[role='tree']")).toBeVisible();

    deleteMissionsForProject(proj.id);
  });

  test("every treeitem carries aria-level and exactly one node is in the roving tabindex", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request);
    const mission = seedMission(proj.id, "A11y roving tabindex");
    seedMilestone(proj.id, mission.id, uniq("ms-roving"), "Roving milestone");

    await page.goto(`/projects/${proj.id}?view=board`);
    await waitProjectTree(page);

    // Every treeitem has aria-level.
    const items = await page.locator("[role='treeitem']").all();
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      const level = await it.getAttribute("aria-level");
      expect(level).toMatch(/^[123]$/);
    }

    // Exactly one node carries tabindex=0 (axe-style roving-tabindex check).
    const tabbable = page.locator("[role='treeitem'][tabindex='0']");
    await expect(tabbable).toHaveCount(1);

    deleteMissionsForProject(proj.id);
  });

  test("ArrowDown traverses the tree without escaping the role=tree container", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request);
    const mission = seedMission(proj.id, "A11y arrow nav");
    seedMilestone(proj.id, mission.id, uniq("ms-arrow"), "Arrow milestone");

    await page.goto(`/projects/${proj.id}?view=board`);
    await waitProjectTree(page);

    const tree = page.locator("[role='tree']");
    const firstItem = tree.locator("[role='treeitem']").first();
    await firstItem.focus();

    // Walk ArrowDown a few times — focus stays inside the tree at each step.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowDown");
      const stillInside = await tree.evaluate(
        (el) =>
          el.contains(document.activeElement) &&
          (document.activeElement as HTMLElement | null)?.getAttribute(
            "role",
          ) === "treeitem",
      );
      expect(stillInside).toBe(true);
    }

    deleteMissionsForProject(proj.id);
  });

  test("ArrowUp at the top of the tree does NOT wrap (WAI-ARIA non-wrapping)", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request);
    const mission = seedMission(proj.id, "A11y no-wrap");
    seedMilestone(proj.id, mission.id, uniq("ms-nowrap"), "No-wrap milestone");

    await page.goto(`/projects/${proj.id}?view=board`);
    await waitProjectTree(page);

    const tree = page.locator("[role='tree']");
    const firstItem = tree.locator("[role='treeitem']").first();
    await firstItem.focus();
    const firstId = await firstItem.getAttribute("data-testid");
    expect(firstId).toBeTruthy();

    await page.keyboard.press("ArrowUp");
    const activeId = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? null,
    );
    expect(activeId).toBe(firstId);

    deleteMissionsForProject(proj.id);
  });

  test("chevron toggle buttons have accessible names (Expand / Collapse)", async ({
    page,
    request,
  }) => {
    const proj = await createProject(request);
    const mission = seedMission(proj.id, "A11y chevrons");
    seedMilestone(proj.id, mission.id, uniq("ms-chev"), "Chevron milestone");

    await page.goto(`/projects/${proj.id}?view=board`);
    await waitProjectTree(page);

    // Mission default-expanded → "Collapse mission"; milestone child-less →
    // its toggle is hidden but still has an aria-label for AT users.
    const collapseMission = page.getByLabel(/Collapse mission|Expand mission/);
    await expect(collapseMission.first()).toBeVisible();

    deleteMissionsForProject(proj.id);
  });
});
