import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import { MissionSettingsDialog } from "@/pages/project-detail-components/MissionSettingsDialog";
import type { Mission } from "@/lib/hooks/missions";

/**
 * Slice 11/06 — `MissionSettingsDialog`.
 *
 * Pins:
 *   1. Renders objective / budget_tokens / budget_usd_cents / autonomy.
 *   2. Budget inputs reject non-positive / non-integer / overflow values
 *      with an inline error and never PATCH the mission.
 *   3. The `auto` autonomy radio is `disabled` and labelled with the
 *      "Not available in v1" tooltip.
 *   4. A successful save PATCHes ONLY the changed fields.
 *   5. A no-op save (nothing changed) closes silently without a network call.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 5 * 60_000 },
      mutations: { retry: false },
    },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, Wrapper };
}

const MISSION: Mission = {
  id: "mission-abc",
  project_id: "42",
  objective: "Make the dashboard fast",
  status: "active",
  autonomy: "suggest",
  budget_tokens: 1_000_000,
  budget_usd_cents: 5_000,
  spent_tokens: 0,
  spent_usd_cents: 0,
  supervisor_prompt_version: "v1",
  created_at: 1_700_000_000,
  updated_at: 1_700_000_500,
};

beforeEach(() => {
  // setup.ts installs a fresh fetch mock per test
});

function renderDialog(
  props: Partial<React.ComponentProps<typeof MissionSettingsDialog>> = {},
) {
  const { Wrapper } = makeWrapper();
  return render(
    <Wrapper>
      <MissionSettingsDialog
        open={true}
        onOpenChange={() => {}}
        mission={MISSION}
        {...props}
      />
    </Wrapper>,
  );
}

describe("mission_settings_dialog — surface", () => {
  it("renders objective / budget / autonomy controls when open", () => {
    renderDialog();

    expect(
      (screen.getByTestId("mission-objective") as HTMLTextAreaElement).value,
    ).toBe("Make the dashboard fast");
    expect(
      (screen.getByTestId("mission-budget-tokens") as HTMLInputElement).value,
    ).toBe("1000000");
    expect(
      (screen.getByTestId("mission-budget-cents") as HTMLInputElement).value,
    ).toBe("5000");
    expect(screen.getByTestId("mission-autonomy-suggest")).toBeTruthy();
  });

  it("renders nothing when open=false", () => {
    renderDialog({ open: false });
    expect(screen.queryByTestId("mission-settings-dialog")).toBeNull();
  });

  it("disables the auto autonomy radio with the v1 tooltip", () => {
    renderDialog();
    const autoRadio = screen.getByTestId(
      "mission-autonomy-auto",
    ) as HTMLInputElement;
    expect(autoRadio.disabled).toBe(true);
    expect(
      screen.getByTestId("mission-autonomy-auto-tooltip").textContent,
    ).toContain("Not available in v1");
  });
});

describe("mission_settings_dialog — budget validation", () => {
  it("rejects a zero budget_tokens value", async () => {
    const fetchMock = vi.fn();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const user = userEvent.setup();
    renderDialog();

    const tokensInput = screen.getByTestId(
      "mission-budget-tokens",
    ) as HTMLInputElement;
    await user.clear(tokensInput);
    await user.type(tokensInput, "0");
    await user.click(screen.getByTestId("mission-settings-save"));

    expect(screen.getByTestId("mission-settings-error").textContent).toMatch(
      /positive integer/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a negative budget_usd_cents value", async () => {
    const fetchMock = vi.fn();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const user = userEvent.setup();
    renderDialog();

    const centsInput = screen.getByTestId(
      "mission-budget-cents",
    ) as HTMLInputElement;
    // Browsers strip the minus sign when typed into type=number; bypass
    // userEvent and dispatch a synthetic change event with the negative
    // value so React's controlled state reflects what an operator could
    // produce by pasting or via devtools.
    fireEvent.change(centsInput, { target: { value: "-5" } });
    await user.click(screen.getByTestId("mission-settings-save"));

    expect(screen.getByTestId("mission-settings-error").textContent).toMatch(
      /positive integer/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer budget value", async () => {
    const fetchMock = vi.fn();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const user = userEvent.setup();
    renderDialog();

    const tokensInput = screen.getByTestId(
      "mission-budget-tokens",
    ) as HTMLInputElement;
    // userEvent.type on type=number can swallow the decimal point; dispatch
    // a synthetic change so React state reflects the non-integer value.
    fireEvent.change(tokensInput, { target: { value: "100.5" } });
    await user.click(screen.getByTestId("mission-settings-save"));

    expect(screen.getByTestId("mission-settings-error")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("mission_settings_dialog — submit", () => {
  it("PATCHes only changed fields and closes on success", async () => {
    const updated = {
      ...MISSION,
      objective: "New goal",
      budget_tokens: 2_000_000,
    };
    // The router returns camelCase, apiFetch transforms to snake_case.
    const wire = {
      id: updated.id,
      projectId: 42,
      objective: updated.objective,
      status: updated.status,
      autonomy: updated.autonomy,
      budgetTokens: updated.budget_tokens,
      budgetUsdCents: updated.budget_usd_cents,
      spentTokens: 0,
      spentUsdCents: 0,
      supervisorPromptVersion: "v1",
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(wire));
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    const objectiveInput = screen.getByTestId(
      "mission-objective",
    ) as HTMLTextAreaElement;
    await user.clear(objectiveInput);
    await user.type(objectiveInput, "New goal");

    const tokensInput = screen.getByTestId(
      "mission-budget-tokens",
    ) as HTMLInputElement;
    await user.clear(tokensInput);
    await user.type(tokensInput, "2000000");

    await user.click(screen.getByTestId("mission-settings-save"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/missions/mission-abc");
    expect((init as RequestInit)?.method).toBe("PATCH");

    // Body is JSON-encoded; we verify the PATCH only ships the fields
    // that actually changed (objective + budget_tokens — NOT
    // budget_usd_cents or autonomy). apiFetch translates the snake_case
    // request body keys to camelCase before sending.
    const body = JSON.parse(String((init as RequestInit)?.body));
    expect(body).toEqual({
      objective: "New goal",
      budgetTokens: 2_000_000,
    });

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("closes silently without a network call when nothing changed", async () => {
    const fetchMock = vi.fn();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    await user.click(screen.getByTestId("mission-settings-save"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces a server error and stays open", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "boom" }, 422),
      );
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    const objectiveInput = screen.getByTestId(
      "mission-objective",
    ) as HTMLTextAreaElement;
    await user.clear(objectiveInput);
    await user.type(objectiveInput, "Different objective");

    await user.click(screen.getByTestId("mission-settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("mission-settings-error").textContent).toContain(
        "boom",
      );
    });
    // onOpenChange should NOT have been called with `false` from the
    // dialog itself — the only call is the test's no-op (no auto-close).
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("rejects empty objective", async () => {
    const fetchMock = vi.fn();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const user = userEvent.setup();
    renderDialog();

    const objectiveInput = screen.getByTestId(
      "mission-objective",
    ) as HTMLTextAreaElement;
    await user.clear(objectiveInput);
    await user.click(screen.getByTestId("mission-settings-save"));

    expect(screen.getByTestId("mission-settings-error").textContent).toMatch(
      /required/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
