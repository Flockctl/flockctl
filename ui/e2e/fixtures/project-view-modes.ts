import type { APIRequestContext } from "@playwright/test";
import { createProject, uniq } from "../_helpers";

/**
 * Fixtures for the project-detail view-mode e2e spec.
 *
 * The view-mode slice (milestone 09, slice 00) needs a project that:
 *   - exists on disk so `GET /projects/:id` and the planning tree calls succeed;
 *   - has at least one milestone so the tree render is not just the
 *     "no milestones yet" empty-state (which hides the grid geometry we care
 *     about in the baseline snapshot);
 *   - includes a very long milestone title (120 chars exactly) to exercise the
 *     overflow guarantee in `ProjectDetailBoardView` — the grid uses
 *     `grid-cols-[260px_1fr_360px]` with `min-w-0` on every slot, and the
 *     snapshot is our regression gate against someone dropping `min-w-0` and
 *     letting a long title shove the right pane off screen.
 *
 * Shared across tests — callers pass the fixture into `createViewModeProject`
 * and get back enough shape to drive the UI (`projectId`, `projectName`,
 * `longTitle`).
 */

/** Exactly 120 characters — used to assert "does not overflow grid". */
export const LONG_MILESTONE_TITLE =
  "Refactor the mission-control layout so long milestone titles never push the right-hand context rail off the viewport!!!!";

if (LONG_MILESTONE_TITLE.length !== 120) {
  // Guard the fixture itself — trivially catches a typo during future edits.
  // Throw at import time so tests don't silently lose coverage if the length
  // changes.
  throw new Error(
    `LONG_MILESTONE_TITLE must be 120 chars; got ${LONG_MILESTONE_TITLE.length}`,
  );
}

export interface ViewModeProject {
  projectId: number;
  projectName: string;
  projectPath: string;
  longTitle: string;
}

/**
 * Seed a project + one long-title milestone via the Flockctl HTTP API.
 *
 * Returns the IDs/strings needed to drive the UI and make assertions on the
 * rendered milestone row.
 */
export async function seedViewModeProject(
  request: APIRequestContext,
): Promise<ViewModeProject> {
  const name = uniq("view-modes");
  const project = await createProject(request, name);

  // Best-effort milestone seed. The planning endpoint is stricter about the
  // project existing on disk than about the payload shape — if it rejects
  // (e.g. FLOCKCTL_MOCK_AI is on and the planner is disabled), swallow the
  // error and let the baseline snapshot capture the no-milestones state.
  // The grid-overflow test re-checks for the milestone explicitly and skips
  // its own snapshot assertion when the seed was not effective.
  try {
    const res = await request.post(`/projects/${project.id}/milestones`, {
      data: {
        title: LONG_MILESTONE_TITLE,
        description: "Fixture milestone — exercises long-title overflow",
        order: 1,
      },
    });
    if (res.status() !== 201) {
       
      console.warn(
        `[fixtures] milestone seed returned ${res.status()} — continuing without milestone`,
      );
    }
  } catch (err) {
     
    console.warn("[fixtures] milestone seed threw:", err);
  }

  return {
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    longTitle: LONG_MILESTONE_TITLE,
  };
}

/**
 * Shape returned by {@link seedLeftTreeProject}. The left-tree spec needs
 * to drive keyboard navigation + filter assertions against a specific
 * milestone by slug — we expose the fixture's first and second milestones
 * so tests can click them deterministically without scraping titles.
 */
export interface LeftTreeProject {
  projectId: number;
  projectName: string;
  projectPath: string;
  milestoneCount: number;
  /** Stable slug the backend assigns to "Milestone 00". */
  firstMilestoneTitle: string;
  /** Stable slug the backend assigns to "Milestone 01". */
  secondMilestoneTitle: string;
}

/**
 * Seed a project with N milestones (default 30). The project-tree panel
 * needs to demonstrate three things under load:
 *   1. `overflow-y-auto` on the rail keeps all 30 rows reachable.
 *   2. Keyboard navigation wraps/scrolls correctly through a list that
 *      overflows the 260px-tall visible area.
 *   3. Clicking any row filters the center SliceBoard.
 *
 * We seed the milestones sequentially and tolerate individual failures —
 * FLOCKCTL_MOCK_AI is on in e2e so the planner is disabled, but direct
 * milestone creation via the API works. If a milestone POST returns
 * non-201 we log and keep going; the spec that relies on 30 rows
 * asserts the count post-seed and skips when the seed was partial.
 */
export async function seedLeftTreeProject(
  request: APIRequestContext,
  milestoneCount = 30,
): Promise<LeftTreeProject> {
  const name = uniq("left-tree");
  const project = await createProject(request, name);

  // Title shape is chosen so the backend's slug derivation round-trips
  // through `useSelection`'s lowercase-and-hyphen allow-list. If the slug
  // regex or slugify implementation changes, update both in lock-step.
  const titles: string[] = [];
  for (let i = 0; i < milestoneCount; i++) {
    // Zero-padded so alphabetic slug ordering matches numeric ordering.
    // Lowercase + hyphens so the derived slug (== title here, since
    // slugify is a no-op on well-formed slugs) matches the URL allow-list.
    const title = `milestone-${String(i).padStart(2, "0")}`;
    titles.push(title);
    try {
      const res = await request.post(`/projects/${project.id}/milestones`, {
        data: {
          title,
          description: `Seeded milestone ${i} for left-tree fixture`,
          order: i + 1,
        },
      });
      if (res.status() !== 201) {
         
        console.warn(
          `[fixtures] left-tree milestone ${i} returned ${res.status()}`,
        );
      }
    } catch (err) {
       
      console.warn(`[fixtures] left-tree milestone ${i} threw:`, err);
    }
  }

  return {
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    milestoneCount,
    firstMilestoneTitle: titles[0] ?? "milestone-00",
    secondMilestoneTitle: titles[1] ?? "milestone-01",
  };
}

/**
 * Seed a single milestone with N slices so spec tests can click a slice in
 * the tree and watch the card flip to `data-selected="true"` in the board.
 * Returns the milestone's `slug` (server-assigned from the title) and the
 * raw slice bodies the API returned so the test can pin its assertions to
 * a known slug.
 */
export async function seedProjectWithSlices(
  request: APIRequestContext,
  sliceCount = 2,
): Promise<{
  projectId: number;
  projectName: string;
  milestoneSlug: string;
  sliceSlugs: string[];
}> {
  const name = uniq("left-tree-slices");
  const project = await createProject(request, name);

  // Create one milestone — capture the returned slug so the slices POST
  // can target it. We pick a title that slugifies to itself AND matches
  // `useSelection`'s lowercase-hyphen allow-list so the URL params round
  // trip cleanly.
  const milestoneTitle = "primary";
  const msRes = await request.post(`/projects/${project.id}/milestones`, {
    data: { title: milestoneTitle, description: "Slice host", order: 1 },
  });
  if (msRes.status() !== 201) {
    throw new Error(`milestone seed failed: ${msRes.status()}`);
  }
  const milestone = (await msRes.json()) as { slug?: string; id?: string };
  const milestoneSlug = milestone.slug ?? milestone.id ?? milestoneTitle;

  const sliceSlugs: string[] = [];
  for (let i = 0; i < sliceCount; i++) {
    const title = `slice-${String(i).padStart(2, "0")}`;
    const res = await request.post(
      `/projects/${project.id}/milestones/${milestoneSlug}/slices`,
      {
        data: {
          title,
          description: `Seeded slice ${i}`,
          status: i === 0 ? "active" : "pending",
        },
      },
    );
    if (res.status() === 201) {
      const body = (await res.json()) as { slug?: string };
      if (body.slug) sliceSlugs.push(body.slug);
    } else {
       
      console.warn(`[fixtures] slice ${i} POST returned ${res.status()}`);
    }
  }

  return {
    projectId: project.id,
    projectName: project.name,
    milestoneSlug,
    sliceSlugs,
  };
}
