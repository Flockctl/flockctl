import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DirectoryPicker } from "@/components/DirectoryPicker";

// jsdom doesn't ship with ResizeObserver — Radix's ScrollArea reaches for it
// in a layout effect, which crashes the render the second time the picker
// re-mounts the list after navigation. A no-op stub is enough for these
// tests (they never measure the scroll viewport).
if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom also omits Element.prototype.scrollIntoView. The picker's auto-scroll
// effect calls it whenever the highlighted entry changes — harmless in a
// real browser, a hard `TypeError` here without the stub.
if (typeof (Element.prototype as any).scrollIntoView !== "function") {
  (Element.prototype as any).scrollIntoView = function () {};
}

// Matches the helper style used by the other tests in `ui/src/__tests__/`
// (see components/directory-picker.test.tsx and hooks/use-attention.test.tsx):
// a thin `jsonResponse` wrapper around `Response`, plus a small router that
// dispatches on pathname so tests can assert against a base path while the
// picker builds its own query string.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeRouter(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (url in routes) return jsonResponse(routes[url]);
    const base = url.split("?")[0]!;
    if (base in routes) return jsonResponse(routes[base]);
    throw new Error(`unmocked fetch: ${method} ${url}`);
  });
  return { mock, calls };
}

function renderPicker(overrides: {
  initialPath?: string;
  onSelect?: (p: string) => void;
}) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const onSelect = overrides.onSelect ?? vi.fn();
  const onOpenChange = vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <DirectoryPicker
        open={true}
        onOpenChange={onOpenChange}
        initialPath={overrides.initialPath}
        onSelect={onSelect}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onSelect, onOpenChange };
}

beforeEach(() => {
  (globalThis as any).fetch = vi.fn();
});

describe("DirectoryPicker component", () => {
  it("initial render shows $HOME entries", async () => {
    const { mock } = makeRouter({
      "/fs/browse": {
        path: "/Users/me",
        parent: null,
        entries: [
          { name: "Projects", isDirectory: true, isSymlink: false, isHidden: false },
          { name: "Documents", isDirectory: true, isSymlink: false, isHidden: false },
          { name: "Downloads", isDirectory: true, isSymlink: false, isHidden: false },
        ],
        truncated: false,
      },
    });
    (globalThis as any).fetch = mock;

    renderPicker({});

    await waitFor(() => {
      expect(screen.getByText("Projects")).toBeInTheDocument();
      expect(screen.getByText("Documents")).toBeInTheDocument();
      expect(screen.getByText("Downloads")).toBeInTheDocument();
    });
  });

  it("clicking a directory drills in (fires a second /fs/browse call)", async () => {
    const mock = vi.fn(async (url: string) => {
      if (url.includes("path=")) {
        return jsonResponse({
          path: "/Users/me/Projects",
          parent: "/Users/me",
          entries: [
            { name: "flockctl", isDirectory: true, isSymlink: false, isHidden: false },
          ],
          truncated: false,
        });
      }
      return jsonResponse({
        path: "/Users/me",
        parent: null,
        entries: [
          { name: "Projects", isDirectory: true, isSymlink: false, isHidden: false },
        ],
        truncated: false,
      });
    });
    (globalThis as any).fetch = mock;

    renderPicker({});

    await waitFor(() => expect(screen.getByText("Projects")).toBeInTheDocument());
    // Double-click drills into the directory — single click just highlights.
    await userEvent.dblClick(screen.getByText("Projects"));

    await waitFor(() =>
      expect(screen.getByText("flockctl")).toBeInTheDocument(),
    );
  });

  it("clicking a breadcrumb segment navigates up", async () => {
    const mock = vi.fn(async (url: string) => {
      // Server returns the canonical path matching whatever ?path= was asked
      // for — the picker hands that string back on the next fetch.
      if (url.includes(encodeURIComponent("/Users/me/Projects/flockctl"))) {
        return jsonResponse({
          path: "/Users/me/Projects/flockctl",
          parent: "/Users/me/Projects",
          entries: [
            { name: "src", isDirectory: true, isSymlink: false, isHidden: false },
          ],
          truncated: false,
        });
      }
      if (url.includes(encodeURIComponent("/Users/me/Projects"))) {
        return jsonResponse({
          path: "/Users/me/Projects",
          parent: "/Users/me",
          entries: [
            { name: "flockctl", isDirectory: true, isSymlink: false, isHidden: false },
            { name: "other", isDirectory: true, isSymlink: false, isHidden: false },
          ],
          truncated: false,
        });
      }
      return jsonResponse({
        path: "/Users/me",
        parent: null,
        entries: [],
        truncated: false,
      });
    });
    (globalThis as any).fetch = mock;

    renderPicker({ initialPath: "/Users/me/Projects/flockctl" });

    // Wait for the initial render to settle on the deepest path.
    await waitFor(() =>
      expect(screen.getByText("src")).toBeInTheDocument(),
    );

    // The breadcrumb renders one button per segment. The last segment is
    // disabled (we're already there), so clicking the "Projects" segment
    // navigates up one level.
    const crumb = screen.getByTestId("directory-picker-breadcrumb");
    const segment = Array.from(crumb.querySelectorAll("button")).find(
      (b) => b.textContent === "Projects" && !b.hasAttribute("disabled"),
    );
    expect(segment).toBeDefined();
    await userEvent.click(segment!);

    await waitFor(() => {
      expect(screen.getByText("flockctl")).toBeInTheDocument();
      expect(screen.getByText("other")).toBeInTheDocument();
    });
  });

  it("Select button fires onSelect with the current path when nothing is highlighted", async () => {
    const { mock } = makeRouter({
      "/fs/browse": {
        path: "/Users/me/Projects",
        parent: "/Users/me",
        entries: [],
        truncated: false,
      },
    });
    (globalThis as any).fetch = mock;

    const { onSelect, onOpenChange } = renderPicker({
      initialPath: "/Users/me/Projects",
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Select" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Select" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("/Users/me/Projects");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Select returns the highlighted entry's absolute path (single-click → Select)", async () => {
    // This is the regression we're locking in: previously Select always
    // returned resolvedPath, so clicking an entry in the list and hitting
    // Select handed the *parent* directory back to the caller. Now a
    // highlighted entry becomes the selection target.
    const { mock } = makeRouter({
      "/fs/browse": {
        path: "/Users/me/regular_work",
        parent: "/Users/me",
        entries: [
          { name: "autopatch-tool", isDirectory: true, isSymlink: false, isHidden: false },
          { name: "other-repo", isDirectory: true, isSymlink: false, isHidden: false },
        ],
        truncated: false,
      },
    });
    (globalThis as any).fetch = mock;

    const { onSelect, onOpenChange } = renderPicker({
      initialPath: "/Users/me/regular_work",
    });

    await waitFor(() =>
      expect(screen.getByText("autopatch-tool")).toBeInTheDocument(),
    );

    // Single click just highlights (does NOT descend — that's dblClick).
    await userEvent.click(screen.getByText("autopatch-tool"));
    await userEvent.click(screen.getByRole("button", { name: "Select" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      "/Users/me/regular_work/autopatch-tool",
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("footer preview shows the exact path Select will return", async () => {
    const { mock } = makeRouter({
      "/fs/browse": {
        path: "/Users/me/regular_work",
        parent: "/Users/me",
        entries: [
          { name: "autopatch-tool", isDirectory: true, isSymlink: false, isHidden: false },
          { name: "other-repo", isDirectory: true, isSymlink: false, isHidden: false },
        ],
        truncated: false,
      },
    });
    (globalThis as any).fetch = mock;

    renderPicker({ initialPath: "/Users/me/regular_work" });

    await waitFor(() =>
      expect(screen.getByText("autopatch-tool")).toBeInTheDocument(),
    );

    // Nothing highlighted yet → preview shows current directory.
    const preview = screen.getByTestId("directory-picker-picked");
    expect(preview.textContent).toContain("/Users/me/regular_work");
    expect(preview.textContent).not.toContain("autopatch-tool");

    // After single click → preview updates to the highlighted child path.
    await userEvent.click(screen.getByText("autopatch-tool"));
    await waitFor(() => {
      const after = screen.getByTestId("directory-picker-picked");
      expect(after.textContent).toContain(
        "/Users/me/regular_work/autopatch-tool",
      );
    });
  });

  it("Cancel closes without calling onSelect", async () => {
    const { mock } = makeRouter({
      "/fs/browse": {
        path: "/Users/me",
        parent: null,
        entries: [],
        truncated: false,
      },
    });
    (globalThis as any).fetch = mock;

    const { onSelect, onOpenChange } = renderPicker({});
    await waitFor(() =>
      expect(screen.getByText("Select a directory")).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("truncated flag renders the filter affordance", async () => {
    const { mock } = makeRouter({
      "/fs/browse": {
        path: "/Users/me/big",
        parent: "/Users/me",
        entries: [
          { name: "one", isDirectory: true, isSymlink: false, isHidden: false },
          { name: "two", isDirectory: true, isSymlink: false, isHidden: false },
        ],
        truncated: true,
      },
    });
    (globalThis as any).fetch = mock;

    renderPicker({ initialPath: "/Users/me/big" });

    // The truncation hint points the user at the filter input — assert both
    // the hint text and that the filter affordance is present.
    await waitFor(() =>
      expect(screen.getByText(/type to filter/i)).toBeInTheDocument(),
    );
    expect(screen.getByPlaceholderText("Filter…")).toBeInTheDocument();
  });

  it("403 response shows the inline error banner", async () => {
    const mock = vi.fn(async (_url: string) =>
      new Response(JSON.stringify({ error: "path escapes $HOME" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );
    (globalThis as any).fetch = mock;

    renderPicker({ initialPath: "/etc" });

    await waitFor(() =>
      expect(screen.getByText(/path escapes \$HOME/i)).toBeInTheDocument(),
    );
    // While the error is on screen, Select must be disabled — we have no
    // canonical path to hand back.
    expect(screen.getByRole("button", { name: "Select" })).toBeDisabled();
  });
});
