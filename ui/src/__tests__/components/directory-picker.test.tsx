import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DirectoryPicker } from "@/components/DirectoryPicker";

// jsdom doesn't implement ResizeObserver (Radix ScrollArea) or
// Element.prototype.scrollIntoView (picker auto-scroll effect). No-op stubs
// keep the real render path intact without gating the tests on unrelated
// browser APIs.
if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof (Element.prototype as any).scrollIntoView !== "function") {
  (Element.prototype as any).scrollIntoView = function () {};
}

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
    // Match on pathname (strip query string) — lets tests assert against a
    // base path while still letting the picker build its own query.
    const withQs = url;
    if (withQs in routes) return jsonResponse(routes[withQs]);
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

describe("DirectoryPicker", () => {
  it("renders directory entries returned by /fs/browse", async () => {
    const { mock } = makeRouter({
      "/fs/browse": {
        path: "/Users/me",
        parent: null,
        entries: [
          { name: "Projects", isDirectory: true, isSymlink: false, isHidden: false },
          { name: "Notes", isDirectory: true, isSymlink: false, isHidden: false },
          { name: "readme.md", isDirectory: false, isSymlink: false, isHidden: false },
        ],
        truncated: false,
      },
    });
    (globalThis as any).fetch = mock;

    renderPicker({});

    await waitFor(() => {
      expect(screen.getByText("Projects")).toBeInTheDocument();
      expect(screen.getByText("Notes")).toBeInTheDocument();
    });
    // Files shown greyed in a separate block — they still appear in the DOM,
    // but they must NOT appear in the interactive entry list (buttons).
    const readme = screen.getByText("readme.md");
    expect(readme.closest("button")).toBeNull();
  });

  it("passes initialPath as ?path= on the first fetch", async () => {
    const { mock, calls } = makeRouter({
      "/fs/browse": {
        path: "/Users/me/Projects",
        parent: "/Users/me",
        entries: [],
        truncated: false,
      },
    });
    (globalThis as any).fetch = mock;

    renderPicker({ initialPath: "/Users/me/Projects" });

    await waitFor(() => {
      const firstCall = calls.find((c) => c.url.includes("/fs/browse"));
      expect(firstCall).toBeDefined();
      expect(firstCall!.url).toContain(
        `path=${encodeURIComponent("/Users/me/Projects")}`,
      );
    });
  });

  it("clicking Select invokes onSelect with the server-canonical path", async () => {
    const { mock } = makeRouter({
      "/fs/browse": {
        path: "/private/var/Users/me",
        parent: null,
        entries: [],
        truncated: false,
      },
    });
    (globalThis as any).fetch = mock;

    const { onSelect, onOpenChange } = renderPicker({
      initialPath: "/var/Users/me",
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Select" })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(onSelect).toHaveBeenCalledWith("/private/var/Users/me");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Cancel closes the dialog without calling onSelect", async () => {
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
    await waitFor(() => expect(screen.getByText("Select a directory")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Enter on a highlighted directory navigates into it (second /fs/browse call)", async () => {
    let callCount = 0;
    const routes: Record<string, unknown> = {
      "/fs/browse": {
        path: "/Users/me",
        parent: null,
        entries: [
          { name: "Projects", isDirectory: true, isSymlink: false, isHidden: false },
        ],
        truncated: false,
      },
    };
    const mock = vi.fn(async (url: string) => {
      callCount += 1;
      if (url.includes("path=")) {
        return jsonResponse({
          path: "/Users/me/Projects",
          parent: "/Users/me",
          entries: [
            { name: "swarmctl", isDirectory: true, isSymlink: false, isHidden: false },
          ],
          truncated: false,
        });
      }
      return jsonResponse(routes["/fs/browse"]);
    });
    (globalThis as any).fetch = mock;

    renderPicker({});

    await waitFor(() => expect(screen.getByText("Projects")).toBeInTheDocument());
    // Picker now starts with no entry highlighted (so "Select" returns the
    // current directory by default). Highlight the first entry via ArrowDown,
    // then Enter descends into it.
    await act(async () => {
      await userEvent.keyboard("{ArrowDown}{Enter}");
    });

    await waitFor(() => expect(screen.getByText("swarmctl")).toBeInTheDocument());
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("filter input narrows the visible list client-side", async () => {
    const { mock } = makeRouter({
      "/fs/browse": {
        path: "/Users/me",
        parent: null,
        entries: [
          { name: "Projects", isDirectory: true, isSymlink: false, isHidden: false },
          { name: "Photos", isDirectory: true, isSymlink: false, isHidden: false },
          { name: "Music", isDirectory: true, isSymlink: false, isHidden: false },
        ],
        truncated: false,
      },
    });
    (globalThis as any).fetch = mock;

    renderPicker({});
    await waitFor(() => expect(screen.getByText("Music")).toBeInTheDocument());

    const filter = screen.getByPlaceholderText("Filter…");
    await userEvent.type(filter, "pho");

    await waitFor(() => {
      expect(screen.queryByText("Music")).toBeNull();
      expect(screen.queryByText("Projects")).toBeNull();
      expect(screen.getByText("Photos")).toBeInTheDocument();
    });
  });

  it("shows a truncation hint when the server reports truncated: true", async () => {
    const { mock } = makeRouter({
      "/fs/browse": {
        path: "/Users/me/big",
        parent: "/Users/me",
        entries: [
          { name: "a", isDirectory: true, isSymlink: false, isHidden: false },
        ],
        truncated: true,
      },
    });
    (globalThis as any).fetch = mock;

    renderPicker({ initialPath: "/Users/me/big" });

    await waitFor(() =>
      expect(screen.getByText(/type to filter/i)).toBeInTheDocument(),
    );
  });

  it("hidden-files toggle triggers a refetch with show_hidden=1", async () => {
    const { mock, calls } = makeRouter({
      "/fs/browse": {
        path: "/Users/me",
        parent: null,
        entries: [],
        truncated: false,
      },
    });
    (globalThis as any).fetch = mock;

    renderPicker({});
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1));

    const toggle = screen.getByLabelText("Show hidden files");
    await userEvent.click(toggle);

    await waitFor(() => {
      const withHidden = calls.find((c) => c.url.includes("show_hidden=1"));
      expect(withHidden).toBeDefined();
    });
  });

  it("Backspace goes up one level when the filter input is empty", async () => {
    const routes: Record<string, unknown> = {};
    const mock = vi.fn(async (url: string) => {
      if (url.includes(encodeURIComponent("/Users/me/child"))) {
        return jsonResponse({
          path: "/Users/me/child",
          parent: "/Users/me",
          entries: [],
          truncated: false,
        });
      }
      if (url.includes(encodeURIComponent("/Users/me"))) {
        return jsonResponse({
          path: "/Users/me",
          parent: null,
          entries: [
            { name: "sibling", isDirectory: true, isSymlink: false, isHidden: false },
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

    renderPicker({ initialPath: "/Users/me/child" });
    await waitFor(() =>
      expect(
        screen.getByTestId("directory-picker-breadcrumb").textContent,
      ).toContain("child"),
    );

    await act(async () => {
      await userEvent.keyboard("{Backspace}");
    });

    await waitFor(() => expect(screen.getByText("sibling")).toBeInTheDocument());
    expect(routes).toBeDefined(); // keep linter happy
  });
});
