import type { APIRequestContext } from "@playwright/test";
import { createProject, uniq } from "../_helpers";

/**
 * Fixtures for the slice-board e2e spec (milestone 09 / slice 01).
 *
 * Shape we seed:
 *
 *   Project → Milestone ("Board Fixture") with one child milestone that
 *   carries enough slices to exercise every column in `DEFAULT_SLICE_COLUMNS`,
 *   plus one deliberately-short column so the empty-column placeholder is
 *   visible in the screenshot.
 *
 *   Column                      → seeded slices
 *   ─────────────────────────── → ─────────────────────────────
 *   Pending (pending|planning)  → 30  (scrolling edge case — `SCROLL_COUNT`)
 *   Active (active)             →  3 — the empty-column target
 *   Completed (completed)       →  1 — the target of the selection test
 *
 * The Pending column hits 30 cards deliberately: the SliceBoardColumn sets
 * `overflow-y-auto` on the card stack, so a column taller than the viewport
 * must scroll *inside* the column, not bubble up and scroll the page. The
 * 30-card seed lets the e2e assert that contract empirically (scrollTop on
 * the column changes while page.scrollY stays at 0).
 *
 * The Completed column has exactly one slice (`completed-0`) so the selection
 * test has a stable id to click and assert on.
 *
 * The default board layout no longer renders a Verifying column (see
 * `DEFAULT_SLICE_COLUMNS` — the backend never produces `verifying` today),
 * so this fixture no longer seeds `verifying` slices. The empty-column
 * baseline is now exercised by flipping the Active column back to Pending.
 *
 * The backend uses FLOCKCTL_MOCK_AI=1 in playwright.config.ts but the
 * planning CRUD endpoints do NOT involve the AI planner — they are plain
 * filesystem writes under `<projectPath>/.flockctl/plan/...` — so this
 * fixture runs end-to-end without any mocking.
 *
 * The fixture throws on the first server error it can't recover from; there
 * is no "best effort" path. A fixture that silently seeds less data than the
 * tests expect leaves the snapshot baselines meaningless.
 */

/** Slices per status bucket. Tuned to hit every column plus the 30-card scroll edge. */
export const SLICE_COUNTS = {
  pending: 30,
  active: 3,
  completed: 1,
} as const;

export interface SliceBoardProject {
  projectId: number;
  projectName: string;
  projectPath: string;
  milestoneId: string;
  /** Every slice id the fixture seeded, column-by-column. */
  sliceIds: {
    pending: string[];
    active: string[];
    completed: string[];
  };
}

interface SeededSlice {
  /** Human-readable slug returned by the daemon (e.g. `00-pending-0`). */
  id: string;
}

async function postSlice(
  request: APIRequestContext,
  projectId: number,
  milestoneSlug: string,
  title: string,
  status: "pending" | "active" | "completed",
  order: number,
): Promise<SeededSlice> {
  const res = await request.post(
    `/projects/${projectId}/milestones/${milestoneSlug}/slices`,
    {
      data: {
        title,
        description: `Fixture slice — ${title}`,
        status,
        order,
      },
    },
  );
  if (res.status() !== 201) {
    throw new Error(
      `POST slice "${title}" failed: ${res.status()} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { id?: string; slug?: string };
  // `createSlice` returns the raw `SliceData` (slug-keyed); the list/get
  // endpoints remap to `{ id: slug }` via `sliceToApi`. Accept either so the
  // fixture survives a future normalisation pass on the POST response.
  const id = body.slug ?? body.id;
  if (!id) {
    throw new Error(`POST slice "${title}" returned no id: ${JSON.stringify(body)}`);
  }
  return { id };
}

/**
 * Seed a project → milestone → (pending×30, active×3, completed×1) slice
 * tree. Returns the ids the tests need.
 */
export async function seedSliceBoardProject(
  request: APIRequestContext,
): Promise<SliceBoardProject> {
  const name = uniq("slice-board");
  const project = await createProject(request, name);

  // Create the milestone. Unlike the view-modes fixture, we do NOT swallow
  // errors here — a 201 is required for the rest of the seed to make sense.
  const mRes = await request.post(`/projects/${project.id}/milestones`, {
    data: {
      title: "Board Fixture",
      description: "Milestone that seeds one slice per column for e2e snapshots.",
      order: 1,
    },
  });
  if (mRes.status() !== 201) {
    throw new Error(
      `POST milestone failed: ${mRes.status()} ${await mRes.text()}`,
    );
  }
  // `createMilestone` returns `MilestoneData` directly (slug-keyed); the
  // GET/list endpoints remap to `{ id: slug }` via `milestoneToApi`. Prefer
  // `slug` for the POST response, fall back to `id` if the route is ever
  // updated to run responses through `milestoneToApi`.
  const mBody = (await mRes.json()) as { slug?: string; id?: string };
  const milestoneSlug = mBody.slug ?? mBody.id;
  if (!milestoneSlug) {
    throw new Error(
      `POST milestone returned no slug/id: ${JSON.stringify(mBody)}`,
    );
  }
  const milestone = { id: milestoneSlug };

  // Titles stay lowercase + hyphen-only so the daemon's `slugify()` produces
  // slugs that match `useSelection`'s `^[a-z0-9][a-z0-9-]{0,63}$` allow-list.
  // Otherwise the URL-backed selection silently rejects the clicked slice id
  // and the "click updates ?slice=" test fails. See `use-selection.ts`.
  const pending: string[] = [];
  for (let i = 0; i < SLICE_COUNTS.pending; i++) {
    const { id } = await postSlice(
      request,
      project.id,
      milestone.id,
      `pending-${String(i).padStart(2, "0")}`,
      "pending",
      i,
    );
    pending.push(id);
  }

  const active: string[] = [];
  for (let i = 0; i < SLICE_COUNTS.active; i++) {
    const { id } = await postSlice(
      request,
      project.id,
      milestone.id,
      `active-${i}`,
      "active",
      SLICE_COUNTS.pending + i,
    );
    active.push(id);
  }

  const completed: string[] = [];
  for (let i = 0; i < SLICE_COUNTS.completed; i++) {
    const { id } = await postSlice(
      request,
      project.id,
      milestone.id,
      `completed-${i}`,
      "completed",
      SLICE_COUNTS.pending + SLICE_COUNTS.active + i,
    );
    completed.push(id);
  }

  return {
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    milestoneId: milestone.id,
    sliceIds: { pending, active, completed },
  };
}
