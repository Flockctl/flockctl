/**
 * Contract tests for the workspace-list "N waiting" badge.
 *
 * Mirrors the behavior of the project-list badge in
 * `ui/src/pages/projects.tsx` (lines ~675–689): inside the Name column
 * cell, a `<Badge variant="destructive">{count} waiting</Badge>` appears
 * when the workspace has at least one attention item routed to one of
 * its projects.
 *
 * Data flow guarded here (see the "Attention-count data flow" comment
 * in `workspaces.tsx`): the page composes `useProjects()` +
 * `useAttention()` into a workspace_id → count map. This test drives
 * that map via hook mocks; no real network.
 *
 * Corner cases:
 *   1. count > 0  → badge present with the exact "{N} waiting" text
 *   2. count === 0 (workspace has no pending attention) → no badge
 *   3. project carries workspace_id = null / undefined (orphan) →
 *      its attention items never contribute a count to any workspace,
 *      so no badge renders.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Project, Workspace } from "@/lib/types";
import type { AttentionItem } from "@/lib/api/attention";

// jsdom polyfills — Radix / shadcn dialogs and tooltips reach for APIs
// jsdom doesn't implement. Mirrors the polyfills in
// create_workspace_dialog_has_scroll_container.test.tsx.
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

// Fixture workspace — only two rows so assertions stay obvious.
const WORKSPACE_WITH_ATTENTION: Workspace = {
  id: "1",
  name: "Alpha Workspace",
  description: null,
  path: "/tmp/alpha",
  allowed_key_ids: null,
  gitignore_flockctl: false,
  gitignore_todo: false,
  gitignore_agents_md: false,
  created_at: "2026-04-23T00:00:00.000Z",
  updated_at: "2026-04-23T00:00:00.000Z",
};
const WORKSPACE_QUIET: Workspace = {
  ...WORKSPACE_WITH_ATTENTION,
  id: "2",
  name: "Beta Workspace",
  path: "/tmp/beta",
};

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: "p-default",
    name: "Project",
    description: null,
    path: null,
    workspace_id: null,
    repo_url: null,
    provider_fallback_chain: null,
    allowed_key_ids: null,
    gitignore_flockctl: false,
    gitignore_todo: false,
    gitignore_agents_md: false,
    use_project_claude_skills: false,
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
    ...overrides,
  };
}

function makeTaskApproval(project_id: string, task_id: string): AttentionItem {
  return {
    kind: "task_approval",
    task_id,
    project_id,
    title: `Task ${task_id}`,
    since: "2026-04-23T00:00:00.000Z",
  };
}

// The hook mock shape is driven by per-test variables so each case can
// swap projects + attention items without remounting the vi.mock factory.
let mockProjects: Project[] = [];
let mockAttentionItems: AttentionItem[] = [];

vi.mock("@/lib/hooks", () => ({
  useWorkspaces: () => ({
    data: [WORKSPACE_WITH_ATTENTION, WORKSPACE_QUIET],
    isLoading: false,
    error: null,
  }),
  useCreateWorkspace: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeleteWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
  useProjects: () => ({ data: mockProjects, isLoading: false, error: null }),
  useAttention: () => ({
    items: mockAttentionItems,
    total: mockAttentionItems.length,
    isLoading: false,
    error: null,
    connectionState: "open",
  }),
  useAIKeys: () => ({ data: [], isLoading: false }),
  // DirectoryPicker mounts eagerly and calls useFsBrowse — stub it.
  useFsBrowse: () => ({ data: undefined, isLoading: false, error: null }),
}));

// Import AFTER the mock so the page resolves the stubbed hooks.
import WorkspacesPage from "@/pages/workspaces";

beforeEach(() => {
  mockProjects = [];
  mockAttentionItems = [];
  document.body.innerHTML = "";
});

/** Return the `<tr>` that contains the workspace's name cell. */
function getRowByWorkspaceName(name: string): HTMLElement {
  const nameCell = screen.getByText(name);
  const row = nameCell.closest("tr");
  if (!row) throw new Error(`row for workspace ${name} not found`);
  return row as HTMLElement;
}

describe("WorkspacesPage — N waiting badge", () => {
  it("count > 0 renders a destructive badge with the exact '{N} waiting' text", () => {
    // Two projects in the Alpha workspace, three attention items total:
    // one on p-a1 and two on p-a2. Beta has a project but no attention.
    mockProjects = [
      makeProject({ id: "p-a1", name: "Alpha One", workspace_id: 1 }),
      makeProject({ id: "p-a2", name: "Alpha Two", workspace_id: 1 }),
      makeProject({ id: "p-b1", name: "Beta One", workspace_id: 2 }),
    ];
    mockAttentionItems = [
      makeTaskApproval("p-a1", "t-1"),
      makeTaskApproval("p-a2", "t-2"),
      makeTaskApproval("p-a2", "t-3"),
    ];

    render(
      <MemoryRouter>
        <WorkspacesPage />
      </MemoryRouter>,
    );

    const alphaRow = getRowByWorkspaceName("Alpha Workspace");
    // The badge should be INSIDE the row, and its text should be
    // "{N} waiting" — no decorations, no pluralisation in the body.
    const badge = within(alphaRow).getByText("3 waiting");
    expect(badge).toBeTruthy();
    // Sanity-check the variant: the destructive badge uses the
    // "destructive"-flavoured classes from shadcn's badge.tsx. We look
    // for the `bg-destructive` token rather than asserting the whole
    // class string (class order isn't stable).
    expect(badge.className).toMatch(/destructive/);
    // aria-label must match the singular/plural rule copied from
    // projects.tsx so screen readers announce "3 items waiting on you".
    expect(badge.getAttribute("aria-label")).toBe(
      "3 items waiting on you",
    );
  });

  it("count === 0 renders no badge in that row", () => {
    // Beta has a project but no attention items route to it.
    mockProjects = [
      makeProject({ id: "p-a1", workspace_id: 1 }),
      makeProject({ id: "p-b1", workspace_id: 2 }),
    ];
    mockAttentionItems = [makeTaskApproval("p-a1", "t-1")];

    render(
      <MemoryRouter>
        <WorkspacesPage />
      </MemoryRouter>,
    );

    const betaRow = getRowByWorkspaceName("Beta Workspace");
    // "waiting" must not appear anywhere in Beta's row.
    expect(within(betaRow).queryByText(/waiting/i)).toBeNull();
    // And concretely: no "0 waiting" silently rendered either. Regex
    // catches "0 waiting" / "0 item waiting" / etc.
    expect(within(betaRow).queryByText(/\b0 waiting\b/)).toBeNull();
  });

  it("attention items on orphan projects (workspace_id null/undefined) never render a badge", () => {
    // Two attention items — but their project has workspace_id = null,
    // so no workspace should receive a badge.
    mockProjects = [
      makeProject({ id: "p-orphan", workspace_id: null }),
      // Alpha has a project too, but no attention for it.
      makeProject({ id: "p-a1", workspace_id: 1 }),
    ];
    mockAttentionItems = [
      makeTaskApproval("p-orphan", "t-1"),
      makeTaskApproval("p-orphan", "t-2"),
    ];

    render(
      <MemoryRouter>
        <WorkspacesPage />
      </MemoryRouter>,
    );

    // Neither row should have the badge — the orphan items fall on the
    // floor as far as the workspace list is concerned.
    const alphaRow = getRowByWorkspaceName("Alpha Workspace");
    const betaRow = getRowByWorkspaceName("Beta Workspace");
    expect(within(alphaRow).queryByText(/waiting/i)).toBeNull();
    expect(within(betaRow).queryByText(/waiting/i)).toBeNull();
  });
});
