/**
 * Visual baselines for the unified chat conversation surface.
 *
 * One spec file covers:
 *   - The transcript with one of every persisted message kind we render
 *     (user, assistant, thinking, tool-call, tool-result) — captured in
 *     both light and dark themes so a palette tweak surfaces a diff.
 *   - The "still working" placeholder bubble that renders while the
 *     server reports `is_running=true` (streaming state).
 *   - The expanded variant of a stored tool-message (button toggled to
 *     show the JSON detail block).
 *   - The composer in its default empty state and after a single image
 *     attachment has been uploaded — both scoped to the composer locator
 *     so the diff is layout-invariant.
 *
 * Seeding strategy: we insert chat_messages rows directly via
 * better-sqlite3 against the e2e DB file. Going through `POST
 * /chats/:id/messages` with role='user' would trigger the AI executor
 * (which has no provider key in the harness and would block / 500), and
 * the seeding path used elsewhere (role='system'|'assistant') can't
 * produce a right-justified user bubble. Direct DB insert sidesteps
 * both — the `chatExecutor.run` codepath is only reached when the HTTP
 * handler runs.
 *
 * Regenerate with:
 *   cd ui && npm run e2e:update -- e2e/chat-conversation.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspace, uniq } from "./_helpers";

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(here, "..", "..", ".e2e-data", "flockctl.db");

/**
 * Bulk-insert chat_messages rows of arbitrary role. Bypasses the HTTP
 * handler's `role !== "user"` early-return guard so a user-styled bubble
 * can sit in the transcript without driving the AI executor.
 */
function seedMessages(
  chatId: number,
  rows: Array<{ role: string; content: string }>,
): void {
  const db = new Database(dbPath);
  try {
    const stmt = db.prepare(
      `INSERT INTO chat_messages (chat_id, role, content) VALUES (?, ?, ?)`,
    );
    for (const r of rows) stmt.run(chatId, r.role, r.content);
  } finally {
    db.close();
  }
}

/**
 * Mirror the freeze used by tokens-preview / visual-legacy-pages so
 * caret blink and resting transitions don't bleed into diffs.
 */
async function freezeAnimations(page: Page): Promise<void> {
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

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate((t) => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(t);
    localStorage.setItem("flockctl-theme", t);
  }, theme);
}

/**
 * Seed a fixture chat that exercises every persisted message kind the
 * conversation renderer cares about. Returns chatId + display title so
 * callers can navigate and assert the header rendered before
 * snapshotting.
 *
 * Order of rows matters — the right-rail "Changes" card and the
 * `agent-glow` halo both key off the LAST row, so we end on an
 * assistant turn to keep the screenshot focused on a stable trailing
 * bubble (no glow halo, no diff card).
 */
async function seedFixtureChat(
  request: import("@playwright/test").APIRequestContext,
): Promise<{ chatId: number; title: string }> {
  const ws = await createWorkspace(request);
  const title = uniq("chat-baseline");
  const chatRes = await request.post("/chats", {
    data: { title, workspaceId: ws.id },
  });
  expect([200, 201]).toContain(chatRes.status());
  const chat = (await chatRes.json()) as { id: number };

  seedMessages(chat.id, [
    {
      role: "user",
      content: "Read the config and tell me what flags are set.",
    },
    {
      role: "thinking",
      content:
        "The user wants the contents of the config file. I'll start by reading it with the Read tool, then summarize the toggles.",
    },
    {
      role: "tool",
      content: JSON.stringify({
        kind: "call",
        name: "Read",
        input: { file_path: "/etc/flockctl.conf" },
        summary: "Read /etc/flockctl.conf",
      }),
    },
    {
      role: "tool",
      content: JSON.stringify({
        kind: "result",
        name: "Read",
        output: "telemetry=on\nbeta_features=off\nmax_workers=4\n",
        summary: "3 lines",
      }),
    },
    {
      role: "assistant",
      content:
        "The config file sets three flags:\n\n```\ntelemetry=on\nbeta_features=off\nmax_workers=4\n```\n\nTelemetry is enabled, beta features are off, and the worker pool is capped at 4.",
    },
  ]);

  return { chatId: chat.id, title };
}

/**
 * 1×1 PNG used by the composer-with-attachment baseline. Magic-byte-valid
 * so the backend's `attachments-sniff` check accepts it. Identical buffer
 * shape used by `chats.spec.ts` — keep them in sync if the sniff list
 * tightens.
 */
const ONE_PX_PNG = Buffer.from(
  "89504E470D0A1A0A0000000D4948445200000001000000010806000000" +
    "1F15C4890000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082",
  "hex",
);

test.describe("chat-conversation visual baselines", () => {
  test.beforeEach(async ({ page }) => {
    // Belt-and-braces with `freezeAnimations`: emulateMedia drives the
    // `prefers-reduced-motion` media query so CSS rules gated on it
    // (`pulse-dot`, `agent-glow`) settle to their reduced state, while
    // the style tag above zeroes any animation/transition that isn't
    // gated. Both layers together produce snapshot-stable output.
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("transcript with every message type — light + dark", async ({
    page,
    request,
  }) => {
    const { chatId, title } = await seedFixtureChat(request);

    // ── Light baseline ────────────────────────────────────────────────
    await page.goto(`/chats/${chatId}`);
    await setTheme(page, "light");
    await expect(page.getByText(title).first()).toBeVisible({
      timeout: 10_000,
    });
    // Anchor on the last assistant bubble — once it's painted, every
    // earlier row has flushed too, so the screenshot is stable.
    await expect(
      page.getByText(/Telemetry is enabled/i).first(),
    ).toBeVisible({ timeout: 10_000 });
    await freezeAnimations(page);
    await expect(page).toHaveScreenshot("chat-conversation-types-light.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });

    // ── Dark baseline ─────────────────────────────────────────────────
    await setTheme(page, "dark");
    await freezeAnimations(page);
    await expect(page).toHaveScreenshot("chat-conversation-types-dark.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("streaming placeholder bubble while server reports is_running", async ({
    page,
    request,
  }) => {
    const { chatId, title } = await seedFixtureChat(request);

    // The "still working" placeholder is gated on
    // `isStreaming || serverRunning`, where `serverRunning` reads the
    // `is_running` field from the chat detail response (computed from
    // the in-memory `chatExecutor.isRunning(id)` — not a DB column we
    // can flip from this side). So we route-mock GET /chats/:id and
    // splice `is_running: true` onto the real response, leaving every
    // other field untouched. That's enough to flip the gate and render
    // the placeholder without driving a real stream.
    //
    // The glob match has to be tight — `**/chats/<id>` would also catch
    // the SPA's own `/chats/<id>` HTML route on the dev server (port
    // 5174), which then fed `route.fetch()` a `<!doctype html>` blob and
    // detonated the JSON parse. Pinning the host to 127.0.0.1:<port>
    // (= `VITE_API_URL` from playwright.config.ts) keeps the mock on the
    // API surface only, leaving the SPA navigation untouched.
    await page.route(
      new RegExp(`^http://127\\.0\\.0\\.1:\\d+/chats/${chatId}(?:\\?.*)?$`),
      async (route) => {
        const req = route.request();
        if (req.method() !== "GET") {
          await route.continue();
          return;
        }
        const res = await route.fetch();
        const body = (await res.json()) as Record<string, unknown>;
        body.is_running = true;
        await route.fulfill({
          status: res.status(),
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      },
    );

    await page.goto(`/chats/${chatId}`);
    await expect(page.getByText(title).first()).toBeVisible({
      timeout: 10_000,
    });
    // The Stop button is the cleanest signal that `serverRunning`
    // landed in the React tree — wait on it before snapshotting.
    await expect(page.getByTestId("chat-composer-cancel")).toBeVisible({
      timeout: 5_000,
    });
    await freezeAnimations(page);
    await expect(page).toHaveScreenshot("streaming.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("tool-call message expands to reveal payload", async ({
    page,
    request,
  }) => {
    const { chatId, title } = await seedFixtureChat(request);

    await page.goto(`/chats/${chatId}`);
    await expect(page.getByText(title).first()).toBeVisible({
      timeout: 10_000,
    });

    // Two tool rows in the fixture — the first is the call, the second
    // the result. Expanding the call surfaces `JsonCodeView` of the
    // input; expanding the result would reveal the output. We pick the
    // call row deterministically by index.
    const toolRows = page.getByTestId("stored-tool-message");
    await expect(toolRows.first()).toBeVisible({ timeout: 5_000 });
    await toolRows.first().locator("button").first().click();

    await freezeAnimations(page);
    await expect(page).toHaveScreenshot("tool-call-expanded.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("composer baselines — default + with attachment", async ({
    page,
    request,
  }) => {
    // Use a fresh empty chat (no seeded messages) so the composer dominates
    // the screenshot and the transcript area is the empty-state.
    const ws = await createWorkspace(request);
    const title = uniq("chat-composer-baseline");
    const chatRes = await request.post("/chats", {
      data: { title, workspaceId: ws.id },
    });
    expect([200, 201]).toContain(chatRes.status());
    const chat = (await chatRes.json()) as { id: number };

    await page.goto(`/chats/${chat.id}`);
    await expect(page.getByText(title).first()).toBeVisible({
      timeout: 10_000,
    });

    const composer = page.getByTestId("chat-composer");
    await expect(composer).toBeVisible();
    // Wait for the model + key dropdowns to settle on their default
    // labels — they're populated by /meta which the SPA fetches
    // asynchronously; without this the default screenshot can race the
    // toolbar's empty placeholders into the diff.
    await expect(page.getByTestId("chat-key-select")).toBeVisible();
    await freezeAnimations(page);
    await expect(composer).toHaveScreenshot("composer-default.png");

    // Upload a 1×1 PNG. The chip flips to data-status='ready' once the
    // POST returns; freeze + snapshot only AFTER that transition lands
    // so the chip's spinner/label pair is deterministic.
    await page
      .getByTestId("chat-composer-file-input")
      .setInputFiles({
        name: "pixel.png",
        mimeType: "image/png",
        buffer: ONE_PX_PNG,
      });
    const chip = page.getByTestId("attachment-chip").first();
    await expect(chip).toBeVisible({ timeout: 5_000 });
    await expect(chip).toHaveAttribute("data-status", "ready", {
      timeout: 5_000,
    });
    await freezeAnimations(page);
    await expect(composer).toHaveScreenshot("composer-with-attachment.png");
  });
});
