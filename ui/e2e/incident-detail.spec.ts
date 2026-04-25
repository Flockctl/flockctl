// e2e: navigate to /incidents/:id → edit the resolution field → save →
// reload the page and verify the new content persisted both in the UI and
// via a direct GET against the /incidents API.

import { test, expect } from "@playwright/test";
import { uniq } from "./_helpers";

test("edit incident resolution → save → persisted", async ({ page, request }) => {
  // Seed one incident via the API. The detail page is a pure CRUD surface —
  // no chat context required.
  const createRes = await request.post("/incidents", {
    data: {
      title: uniq("incident"),
      symptom: "Initial symptom",
      rootCause: "Initial root cause",
      resolution: "Initial resolution",
      tags: ["alpha", "beta"],
    },
  });
  expect(createRes.status()).toBe(201);
  const incident = (await createRes.json()) as {
    id: number | string;
    title: string;
  };
  const incidentId = String(incident.id);

  await page.goto(`/incidents/${incidentId}`);
  await expect(page.getByTestId("incident-detail-page")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("incident-title")).toContainText(incident.title);
  await expect(page.getByTestId("incident-resolution")).toContainText(
    "Initial resolution",
  );

  // Enter edit mode.
  await page.getByTestId("incident-edit-button").click();
  const resolutionInput = page.getByTestId("incident-edit-resolution");
  await expect(resolutionInput).toBeVisible();

  const newResolution = `Edited resolution ${Date.now()}`;
  await resolutionInput.fill(newResolution);

  await page.getByTestId("incident-save-button").click();

  // After save the page flips back to read-only mode and the markdown block
  // now reflects the updated text.
  await expect(page.getByTestId("incident-edit-resolution")).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(page.getByTestId("incident-resolution")).toContainText(
    newResolution,
  );

  // Reload — the change must come back from the DB, not React Query cache.
  await page.reload();
  await expect(page.getByTestId("incident-resolution")).toContainText(
    newResolution,
  );

  // And sanity-check the backend directly.
  const getRes = await request.get(`/incidents/${incidentId}`);
  expect(getRes.status()).toBe(200);
  const updated = (await getRes.json()) as { resolution: string | null };
  expect(updated.resolution).toBe(newResolution);
});
