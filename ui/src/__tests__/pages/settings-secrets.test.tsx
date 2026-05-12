import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SecretsSection } from "@/pages/settings-components/SecretsSection";

/**
 * Contract tests for `SecretsSection` (settings → Secrets tab).
 *
 * Pins down two layers:
 *   1. **Visual restyle** — the section is wrapped in a FlatCard
 *      (`rounded-xl bg-card`) instead of the legacy shadcn `<Card>`.
 *      The header carries the section title, scope hint, and the
 *      Add-Secret button; the body is the secrets list.
 *   2. **Security model preservation** — the existing reveal-on-click /
 *      "value never leaves the daemon" semantics are not broken. In
 *      practice that means:
 *        - the panel renders only metadata (name + description) and the
 *          `${secret:NAME}` placeholder reference, never the value;
 *        - reveal/edit/delete buttons surface for each secret;
 *        - editing only fires on an explicit click → dialog → save flow;
 *          the secret value is never typed into a query cache, never
 *          rendered, and never logged.
 *
 * The list-rendering logic lives in
 * [`secrets-panel.tsx`](../../components/secrets-panel.tsx); these tests
 * mount via `<SecretsSection>` so they exercise the section + panel
 * stack together — i.e. exactly what the settings page renders.
 */

// --- mocks -------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeRouter(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const fullUrl = typeof url === "string" ? url : String(url);
    // Strip the API base URL — apiFetch prefixes it.
    const path = fullUrl.replace(/^https?:\/\/[^/]+/, "");
    const key = `${method} ${path}`;
    let body: unknown = null;
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url: path, body });
    if (key in routes) return jsonResponse(routes[key]);
    if (path in routes) return jsonResponse(routes[path]);
    throw new Error(`unmocked fetch: ${key}`);
  });
  return { mock, calls };
}

function renderSection() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SecretsSection />
    </QueryClientProvider>,
  );
}

const SECRET_VALUE = "sk-this-MUST-NOT-leak-into-DOM";

const SAMPLE_SECRETS = [
  {
    id: 1,
    scope: "global",
    scope_id: null,
    name: "GITHUB_TOKEN",
    description: "GitHub PAT used by the github MCP",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: 2,
    scope: "global",
    scope_id: null,
    name: "OPENAI_API_KEY",
    description: null,
    created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  },
];

let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;
let consoleLogSpy: ReturnType<typeof vi.spyOn> | null = null;
let consoleWarnSpy: ReturnType<typeof vi.spyOn> | null = null;
let consoleInfoSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  (globalThis as { fetch?: typeof fetch }).fetch = vi.fn();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy?.mockRestore();
  consoleLogSpy?.mockRestore();
  consoleWarnSpy?.mockRestore();
  consoleInfoSpy?.mockRestore();
});

// --- tests -------------------------------------------------------------------

describe("SecretsSection — restyled wrapper", () => {
  it("wraps the panel in a FlatCard (rounded-xl + bg-card) and renders the section testid", async () => {
    const { mock } = makeRouter({
      "/secrets/global": { secrets: [] },
    });
    (globalThis as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;

    renderSection();

    // Section landmark.
    const section = screen.getByTestId("secrets-section");
    expect(section).toBeInTheDocument();

    // FlatCard primitive — assert via its hard-flat class signature
    // (rounded-xl + border + bg-card). This pins the restyle without
    // coupling the test to the FlatCard component's internal markup.
    const flatCard = section.firstChild as HTMLElement;
    expect(flatCard.className).toContain("rounded-xl");
    expect(flatCard.className).toContain("bg-card");
    expect(flatCard.className).toContain("border");
  });

  it("renders the section header (title, scope hint, Add Secret button)", async () => {
    const { mock } = makeRouter({
      "/secrets/global": { secrets: [] },
    });
    (globalThis as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;

    renderSection();

    expect(
      await screen.findByRole("heading", { name: "Secrets" }),
    ).toBeInTheDocument();
    // Add Secret button surfaces the create flow (icon + label).
    expect(screen.getByTestId("secrets-add-button")).toBeInTheDocument();
    // Scope hint copy mentions the placeholder reference syntax so
    // operators discover MCP wiring without leaving the page.
    expect(
      screen.getByText(/Encrypted at rest/i),
    ).toBeInTheDocument();
  });
});

describe("SecretsSection — list rendering", () => {
  it("renders one row per secret with name + masked placeholder + edit/delete buttons", async () => {
    const { mock } = makeRouter({
      "/secrets/global": { secrets: SAMPLE_SECRETS },
    });
    (globalThis as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;

    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId("secrets-list")).toBeInTheDocument();
    });

    for (const secret of SAMPLE_SECRETS) {
      const row = screen.getByTestId(`secret-row-${secret.name}`);
      // Name
      expect(within(row).getByText(secret.name)).toBeInTheDocument();
      // Masked placeholder reference (this is what operators paste into
      // MCP env — it intentionally does NOT contain the value).
      expect(
        within(row).getByTestId(`secret-placeholder-${secret.name}`),
      ).toHaveTextContent(`\${secret:${secret.name}}`);
      // Edit + delete buttons (security: editing routes through the
      // explicit-input dialog; deleting prompts via ConfirmDialog).
      expect(
        within(row).getByTestId(`secret-edit-${secret.name}`),
      ).toBeInTheDocument();
      expect(
        within(row).getByTestId(`secret-delete-${secret.name}`),
      ).toBeInTheDocument();
    }
  });

  it("renders the empty-state copy when no secrets exist at the global scope", async () => {
    const { mock } = makeRouter({
      "/secrets/global": { secrets: [] },
    });
    (globalThis as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;

    renderSection();

    expect(
      await screen.findByText(/No secrets at this scope yet/i),
    ).toBeInTheDocument();
    // List landmark only exists when there are rows to render.
    expect(screen.queryByTestId("secrets-list")).not.toBeInTheDocument();
  });
});

describe("SecretsSection — security model preserved", () => {
  it("never renders the secret value into the DOM (API does not return it)", async () => {
    // Belt-and-braces: even if a buggy backend leaked a value field, the
    // panel must not render it. We feed an extra `value` key into the
    // payload and assert it does NOT appear anywhere in the document.
    const leaky = SAMPLE_SECRETS.map((s) => ({
      ...s,
      value: SECRET_VALUE, // attacker-controlled extra field
    }));
    const { mock } = makeRouter({
      "/secrets/global": { secrets: leaky },
    });
    (globalThis as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;

    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId("secrets-list")).toBeInTheDocument();
    });

    // The value must not appear anywhere — visible text, attribute, or
    // tooltip. `document.body.textContent` covers visible text; the
    // outerHTML check covers tooltips/title/aria-label leakage.
    expect(document.body.textContent ?? "").not.toContain(SECRET_VALUE);
    expect(document.body.outerHTML).not.toContain(SECRET_VALUE);
  });

  it("never logs the secret value to the console on render", async () => {
    const leaky = SAMPLE_SECRETS.map((s) => ({ ...s, value: SECRET_VALUE }));
    const { mock } = makeRouter({
      "/secrets/global": { secrets: leaky },
    });
    (globalThis as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;

    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId("secrets-list")).toBeInTheDocument();
    });

    for (const spy of [
      consoleLogSpy,
      consoleErrorSpy,
      consoleWarnSpy,
      consoleInfoSpy,
    ]) {
      const calls = spy?.mock.calls ?? [];
      for (const args of calls) {
        const serialised = args.map((a: unknown) => {
          try {
            return typeof a === "string" ? a : JSON.stringify(a);
          } catch {
            return String(a);
          }
        }).join(" ");
        expect(serialised).not.toContain(SECRET_VALUE);
      }
    }
  });

  it("does not request the secret value from the server (only the metadata list endpoint)", async () => {
    const { mock, calls } = makeRouter({
      "/secrets/global": { secrets: SAMPLE_SECRETS },
    });
    (globalThis as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;

    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId("secrets-list")).toBeInTheDocument();
    });

    // The panel must only hit the list endpoint; there is no per-secret
    // GET in the API surface and the panel must not invent one.
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.every((c) => c.url === "/secrets/global")).toBe(true);
  });

  it("editing requires explicit click (button → dialog) — no inline reveal of values", async () => {
    const user = userEvent.setup();
    const { mock } = makeRouter({
      "/secrets/global": { secrets: SAMPLE_SECRETS },
    });
    (globalThis as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;

    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId("secrets-list")).toBeInTheDocument();
    });

    // Before the click: no edit dialog, no inputs for the secret value.
    expect(
      screen.queryByRole("dialog", { name: /Update Secret/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId("secret-edit-GITHUB_TOKEN"));

    // After the click: the dialog opens; the value field is a password
    // input (autocomplete off, type=password), starts empty, and is
    // labelled "Value" — i.e. there is no path that pre-populates the
    // field with the existing value.
    const dialog = await screen.findByRole("dialog", {
      name: /Update Secret/i,
    });
    const valueInput = within(dialog).getByLabelText(/Value/i);
    expect(valueInput).toHaveAttribute("type", "password");
    expect(valueInput).toHaveAttribute("autocomplete", "off");
    expect(valueInput).toHaveValue("");
  });

  it("deleting routes through ConfirmDialog (no silent destructive action)", async () => {
    const user = userEvent.setup();
    const { mock } = makeRouter({
      "/secrets/global": { secrets: SAMPLE_SECRETS },
    });
    (globalThis as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;

    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId("secrets-list")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("secret-delete-GITHUB_TOKEN"));

    // The confirm dialog must surface the secret name in the prompt so
    // the operator can verify they are deleting the right thing before
    // the destructive call is fired.
    const confirm = await screen.findByRole("dialog", {
      name: /Delete Secret/i,
    });
    expect(confirm).toHaveTextContent(/GITHUB_TOKEN/);
  });
});
