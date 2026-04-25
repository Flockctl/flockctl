import type { APIRequestContext } from "@playwright/test";
import { createProject, uniq } from "../_helpers";

/**
 * Fixtures for the right-rail (`SliceDetailPanel`) e2e spec.
 *
 * The spec drives three deliberate shapes so the four visual baselines
 * (empty, with-slice, long-title-wraps, many-tasks-scrolls) and the
 * "disabled re-run while auto-exec is running" corner case all have
 * deterministic DOM to snapshot.
 *
 * Shape:
 *
 *   Project → Milestone "Rail Fixture"
 *     ├── Slice "scroll" (active) — 20 plan tasks, for the scroll baseline
 *     ├── Slice with a 150-char title (active) — for the long-title wrap baseline
 *     └── Slice "running" (active) — referenced in the disabled-rerun test
 *
 * The backend's POST /slices + POST /slices/:s/tasks endpoints are plain
 * filesystem writes under `<projectPath>/.flockctl/plan/...`; they do NOT
 * involve the AI planner so this fixture runs even with FLOCKCTL_MOCK_AI=1
 * turned on.
 *
 * The fixture throws on the first non-201 — a partial seed would leave the
 * snapshot baselines meaningless.
 */

/** Exactly 150 characters — used to assert the title's `line-clamp-3`. */
export const LONG_SLICE_TITLE =
  "Wire the right rail so a really-long slice title wraps to three lines without pushing the mission-control grid off the viewport because the line-clamp is real ".slice(
    0,
    150,
  );

if (LONG_SLICE_TITLE.length !== 150) {
  // Import-time guard — a regression in the title length loses the wrap
  // baseline coverage silently otherwise.
  throw new Error(
    `LONG_SLICE_TITLE must be 150 chars; got ${LONG_SLICE_TITLE.length}`,
  );
}

/** Count of tasks seeded on the scroll-fixture slice. */
export const SCROLL_TASK_COUNT = 20;

export interface SliceRailProject {
  projectId: number;
  projectName: string;
  projectPath: string;
  milestoneSlug: string;
  /** Slug of the slice with 20 tasks — drives the many-tasks-scrolls baseline. */
  scrollSliceSlug: string;
  /** Slug of the slice with a 150-char title — drives the long-title baseline. */
  longTitleSliceSlug: string;
  /** Slug of the third slice — target of the disabled-rerun test. */
  runningSliceSlug: string;
}

async function postSlice(
  request: APIRequestContext,
  projectId: number,
  milestoneSlug: string,
  title: string,
  status: "pending" | "active" | "verifying" | "completed",
  order: number,
): Promise<string> {
  const res = await request.post(
    `/projects/${projectId}/milestones/${milestoneSlug}/slices`,
    {
      data: {
        title,
        description: `Rail fixture — ${title.slice(0, 40)}`,
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
  const body = (await res.json()) as { slug?: string; id?: string };
  const slug = body.slug ?? body.id;
  if (!slug) {
    throw new Error(
      `POST slice "${title}" returned no slug: ${JSON.stringify(body)}`,
    );
  }
  return slug;
}

/**
 * Replace an existing slice's title (and optionally status) via PATCH. The
 * server preserves the filesystem slug on update — see
 * `src/services/plan-store/slices.ts::updateSlice` — so we can create a
 * slice with a short, URL-safe title, capture its 64-char slug, then
 * overwrite the displayed title to an arbitrarily long string.
 *
 * `useSelection` rejects slugs longer than 64 chars; without this trick
 * the long-title baseline would be unreachable from the rail.
 */
async function patchSlice(
  request: APIRequestContext,
  projectId: number,
  milestoneSlug: string,
  sliceSlug: string,
  data: { title?: string; status?: string },
): Promise<void> {
  const res = await request.patch(
    `/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}`,
    { data },
  );
  if (res.status() !== 200) {
    throw new Error(
      `PATCH slice "${sliceSlug}" failed: ${res.status()} ${await res.text()}`,
    );
  }
}

async function postPlanTask(
  request: APIRequestContext,
  projectId: number,
  milestoneSlug: string,
  sliceSlug: string,
  title: string,
  order: number,
): Promise<void> {
  const res = await request.post(
    `/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}/tasks`,
    {
      data: {
        title,
        description: `Rail fixture task ${order}`,
        order,
      },
    },
  );
  if (res.status() !== 201) {
    throw new Error(
      `POST task "${title}" failed: ${res.status()} ${await res.text()}`,
    );
  }
}

/**
 * Seed a project → milestone → three slices (scroll / long-title / running).
 *
 * The 20-task slice exercises the `overflow-y-auto` contract on the rail's
 * task list; the long-title slice exercises `line-clamp-3` on the header;
 * the third slice exists so the disabled-rerun test has a separate target
 * — its interaction is driven by a `page.route()` override on the
 * auto-execute status endpoint, not by running the real auto-executor.
 */
export async function seedSliceRailProject(
  request: APIRequestContext,
): Promise<SliceRailProject> {
  const name = uniq("slice-rail");
  const project = await createProject(request, name);

  const mRes = await request.post(`/projects/${project.id}/milestones`, {
    data: {
      title: "rail-fixture",
      description: "Milestone hosting the three rail-baseline slices.",
      order: 1,
    },
  });
  if (mRes.status() !== 201) {
    throw new Error(
      `POST milestone failed: ${mRes.status()} ${await mRes.text()}`,
    );
  }
  const mBody = (await mRes.json()) as { slug?: string; id?: string };
  const milestoneSlug = mBody.slug ?? mBody.id;
  if (!milestoneSlug) {
    throw new Error(
      `POST milestone returned no slug/id: ${JSON.stringify(mBody)}`,
    );
  }

  // All three slices are seeded with status=`pending` deliberately. The GET
  // /auto-execute endpoint reports `current_slice_ids` as "every slice in
  // status=active" regardless of whether the executor is actually running
  // (see `src/routes/planning.ts`), which would cause every selected slice
  // to read as "already running" and the Re-run button to disable. Seeding
  // `pending` keeps the idle auto-exec path clean; the disabled-rerun test
  // drives that state via a `page.route()` override instead.

  // Slice 1 — scroll fixture. Hyphen-only title so `slugify` is a no-op
  // and the `useSelection` URL allow-list round-trips the slug cleanly.
  const scrollSliceSlug = await postSlice(
    request,
    project.id,
    milestoneSlug,
    "scroll-fixture",
    "pending",
    0,
  );

  for (let i = 0; i < SCROLL_TASK_COUNT; i++) {
    await postPlanTask(
      request,
      project.id,
      milestoneSlug,
      scrollSliceSlug,
      `task-${String(i).padStart(2, "0")}`,
      i,
    );
  }

  // Slice 2 — long title. Create with a short URL-safe title so the
  // server-assigned slug fits `useSelection`'s 64-char allow-list, then
  // PATCH the title to the 150-char string. The filesystem slug is
  // preserved across the PATCH (see `updateSlice` in plan-store), so
  // the deep-linked URL still resolves while the rail renders the full
  // 150-char title and exercises `line-clamp-3`.
  const longTitleSliceSlug = await postSlice(
    request,
    project.id,
    milestoneSlug,
    "long-title",
    "pending",
    1,
  );
  await patchSlice(
    request,
    project.id,
    milestoneSlug,
    longTitleSliceSlug,
    { title: LONG_SLICE_TITLE },
  );

  // Slice 3 — running fixture. Exists purely so `?slice=<running>` lands
  // on a valid selection; the "disabled re-run" assertion is driven by
  // a page-level route override, not by the real auto-executor.
  const runningSliceSlug = await postSlice(
    request,
    project.id,
    milestoneSlug,
    "running-fixture",
    "pending",
    2,
  );

  return {
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    milestoneSlug,
    scrollSliceSlug,
    longTitleSliceSlug,
    runningSliceSlug,
  };
}
