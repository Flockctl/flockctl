import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ConfigTab } from "@/pages/project-detail-components/ConfigTab";

/**
 * Contract tests for the redesigned Config tab (M23 / project-detail / T08).
 *
 * Pins the design-tier surface invariants that the slice spec calls out:
 *   - Every visible form row uses the
 *     `grid grid-cols-[200px_1fr] gap-4 items-baseline` layout.
 *   - Labels in those rows render at `text-zinc-500 text-[12px]`.
 *   - The General / AI Configuration / Execution / Environment Variables /
 *     Gitignore / Project skills / Danger Zone sections all live inside
 *     a `<FlatCard>` (rounded-xl border).
 *   - shadcn `Input`, `Textarea`, `Select`, `Checkbox` primitives still
 *     drive the form (forms exception per CONTRIBUTING-DESIGN.md).
 *   - The two-step save still fires `updateProject` then
 *     `updateProjectConfig` with the user's edits.
 *
 * Heavy children (AGENTS.md editor, Skills / MCP / Secrets panels) are
 * stubbed so the tests stay focused on the form layout.
 */

// --- Stubs for the embedded panels that talk to network APIs ----------------

vi.mock("@/components/AgentsMdEditor", () => ({
  AgentsMdEditor: () => <div data-testid="agents-md-editor-stub" />,
}));
vi.mock("@/components/skills-panel", () => ({
  SkillsPanel: () => <div data-testid="skills-panel-stub" />,
}));
vi.mock("@/components/mcp-panel", () => ({
  McpPanel: () => <div data-testid="mcp-panel-stub" />,
}));
vi.mock("@/components/secrets-panel", () => ({
  SecretsPanel: () => <div data-testid="secrets-panel-stub" />,
}));
vi.mock("@/components/confirm-dialog", () => ({
  ConfirmDialog: () => null,
}));

// --- Hook fixtures ---------------------------------------------------------

const updateProjectMutate = vi.fn().mockResolvedValue({});
const updateConfigMutate = vi.fn().mockResolvedValue({});

// Stable references — useEffect dependencies in ConfigTab key off these
// objects, so returning a fresh literal on every render would loop.
const PROJECT_FIXTURE = {
  id: "p-1",
  name: "Project One",
  description: "Initial description",
  repo_url: "git@github.com:org/repo.git",
  path: "/Users/me/work/project",
  workspace_id: 1,
  provider_fallback_chain: null,
  allowed_key_ids: [42],
  gitignore_flockctl: false,
  gitignore_todo: false,
  gitignore_agents_md: false,
  use_project_claude_skills: false,
  created_at: "2026-05-07T00:00:00Z",
  updated_at: "2026-05-07T00:00:00Z",
};
const PROJECT_QUERY = {
  data: PROJECT_FIXTURE,
  isLoading: false,
  error: null,
};
const CONFIG_FIXTURE = {
  baseBranch: "main",
  model: "",
  planningModel: "",
  testCommand: "",
  defaultTimeout: 300,
  maxConcurrentTasks: 5,
  budgetDailyUsd: 10.0,
  requiresApproval: false,
  permissionMode: null,
  env: { NODE_ENV: "production" },
};
const CONFIG_QUERY = { data: CONFIG_FIXTURE, isLoading: false };
const META_QUERY = {
  data: {
    models: [
      { id: "claude-opus-4.7", name: "Claude Opus 4.7" },
      { id: "claude-sonnet-4.7", name: "Claude Sonnet 4.7" },
    ],
  },
};
const AI_KEYS_QUERY = {
  data: [
    {
      id: 42,
      name: "Primary",
      label: "Primary",
      provider: "anthropic",
      is_active: true,
    },
  ],
};
const UPDATE_PROJECT_HANDLE = {
  isPending: false,
  mutateAsync: updateProjectMutate,
};
const UPDATE_CONFIG_HANDLE = {
  isPending: false,
  mutateAsync: updateConfigMutate,
};
const DELETE_PROJECT_HANDLE = { isPending: false, mutate: vi.fn() };

vi.mock("@/lib/hooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hooks")>(
    "@/lib/hooks",
  );
  return {
    ...actual,
    useProject: () => PROJECT_QUERY,
    useProjectConfig: () => CONFIG_QUERY,
    useMeta: () => META_QUERY,
    useAIKeys: () => AI_KEYS_QUERY,
    useUpdateProject: () => UPDATE_PROJECT_HANDLE,
    useUpdateProjectConfig: () => UPDATE_CONFIG_HANDLE,
    useDeleteProject: () => DELETE_PROJECT_HANDLE,
  };
});

// --- Helpers ---------------------------------------------------------------

function renderConfigTab() {
  return render(
    <MemoryRouter initialEntries={["/projects/p-1?tab=config"]}>
      <Routes>
        <Route
          path="/projects/:projectId"
          element={<ConfigTab projectId="p-1" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

const FORM_ROW_CLASSES = [
  "grid",
  "grid-cols-[200px_1fr]",
  "gap-4",
  "items-baseline",
] as const;

function getRowFor(label: string) {
  // Labels are 12px zinc-500 spans/labels — find by text exactly and walk
  // up to the nearest grid row. Using exact:true here avoids accidental
  // substring/case-insensitive matches against textarea contents (e.g.
  // "Initial description" colliding with the "Description" label).
  const candidates = screen.getAllByText(label, { exact: true });
  const labelNode = candidates.find(
    (n) => n.tagName === "LABEL" || n.tagName === "SPAN",
  );
  if (!labelNode) {
    throw new Error(`No label/span found for: ${label}`);
  }
  const row = labelNode.closest("div.grid");
  if (!row) throw new Error(`No grid row found for label: ${label}`);
  return row as HTMLElement;
}

// --- Tests -----------------------------------------------------------------

describe("ConfigTab — design-tier layout", () => {
  it("renders the page root with no skeleton when data is loaded", () => {
    renderConfigTab();
    expect(screen.getByTestId("project-config-tab")).toBeInTheDocument();
  });

  it("groups related rows inside FlatCard panels (rounded-xl + border)", () => {
    renderConfigTab();
    // Each section header is rendered inside a FlatCard wrapper.
    for (const id of [
      "config-general-header",
      "config-ai-header",
      "config-execution-header",
      "config-env-header",
      "config-gitignore-header",
      "config-claude-skills-header",
      "config-danger-header",
    ]) {
      const header = screen.getByTestId(id);
      const card = header.closest("div.rounded-xl");
      expect(card, `${id} should sit inside a FlatCard`).not.toBeNull();
      expect(card!.className).toContain("border");
      expect(card!.className).toContain("bg-card");
    }
  });

  it("uses the prototype's 200px / 1fr form-row grid for every labelled row", () => {
    renderConfigTab();
    const rows = [
      "Name *",
      "Remote URL",
      "Description",
      "Path",
      "Allowed AI keys *",
      "Permission mode",
      "Default model",
      "Planning model",
      "Base branch",
      "Timeout (s)",
      "Max concurrent",
      "Daily budget (USD)",
      "Approval",
      "Post-task command",
      "KEY=VALUE",
      "Additional ignores",
      "Project .claude/skills/",
      "Delete project",
    ];
    for (const label of rows) {
      const row = getRowFor(label);
      for (const cls of FORM_ROW_CLASSES) {
        expect(
          row.className,
          `row "${label}" missing class ${cls}`,
        ).toContain(cls);
      }
    }
  });

  it("renders labels at text-zinc-500 text-[12px]", () => {
    renderConfigTab();
    // Spot-check several rows — both <label htmlFor> and plain <span>
    // labels follow the same typography contract. Use exact:true to
    // avoid colliding with control values that contain the same word.
    for (const label of [
      "Name *",
      "Remote URL",
      "Default model",
      "Daily budget (USD)",
      "KEY=VALUE",
      "Delete project",
    ]) {
      const candidates = screen.getAllByText(label, { exact: true });
      const node = candidates.find(
        (n) => n.tagName === "LABEL" || n.tagName === "SPAN",
      );
      expect(node, `label "${label}" not found`).toBeDefined();
      expect(node!.className).toContain("text-zinc-500");
      expect(node!.className).toContain("text-[12px]");
    }
  });

  it("keeps the shadcn Input / Textarea / Select / Checkbox primitives", () => {
    renderConfigTab();
    const nameInput = screen.getByLabelText("Name *") as HTMLInputElement;
    expect(nameInput.tagName).toBe("INPUT");
    const description = screen.getByLabelText(
      "Description",
    ) as HTMLTextAreaElement;
    expect(description.tagName).toBe("TEXTAREA");
    const env = screen.getByLabelText("KEY=VALUE") as HTMLTextAreaElement;
    expect(env.tagName).toBe("TEXTAREA");
    // Select trigger (Radix renders as a button with role="combobox"); we
    // anchor on the model label text.
    const aiHeader = screen.getByTestId("config-ai-header");
    const card = aiHeader.closest("div.rounded-xl") as HTMLElement;
    expect(within(card).getAllByRole("combobox").length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("seeds the form from useProject + useProjectConfig", () => {
    renderConfigTab();
    expect((screen.getByLabelText("Name *") as HTMLInputElement).value).toBe(
      "Project One",
    );
    expect(
      (screen.getByLabelText("Remote URL") as HTMLInputElement).value,
    ).toBe("git@github.com:org/repo.git");
    expect((screen.getByLabelText("Base branch") as HTMLInputElement).value).toBe(
      "main",
    );
    expect((screen.getByLabelText("Timeout (s)") as HTMLInputElement).value).toBe(
      "300",
    );
    expect(
      (screen.getByLabelText("Max concurrent") as HTMLInputElement).value,
    ).toBe("5");
    expect(
      (screen.getByLabelText("Daily budget (USD)") as HTMLInputElement).value,
    ).toBe("10");
    expect(
      (screen.getByLabelText("KEY=VALUE") as HTMLTextAreaElement).value,
    ).toBe("NODE_ENV=production");
  });
});

describe("ConfigTab — save handler", () => {
  it("Save triggers updateProject + updateProjectConfig with edited values", async () => {
    updateProjectMutate.mockClear();
    updateConfigMutate.mockClear();
    renderConfigTab();

    const name = screen.getByLabelText("Name *") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Renamed Project" } });

    const branch = screen.getByLabelText("Base branch") as HTMLInputElement;
    fireEvent.change(branch, { target: { value: "develop" } });

    const saveBtn = screen.getByTestId("project-config-save");
    fireEvent.click(saveBtn);

    // Both mutations are kicked off synchronously inside handleSave; the
    // mocks resolve immediately. Yield once for the microtask queue.
    await Promise.resolve();
    await Promise.resolve();

    expect(updateProjectMutate).toHaveBeenCalledTimes(1);
    expect(updateProjectMutate.mock.calls[0]![0]!.data.name).toBe(
      "Renamed Project",
    );
    expect(updateProjectMutate.mock.calls[0]![0]!.data.allowed_key_ids).toEqual([
      42,
    ]);

    expect(updateConfigMutate).toHaveBeenCalledTimes(1);
    expect(updateConfigMutate.mock.calls[0]![0]!.config.baseBranch).toBe(
      "develop",
    );
  });

  it("Save with an empty Name surfaces the inline validation error", () => {
    updateProjectMutate.mockClear();
    updateConfigMutate.mockClear();
    renderConfigTab();

    const name = screen.getByLabelText("Name *") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "   " } });

    const saveBtn = screen.getByTestId("project-config-save");
    fireEvent.click(saveBtn);

    expect(screen.getByTestId("project-config-error")).toHaveTextContent(
      /name is required/i,
    );
    expect(updateProjectMutate).not.toHaveBeenCalled();
    expect(updateConfigMutate).not.toHaveBeenCalled();
  });
});
