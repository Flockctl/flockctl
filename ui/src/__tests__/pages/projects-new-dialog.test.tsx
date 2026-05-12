import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { NewProjectDialog } from "@/pages/projects-components/NewProjectDialog";

// jsdom doesn't ship with ResizeObserver — Radix's Dialog primitives
// reach for it in a layout effect. A no-op stub is enough here (we
// never measure the dialog). Mirrors the polyfill in
// create_workspace_dialog_has_scroll_container.test.tsx.
if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/**
 * Tests for the refreshed NewProjectDialog (extracted from pages/projects.tsx
 * during the M22+ design refresh). The legacy CreateProjectDialog used a
 * vertical `space-y-4` stack of `<div className="space-y-2">` label/control
 * pairs; the new layout collapses that into a 2-column CSS grid
 * (`grid-cols-[160px_1fr]`) so every row shares a consistent label gutter.
 *
 * What we assert here:
 *
 *   1. Trigger renders and opens the dialog (shadcn Dialog still in use —
 *      forms exception per ui/CONTRIBUTING-DESIGN.md).
 *   2. The form layout uses the `grid-cols-[160px_1fr]` token. We assert on
 *      this class directly via `data-testid="new-project-grid"` so an
 *      accidental rewrite back to the old `space-y-4` stack fails loudly.
 *   3. Field validation: empty name → "Name is required" inline error,
 *      submit blocked.
 *   4. Field validation: name OK but no allowed-key picked → AI-key
 *      requirement surfaces. The submit button stays disabled until a
 *      key is ticked.
 *   5. Happy path: filling Name + ticking a key + clicking Create POSTs to
 *      /projects with the expected payload, exercising the preserved
 *      `useCreateProject` mutation.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build a (method, url) → response router so each test states only the
 * routes it actually exercises. Unmatched calls throw, which surfaces an
 * accidental new fetch the next time someone touches the dialog.
 */
function makeRouter(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url}`;
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ method, url, body });
    if (key in routes) return jsonResponse(routes[key]);
    if (url in routes) return jsonResponse(routes[url]);
    throw new Error(`unmocked fetch: ${key}`);
  });
  return { mock, calls };
}

function renderDialog() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <NewProjectDialog />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // setup.ts seeds a fresh fetch mock per test; per-test code overrides it.
  (globalThis as any).fetch = vi.fn();
});

describe("NewProjectDialog — trigger + open", () => {
  it("renders the trigger button and opens the dialog on click", async () => {
    const user = userEvent.setup();
    const { mock } = makeRouter({
      "/workspaces": { items: [], total: 0 },
      "/keys": { items: [], total: 0 },
    });
    (globalThis as any).fetch = mock;

    renderDialog();

    expect(screen.getByTestId("new-project-trigger")).toBeInTheDocument();
    expect(screen.queryByTestId("new-project-dialog")).toBeNull();

    await user.click(screen.getByTestId("new-project-trigger"));

    const dialog = await screen.findByTestId("new-project-dialog");
    expect(dialog).toBeInTheDocument();
    // The DialogTitle is the heading inside the dialog — pin to the
    // dialog scope so we don't double-match the trigger button text.
    expect(within(dialog).getByText("Create Project")).toBeInTheDocument();
  });
});

describe("NewProjectDialog — restyled grid layout", () => {
  it("inner form rows live inside a grid-cols-[160px_1fr] container", async () => {
    const user = userEvent.setup();
    const { mock } = makeRouter({
      "/workspaces": { items: [], total: 0 },
      "/keys": { items: [], total: 0 },
    });
    (globalThis as any).fetch = mock;

    renderDialog();
    await user.click(screen.getByTestId("new-project-trigger"));

    const grid = await screen.findByTestId("new-project-grid");
    // The grid token is the visual fingerprint of the refresh — assert the
    // exact utility class rather than just `grid` so a regression to the
    // legacy `space-y-4` stack is caught here, not on a screenshot.
    expect(grid.className).toContain("grid-cols-[160px_1fr]");
    expect(grid.className).toContain("grid");
  });

  it("preserves the shadcn Dialog (forms exception) — DialogContent is rendered", async () => {
    const user = userEvent.setup();
    const { mock } = makeRouter({
      "/workspaces": { items: [], total: 0 },
      "/keys": { items: [], total: 0 },
    });
    (globalThis as any).fetch = mock;

    renderDialog();
    await user.click(screen.getByTestId("new-project-trigger"));

    // DialogContent is identified by Radix via role="dialog".
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // The Radix dialog hosts our test-id'd form.
    expect(within(dialog).getByTestId("new-project-form")).toBeInTheDocument();
  });
});

describe("NewProjectDialog — validation", () => {
  it("blocks submit with empty name and surfaces 'Name is required'", async () => {
    const user = userEvent.setup();
    const { mock, calls } = makeRouter({
      // Seed an active key so we get *past* the "no keys" early-return and
      // the disabled-submit state — the gate we want to test here is the
      // name validation, not the key gate.
      "/workspaces": { items: [], total: 0 },
      "/keys": {
        items: [{ id: 1, name: "default", is_active: true }],
        total: 1,
      },
    });
    (globalThis as any).fetch = mock;

    renderDialog();
    await user.click(screen.getByTestId("new-project-trigger"));
    await screen.findByTestId("new-project-dialog");

    // Tick the only available key so the submit button is enabled and the
    // form actually attempts submission. Radix Checkbox renders as a button
    // with role="checkbox", so we click the wrapping label (which the
    // browser treats as a click on the labelled control) by its text.
    await waitFor(() => {
      expect(screen.getByText(/^default$/i)).toBeInTheDocument();
    });
    const keyLabel = screen.getByText(/^default$/i).closest("label")!;
    await user.click(within(keyLabel).getByRole("checkbox"));

    await user.click(screen.getByTestId("new-project-submit"));

    expect(await screen.findByTestId("new-project-error")).toHaveTextContent(
      /name is required/i,
    );
    // No POST /projects call should have been made.
    expect(
      calls.find((c) => c.method === "POST" && c.url === "/projects"),
    ).toBeUndefined();
  });

  it("disables submit when no AI keys are picked", async () => {
    const user = userEvent.setup();
    const { mock } = makeRouter({
      "/workspaces": { items: [], total: 0 },
      "/keys": {
        items: [{ id: 1, name: "default", is_active: true }],
        total: 1,
      },
    });
    (globalThis as any).fetch = mock;

    renderDialog();
    await user.click(screen.getByTestId("new-project-trigger"));
    await screen.findByTestId("new-project-dialog");

    await waitFor(() => {
      expect(screen.getByText(/^default$/i)).toBeInTheDocument();
    });

    // No key ticked → submit button is disabled regardless of name.
    expect(screen.getByTestId("new-project-submit")).toBeDisabled();
  });
});

describe("NewProjectDialog — happy path", () => {
  it("POSTs /projects with the trimmed name and chosen key, then closes", async () => {
    const user = userEvent.setup();
    const { mock, calls } = makeRouter({
      "/workspaces": { items: [], total: 0 },
      "/keys": {
        items: [{ id: 7, name: "anthropic-prod", is_active: true }],
        total: 1,
      },
      "POST /projects": { id: "p-new", name: "Demo" },
    });
    (globalThis as any).fetch = mock;

    renderDialog();
    await user.click(screen.getByTestId("new-project-trigger"));
    await screen.findByTestId("new-project-dialog");

    // Wait for the keys to populate, then tick one. Radix Checkbox renders
    // as a button with role="checkbox", so we resolve the wrapping <label>
    // via the visible key text and click the checkbox inside it.
    await waitFor(() => {
      expect(screen.getByText(/anthropic-prod/i)).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText(/^name$/i), "Demo");
    const keyLabel = screen.getByText(/anthropic-prod/i).closest("label")!;
    await user.click(within(keyLabel).getByRole("checkbox"));
    await user.click(screen.getByTestId("new-project-submit"));

    await waitFor(() => {
      expect(
        calls.find((c) => c.method === "POST" && c.url === "/projects"),
      ).toBeTruthy();
    });

    const post = calls.find(
      (c) => c.method === "POST" && c.url === "/projects",
    )!;
    // apiFetch deep-converts outgoing body keys snake_case → camelCase
    // before sending, so the wire shape is `allowedKeyIds`, not the
    // `allowed_key_ids` literal we wrote in the component (see
    // ui/src/lib/api/core.ts → toCamelKeys).
    const body = post.body as {
      name: string;
      baseBranch: string;
      allowedKeyIds: number[];
    };
    expect(body.name).toBe("Demo");
    expect(body.baseBranch).toBe("main");
    expect(body.allowedKeyIds).toEqual([7]);

    // After a successful create the dialog resets + closes — the form
    // should no longer be in the DOM.
    await waitFor(() => {
      expect(screen.queryByTestId("new-project-dialog")).toBeNull();
    });
  });
});
