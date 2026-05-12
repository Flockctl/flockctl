import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type {
  GitDiffWithContentsResult,
  GitDiffWithContentsSuccess,
} from "@/lib/api/git-diff";

/**
 * Unit tests for {@link DiffTabContent}.
 *
 * Boundaries exercised:
 *   - Loading branch renders the spinner; failure renders the
 *     fallback with `data-reason`.
 *   - On `ok:true`, the editor is invoked with the two side buffers
 *     plumbed through to Monaco's DiffEditor.
 *   - When either side is `null` (oversize), the "too large" fallback
 *     renders instead.
 *   - `binary` and `unchanged` statuses get their own informational
 *     panes rather than a misleading editor mount.
 *   - Tab close icon delegates to `tabStore.closeTab` so the parent
 *     can fall back to the file pane.
 *
 * Monaco is mocked to a trivial pre/code element — jsdom can't host
 * the real Monaco runtime + worker, and the assertions only need the
 * props (original / value / readOnly).
 */

vi.mock("@/components/CodeEditor", () => ({
  CodeEditor: ({
    diff,
    value,
    path,
    onChange,
  }: {
    diff?: { original: string };
    value: string;
    path?: string;
    onChange?: (next: string) => void;
  }) => (
    <pre
      data-testid="mock-code-editor"
      data-path={path ?? ""}
      data-readonly={onChange === undefined ? "true" : "false"}
      data-original={diff?.original ?? ""}
    >
      {value}
    </pre>
  ),
}));

type DiffState = {
  data?: GitDiffWithContentsResult;
  isLoading: boolean;
  error?: Error;
};

let diffState: DiffState;
let lastQueryArgs:
  | {
      scope: "projects" | "workspaces";
      entityId: string;
      path: string;
      mode: { staged?: boolean; base?: string; head?: string };
    }
  | null = null;

vi.mock("@/lib/hooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hooks")>(
    "@/lib/hooks",
  );
  return {
    ...actual,
    useGitDiff: (
      scope: "projects" | "workspaces",
      entityId: string,
      path: string,
      mode: { staged?: boolean; base?: string; head?: string } = {},
    ) => {
      lastQueryArgs = { scope, entityId, path, mode };
      return {
        data: diffState.data,
        isLoading: diffState.isLoading,
        error: diffState.error,
      };
    },
  };
});

import { DiffTabContent } from "@/components/code-mode/DiffTabContent";
import {
  tabStore,
  diffTabId,
  type DiffTab,
} from "@/components/code-mode/tab-store";

function makeTab(overrides: Partial<DiffTab> = {}): DiffTab {
  const path = overrides.path ?? "src/foo.ts";
  const scope: "projects" | "workspaces" = overrides.scope ?? "projects";
  const entityId = overrides.entityId ?? "p1";
  const mode = {
    ...(overrides.staged === true ? { staged: true } : {}),
    ...(overrides.base !== undefined ? { base: overrides.base } : {}),
    ...(overrides.head !== undefined ? { head: overrides.head } : {}),
  };
  return {
    kind: "diff",
    id: overrides.id ?? diffTabId(scope, entityId, path, mode),
    scope,
    entityId,
    path,
    ...mode,
  };
}

function makeOk(
  overrides: Partial<GitDiffWithContentsSuccess> = {},
): GitDiffWithContentsSuccess {
  return {
    ok: true,
    patch: "diff --git ...",
    base: null,
    head: null,
    status: "M",
    size: 64,
    reason: "ok",
    original_content: "old contents\n",
    modified_content: "new contents\n",
    ...overrides,
  };
}

beforeEach(() => {
  tabStore.__resetForTests();
  diffState = { isLoading: true };
  lastQueryArgs = null;
});

describe("DiffTabContent", () => {
  it("renders the loading state while the query is in-flight", () => {
    diffState = { isLoading: true };
    render(<DiffTabContent tab={makeTab()} />);
    expect(screen.getByTestId("diff-tab-loading")).toBeInTheDocument();
  });

  it("renders an error state when the underlying fetch throws", () => {
    diffState = {
      isLoading: false,
      error: new Error("boom"),
    };
    render(<DiffTabContent tab={makeTab()} />);
    expect(screen.getByTestId("diff-tab-error")).toBeInTheDocument();
  });

  it("renders the structured-failure fallback with reason set", () => {
    diffState = {
      isLoading: false,
      data: {
        ok: false,
        reason: "not_a_repo",
        message: "Not a git repository.",
      },
    };
    render(<DiffTabContent tab={makeTab()} />);
    const node = screen.getByTestId("diff-tab-failure");
    expect(node).toHaveAttribute("data-reason", "not_a_repo");
  });

  it("renders the diff editor with both sides on ok:true", () => {
    diffState = {
      isLoading: false,
      data: makeOk({
        original_content: "v1\n",
        modified_content: "v2\n",
      }),
    };
    render(<DiffTabContent tab={makeTab()} />);
    const editor = screen.getByTestId("mock-code-editor");
    expect(editor).toHaveAttribute("data-original", "v1\n");
    expect(editor.textContent).toBe("v2\n");
    // Read-only by construction — no onChange plumbed through.
    expect(editor).toHaveAttribute("data-readonly", "true");
  });

  it("threads the (staged) mode through to the underlying hook", () => {
    diffState = { isLoading: false, data: makeOk() };
    render(<DiffTabContent tab={makeTab({ staged: true })} />);
    expect(lastQueryArgs?.mode).toEqual({ staged: true });
  });

  it("falls back to a too-large notice when either side is null", () => {
    diffState = {
      isLoading: false,
      data: makeOk({
        original_content: null,
        modified_content: "still here\n",
      }),
    };
    render(<DiffTabContent tab={makeTab()} />);
    expect(screen.getByTestId("diff-tab-too-large")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-code-editor")).not.toBeInTheDocument();
  });

  it("falls back to a binary notice when status='binary'", () => {
    diffState = {
      isLoading: false,
      data: makeOk({
        status: "binary",
        original_content: null,
        modified_content: null,
      }),
    };
    render(<DiffTabContent tab={makeTab({ path: "blob.bin" })} />);
    expect(screen.getByTestId("diff-tab-binary")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-code-editor")).not.toBeInTheDocument();
  });

  it("renders an unchanged notice when status='unchanged'", () => {
    diffState = {
      isLoading: false,
      data: makeOk({
        status: "unchanged",
        original_content: "same\n",
        modified_content: "same\n",
        patch: "",
        size: 0,
      }),
    };
    render(<DiffTabContent tab={makeTab()} />);
    expect(screen.getByTestId("diff-tab-unchanged")).toBeInTheDocument();
  });

  it("close button delegates to tabStore.closeTab", async () => {
    diffState = { isLoading: false, data: makeOk() };
    const tab = makeTab();
    // Pre-seed the store so we can assert the close removes it.
    tabStore.openTab(tab);
    render(<DiffTabContent tab={tab} />);
    const close = screen.getByTestId("diff-tab-close");
    await userEvent.click(close);
    await waitFor(() => {
      expect(tabStore.getState().tabs.find((t) => t.id === tab.id)).toBeUndefined();
    });
  });

  it("encodes the working-mode tab id and threads it through", () => {
    diffState = { isLoading: false, data: makeOk() };
    render(<DiffTabContent tab={makeTab()} />);
    const content = screen.getByTestId("diff-tab-content");
    expect(content).toHaveAttribute("data-mode", "working");
    expect(content).toHaveAttribute("data-open-path", "src/foo.ts");
  });
});

describe("tabStore.openDiff", () => {
  beforeEach(() => {
    tabStore.__resetForTests();
  });

  it("creates a diff tab with the canonical id and focuses it", () => {
    tabStore.openDiff("projects", "p1", "src/foo.ts", { staged: true });
    const state = tabStore.getState();
    expect(state.tabs.length).toBe(1);
    const tab = state.tabs[0];
    expect(tab?.kind).toBe("diff");
    expect(tab?.id).toBe(
      diffTabId("projects", "p1", "src/foo.ts", { staged: true }),
    );
    expect(state.activeId).toBe(tab?.id);
  });

  it("re-focuses an already-open diff tab without duplicating", () => {
    tabStore.openDiff("projects", "p1", "src/foo.ts", {});
    tabStore.openDiff("projects", "p1", "src/foo.ts", {});
    const state = tabStore.getState();
    expect(state.tabs.length).toBe(1);
  });

  it("keeps working / staged variants of the same path distinct", () => {
    tabStore.openDiff("projects", "p1", "src/foo.ts", {});
    tabStore.openDiff("projects", "p1", "src/foo.ts", { staged: true });
    expect(tabStore.getState().tabs.length).toBe(2);
  });
});
