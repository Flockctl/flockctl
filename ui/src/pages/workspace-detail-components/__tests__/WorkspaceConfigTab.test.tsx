/**
 * Contract tests for WorkspaceConfigTab.
 *
 * WorkspaceConfigTab is the lift-and-shift of `workspace-settings.tsx`
 * into the Config tab of the redesigned workspace-detail page. These
 * tests lock the card-level section inventory and the workspace-only
 * AI config surface so no accidental regressions reintroduce
 * project-only cards (Model / Execution / Provider Fallback Chain) and
 * nothing gets silently dropped during future refactors.
 *
 * The underlying Skills / MCP / Secrets / AgentsMdEditor panels each
 * pull their own data — we stub them so the tests stay focused on the
 * Config tab composition, not on those panels' internals.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Workspace } from "@/lib/types";

// jsdom polyfills for Radix components (Select, Dialog, Checkbox all need
// some combination of these). Mirrors the polyfills in
// `ui/src/pages/__tests__/workspaces.test.tsx`.
if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof (Element.prototype as any).hasPointerCapture !== "function") {
  (Element.prototype as any).hasPointerCapture = () => false;
}
if (typeof (Element.prototype as any).setPointerCapture !== "function") {
  (Element.prototype as any).setPointerCapture = () => {};
}
if (typeof (Element.prototype as any).releasePointerCapture !== "function") {
  (Element.prototype as any).releasePointerCapture = () => {};
}
if (typeof (Element.prototype as any).scrollIntoView !== "function") {
  (Element.prototype as any).scrollIntoView = () => {};
}

const WORKSPACE: Workspace = {
  id: "ws-1",
  name: "Alpha Workspace",
  description: "First workspace",
  path: "/tmp/alpha",
  allowed_key_ids: [1],
  gitignore_flockctl: false,
  gitignore_todo: false,
  gitignore_agents_md: false,
  created_at: "2026-04-23T00:00:00.000Z",
  updated_at: "2026-04-23T00:00:00.000Z",
};

// Per-test hook state so each case can tweak without respawning the mocks.
let mockWorkspace: Workspace | null = WORKSPACE;
let mockWorkspaceLoading = false;
let mockWorkspaceError: Error | null = null;
let mockWsConfig: Record<string, any> | null = { permissionMode: null };
let mockAIKeys: any[] = [
  { id: "1", name: "Anthropic Prod", label: null, is_active: true },
];

const updateWorkspaceMutate = vi.fn().mockResolvedValue(undefined);
const updateWsConfigMutate = vi.fn().mockResolvedValue(undefined);
const deleteWorkspaceMutate = vi.fn();

vi.mock("@/lib/hooks", () => ({
  useWorkspace: () => ({
    data: mockWorkspace,
    isLoading: mockWorkspaceLoading,
    error: mockWorkspaceError,
  }),
  useWorkspaceConfig: () => ({
    data: mockWsConfig,
    isLoading: false,
    error: null,
  }),
  useAIKeys: () => ({ data: mockAIKeys, isLoading: false }),
  useUpdateWorkspace: () => ({
    mutateAsync: updateWorkspaceMutate,
    isPending: false,
  }),
  useUpdateWorkspaceConfig: () => ({
    mutateAsync: updateWsConfigMutate,
    isPending: false,
  }),
  useDeleteWorkspace: () => ({
    mutate: deleteWorkspaceMutate,
    isPending: false,
  }),
}));

// The inner panels each hit network / additional hooks. We don't exercise
// their internals here — just confirm WorkspaceConfigTab renders them in
// the right slot. Stubbing them also avoids pulling the SkillsPanel +
// McpPanel fetch machinery into this test.
vi.mock("@/components/AgentsMdEditor", () => ({
  AgentsMdEditor: ({ scope, id }: { scope: string; id: string }) => (
    <section data-testid="stub-agents-md-editor" data-scope={scope} data-id={id}>
      AgentsMdEditor stub
    </section>
  ),
}));
vi.mock("@/components/skills-panel", () => ({
  SkillsPanel: ({ level, workspaceId }: any) => (
    <section
      data-testid="stub-skills-panel"
      data-level={level}
      data-workspace-id={workspaceId}
    >
      SkillsPanel stub
    </section>
  ),
}));
vi.mock("@/components/mcp-panel", () => ({
  McpPanel: ({ level, workspaceId }: any) => (
    <section
      data-testid="stub-mcp-panel"
      data-level={level}
      data-workspace-id={workspaceId}
    >
      McpPanel stub
    </section>
  ),
}));
vi.mock("@/components/secrets-panel", () => ({
  SecretsPanel: ({ scope, workspaceId }: any) => (
    <section
      data-testid="stub-secrets-panel"
      data-scope={scope}
      data-workspace-id={workspaceId}
    >
      SecretsPanel stub
    </section>
  ),
}));
// PermissionModeSelect builds on Radix Select, which in jsdom is flaky
// without the polyfills above. Stub it out — the Config tab just threads
// value/onChange through to it.
vi.mock("@/components/permission-mode-select", () => ({
  PermissionModeSelect: ({ value, onChange }: any) => (
    <select
      data-testid="stub-permission-mode-select"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">(inherit)</option>
      <option value="default">default</option>
    </select>
  ),
}));

// Import AFTER the mocks so the component resolves the stubs.
import { WorkspaceConfigTab } from "../WorkspaceConfigTab";

function renderTab() {
  return render(
    <MemoryRouter>
      <WorkspaceConfigTab workspaceId="ws-1" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockWorkspace = WORKSPACE;
  mockWorkspaceLoading = false;
  mockWorkspaceError = null;
  mockWsConfig = { permissionMode: null };
  mockAIKeys = [
    { id: "1", name: "Anthropic Prod", label: null, is_active: true },
  ];
  updateWorkspaceMutate.mockClear().mockResolvedValue(undefined);
  updateWsConfigMutate.mockClear().mockResolvedValue(undefined);
  deleteWorkspaceMutate.mockClear();
  document.body.innerHTML = "";
});

describe("WorkspaceConfigTab", () => {
  it("renders the full section inventory in the documented order", () => {
    renderTab();

    // Cards with a matching <CardTitle> — order of first appearance in
    // the DOM drives our ordering assertion.
    const sectionTitles = [
      "General",
      "AI Configuration",
      "Gitignore",
      "Danger Zone",
    ];
    const positions = sectionTitles.map((title) => {
      const node = screen.getByText(title);
      // Walk up until the actual rendered node in document order.
      return Array.from(document.querySelectorAll("*")).indexOf(node);
    });
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);

    // The four non-Card panels: all mounted with workspace scope.
    const agents = screen.getByTestId("stub-agents-md-editor");
    expect(agents.getAttribute("data-scope")).toBe("workspace");
    expect(agents.getAttribute("data-id")).toBe("ws-1");
    const skills = screen.getByTestId("stub-skills-panel");
    expect(skills.getAttribute("data-level")).toBe("workspace");
    expect(skills.getAttribute("data-workspace-id")).toBe("ws-1");
    const mcp = screen.getByTestId("stub-mcp-panel");
    expect(mcp.getAttribute("data-level")).toBe("workspace");
    expect(mcp.getAttribute("data-workspace-id")).toBe("ws-1");
    const secrets = screen.getByTestId("stub-secrets-panel");
    expect(secrets.getAttribute("data-scope")).toBe("workspace");
    expect(secrets.getAttribute("data-workspace-id")).toBe("ws-1");
  });

  it("keeps the workspace AI surface thin — no project-only cards bleed in", () => {
    renderTab();

    // Workspace AI Configuration card owns exactly two knobs: the allow
    // list + the permission mode default. If someone promotes Model /
    // Execution / Provider Fallback Chain cards onto workspaces, these
    // assertions fail first.
    expect(screen.getByText("Allowed AI Keys *")).toBeTruthy();
    expect(screen.getByText("Permission mode")).toBeTruthy();

    // Project-only cards MUST NOT appear here.
    expect(screen.queryByText("Default Model")).toBeNull();
    expect(screen.queryByText("Planning Model")).toBeNull();
    expect(screen.queryByText("Base Branch")).toBeNull();
    expect(screen.queryByText("Execution")).toBeNull();
    expect(screen.queryByText("Daily Budget (USD)")).toBeNull();
    expect(screen.queryByText("Max concurrent")).toBeNull();
    expect(screen.queryByText("Timeout (s)")).toBeNull();
    expect(screen.queryByText("Post-task command")).toBeNull();
    expect(screen.queryByText("Environment Variables")).toBeNull();
    expect(screen.queryByText(/Provider Fallback Chain/i)).toBeNull();
  });

  it("prefills General fields and path from the loaded workspace", () => {
    renderTab();

    const nameInput = screen.getByLabelText("Name *") as HTMLInputElement;
    expect(nameInput.value).toBe("Alpha Workspace");
    const descInput = screen.getByLabelText("Description") as HTMLTextAreaElement;
    expect(descInput.value).toBe("First workspace");
    // Path is display-only (read-only, not editable).
    expect(screen.getByText("/tmp/alpha")).toBeTruthy();
  });

  it("save fans out into both mutations with the expected payload", async () => {
    renderTab();

    fireEvent.click(screen.getByTestId("workspace-config-save"));

    // Flush the microtask queue so the awaited mutations resolve.
    await Promise.resolve();
    await Promise.resolve();

    expect(updateWorkspaceMutate).toHaveBeenCalledTimes(1);
    const wsPayload = updateWorkspaceMutate.mock.calls[0]?.[0];
    expect(wsPayload).toMatchObject({
      id: "ws-1",
      data: {
        name: "Alpha Workspace",
        description: "First workspace",
        allowed_key_ids: [1],
        gitignore_flockctl: false,
        gitignore_todo: false,
        gitignore_agents_md: false,
      },
    });

    expect(updateWsConfigMutate).toHaveBeenCalledTimes(1);
    expect(updateWsConfigMutate.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      config: { permissionMode: null },
    });
  });

  it("blocks save with an inline error when the allow-list is empty", async () => {
    mockWorkspace = { ...WORKSPACE, allowed_key_ids: [] };
    renderTab();

    // Save button is disabled when the allow-list is empty — but the
    // error message ("Pick at least one AI provider key.") only appears
    // after a save attempt. Since the button is disabled we can't click
    // it; instead we assert the disabled state + the warning copy that
    // already renders when keys exist but none are selected.
    const saveBtn = screen.getByTestId("workspace-config-save") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    expect(screen.getByText("Select at least one key to save.")).toBeTruthy();
    // And the two mutations must not have fired.
    expect(updateWorkspaceMutate).not.toHaveBeenCalled();
    expect(updateWsConfigMutate).not.toHaveBeenCalled();
  });

  it("renders a skeleton while the workspace is loading", () => {
    mockWorkspace = null;
    mockWorkspaceLoading = true;
    renderTab();

    const root = screen.getByTestId("workspace-config-tab");
    // Sections must not be rendered yet.
    expect(screen.queryByText("General")).toBeNull();
    expect(screen.queryByText("Danger Zone")).toBeNull();
    // The root stays for a stable test handle.
    expect(root).toBeTruthy();
  });

  it("renders an error paragraph when the workspace fails to load", () => {
    mockWorkspace = null;
    mockWorkspaceError = new Error("boom");
    renderTab();

    const root = screen.getByTestId("workspace-config-tab");
    expect(root.tagName.toLowerCase()).toBe("p");
    expect(root.textContent).toContain("Failed to load workspace: boom");
  });
});
