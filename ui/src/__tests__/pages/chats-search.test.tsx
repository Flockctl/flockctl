import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";

import {
  ChatsToolbar,
  filterChatsByQuery,
  type ChatsGroupMode,
} from "@/pages/chats-components/ChatsToolbar";
import { EmptyState } from "@/components/EmptyState";
import { MessageSquare } from "lucide-react";

/**
 * Contract tests for the search-input + group-toggle portion of
 * {@link ChatsToolbar} (slice 24-02 T02).
 *
 * Each spec covers exactly one promise from the slice:
 *
 *   - Native `<input>` for search (not the shadcn Input component).
 *   - 200 ms debounce before commit (no URL update mid-burst).
 *   - URL `?q=` is the source of truth (replace-not-push).
 *   - Filter by title, last-message excerpt, project name, workspace
 *     name — case-insensitive substring match.
 *   - Empty result triggers the page-level empty-state with the
 *     `+ New chat` CTA.
 *   - URL pre-population works when landing with `?q=foo` or `?group=project`.
 *   - SegmentToggle round-trips `?group=list|project` and clears `?group=`
 *     when set back to the default `list`.
 *
 * Negative tests (per task spec):
 *   - search.test.tsx::?q=zzz → empty-state with 'New chat' CTA.
 */

// --- Router probe ------------------------------------------------------------
type Probe = { pathname: string; search: string };
function LocationProbe({ onLocation }: { onLocation: (loc: Probe) => void }) {
  const location = useLocation();
  useEffect(() => {
    onLocation({ pathname: location.pathname, search: location.search });
  });
  return null;
}

function renderWithRouter(initial: string, ui: ReactNode) {
  const probe: { current: Probe } = {
    current: { pathname: "", search: "" },
  };
  render(
    <MemoryRouter initialEntries={[initial]}>
      {ui}
      <LocationProbe onLocation={(p) => (probe.current = p)} />
    </MemoryRouter>,
  );
  return probe;
}

// --- Empty-state harness -----------------------------------------------------
// The toolbar is intentionally just a controlled input + toggle — it doesn't
// render the chat list itself. The page composes both. To exercise the
// end-to-end "type something nobody matches → empty-state with CTA" promise we
// render a tiny Harness that listens to onSearchChange and applies the same
// filter helper the page will.

interface TestChat {
  id: string;
  title: string;
  last_message_excerpt: string;
  project_name?: string;
  workspace_name?: string;
}

function ChatsHarness({
  rows,
  onNewChat,
}: {
  rows: TestChat[];
  onNewChat?: () => void;
}) {
  const [q, setQ] = useState<string>("");
  const filtered = filterChatsByQuery(rows, q);
  return (
    <>
      <ChatsToolbar
        onSearchChange={setQ}
        onNewChat={onNewChat}
      />
      {filtered.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No chats match your search"
          description="Try a different title or message excerpt."
          action={
            <button
              type="button"
              onClick={onNewChat}
              data-testid="empty-cta-new-chat"
            >
              + New chat
            </button>
          }
        />
      ) : (
        <ul data-testid="harness-results">
          {filtered.map((c) => (
            <li key={c.id}>{c.title}</li>
          ))}
        </ul>
      )}
    </>
  );
}

const SAMPLE_ROWS: TestChat[] = [
  {
    id: "c1",
    title: "Refactor the planner",
    last_message_excerpt: "Let's split out the milestone view.",
    project_name: "flockctl",
  },
  {
    id: "c2",
    title: "Marketing site copy",
    last_message_excerpt: "Tighten the headline.",
    project_name: "marketing-site",
  },
  {
    id: "c3",
    title: "Docs revamp",
    last_message_excerpt: "Move conceptual docs above the API ref.",
    workspace_name: "personal",
  },
];

describe("ChatsToolbar — search input", () => {
  beforeEach(() => {
    // Real timers by default so userEvent debounces work; specific tests opt
    // into fake timers when they need to inspect the debounce window.
  });

  afterEach(() => {
    // Reset to real timers between tests so leakage doesn't cascade.
    vi.useRealTimers();
  });

  it("renders a native searchbox with the prototype classes", () => {
    renderWithRouter("/chats", <ChatsToolbar />);
    const input = screen.getByRole("searchbox", { name: /search chats/i });
    for (const cls of [
      "px-3",
      "py-1.5",
      "bg-white",
      "dark:bg-zinc-900",
      "border",
      "border-zinc-200",
      "dark:border-zinc-700",
      "rounded",
      "text-[12.5px]",
      "outline-none",
      "focus:border-indigo-500",
      "w-56",
    ]) {
      expect(input.className).toContain(cls);
    }
    expect(input).toHaveAttribute("placeholder", "Search chats…");
  });

  it("pre-populates the input when ?q= is in the URL", () => {
    renderWithRouter("/chats?q=plan", <ChatsToolbar />);
    const input = screen.getByRole("searchbox", {
      name: /search chats/i,
    }) as HTMLInputElement;
    expect(input.value).toBe("plan");
  });

  it("debounces URL commits by 200ms (no commit before the timer fires)", async () => {
    vi.useFakeTimers();

    const probe = renderWithRouter("/chats", <ChatsToolbar />);
    const input = screen.getByRole("searchbox", {
      name: /search chats/i,
    }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "foo" } });

    // Mid-burst: input value reflects typing, but URL hasn't committed yet.
    expect(input.value).toBe("foo");
    expect(probe.current.search).toBe("");

    // Just under the debounce window — still no commit.
    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(probe.current.search).toBe("");

    // Cross the threshold — URL should now have ?q=foo.
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    expect(probe.current.search).toContain("q=foo");
  });

  it("commits to URL ?q= and emits onSearchChange (replace-not-push, preserves other params)", async () => {
    vi.useFakeTimers();

    const onSearchChange = vi.fn();
    const probe = renderWithRouter(
      "/chats?filter=work",
      <ChatsToolbar onSearchChange={onSearchChange} />,
    );
    const input = screen.getByRole("searchbox", {
      name: /search chats/i,
    });

    fireEvent.change(input, { target: { value: "site" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(probe.current.pathname).toBe("/chats");
    expect(probe.current.search).toContain("q=site");
    // Unrelated params survive the commit.
    expect(probe.current.search).toContain("filter=work");
    expect(onSearchChange).toHaveBeenCalledWith("site");
  });

  it("clearing the input removes the ?q= param entirely (no empty ?q=)", async () => {
    vi.useFakeTimers();

    const probe = renderWithRouter("/chats?q=foo", <ChatsToolbar />);
    const input = screen.getByRole("searchbox", {
      name: /search chats/i,
    }) as HTMLInputElement;
    expect(input.value).toBe("foo");

    fireEvent.change(input, { target: { value: "" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    // Empty drafts wipe the param outright — landing back at a clean URL.
    expect(probe.current.search).not.toContain("q=");
  });

  it("filterChatsByQuery matches title / excerpt / project / workspace, case-insensitively", () => {
    const rows = SAMPLE_ROWS;
    // Title hit
    expect(filterChatsByQuery(rows, "REFACTOR").map((r) => r.id)).toEqual([
      "c1",
    ]);
    // Excerpt hit
    expect(filterChatsByQuery(rows, "headline").map((r) => r.id)).toEqual([
      "c2",
    ]);
    // Project name hit
    expect(filterChatsByQuery(rows, "flockctl").map((r) => r.id)).toEqual([
      "c1",
    ]);
    // Workspace name hit
    expect(filterChatsByQuery(rows, "personal").map((r) => r.id)).toEqual([
      "c3",
    ]);
    // Empty query returns all rows in original order.
    expect(filterChatsByQuery(rows, "").map((r) => r.id)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    // Whitespace-only query also returns all rows.
    expect(filterChatsByQuery(rows, "   ").map((r) => r.id)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
  });

  // Negative test (per task spec): empty result shows empty-state with CTA.
  it("?q=zzz → empty-state with 'New chat' CTA", async () => {
    vi.useFakeTimers();

    const onNewChat = vi.fn();
    renderWithRouter(
      "/chats",
      <ChatsHarness rows={SAMPLE_ROWS} onNewChat={onNewChat} />,
    );

    // Sanity: harness lists all rows up front.
    expect(screen.getByTestId("harness-results")).toBeInTheDocument();

    const input = screen.getByRole("searchbox", { name: /search chats/i });
    fireEvent.change(input, { target: { value: "zzz-no-match-xyzzy" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    // Empty-state replaces the result list.
    expect(screen.queryByTestId("harness-results")).not.toBeInTheDocument();
    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    expect(
      screen.getByText(/No chats match your search/i),
    ).toBeInTheDocument();

    // CTA in the empty state forwards to the new-chat handler.
    vi.useRealTimers();
    const user = userEvent.setup();
    const cta = screen.getByTestId("empty-cta-new-chat");
    await user.click(cta);
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });
});

describe("ChatsToolbar — group toggle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to 'list' when ?group= is absent", () => {
    renderWithRouter("/chats", <ChatsToolbar />);
    const toggle = screen.getByTestId("chats-group-toggle");
    const listBtn = toggle.querySelector('[data-value="list"]') as HTMLElement;
    const projectBtn = toggle.querySelector(
      '[data-value="project"]',
    ) as HTMLElement;
    expect(listBtn).toHaveAttribute("aria-checked", "true");
    expect(projectBtn).toHaveAttribute("aria-checked", "false");
  });

  it("pre-selects 'project' when ?group=project is in the URL", () => {
    renderWithRouter("/chats?group=project", <ChatsToolbar />);
    const toggle = screen.getByTestId("chats-group-toggle");
    const projectBtn = toggle.querySelector(
      '[data-value="project"]',
    ) as HTMLElement;
    expect(projectBtn).toHaveAttribute("aria-checked", "true");
  });

  it("falls back to 'list' for unknown ?group= values", () => {
    renderWithRouter("/chats?group=garbage", <ChatsToolbar />);
    const toggle = screen.getByTestId("chats-group-toggle");
    const listBtn = toggle.querySelector('[data-value="list"]') as HTMLElement;
    expect(listBtn).toHaveAttribute("aria-checked", "true");
  });

  it("clicking 'By project' commits ?group=project and emits onGroupChange", async () => {
    const onGroupChange = vi.fn<(group: ChatsGroupMode) => void>();
    const probe = renderWithRouter(
      "/chats",
      <ChatsToolbar onGroupChange={onGroupChange} />,
    );

    const user = userEvent.setup();
    const toggle = screen.getByTestId("chats-group-toggle");
    const projectBtn = toggle.querySelector(
      '[data-value="project"]',
    ) as HTMLElement;

    await user.click(projectBtn);

    expect(probe.current.search).toContain("group=project");
    expect(onGroupChange).toHaveBeenCalledWith("project");
  });

  it("toggling back to 'list' clears the ?group= param entirely", async () => {
    const probe = renderWithRouter("/chats?group=project", <ChatsToolbar />);

    const user = userEvent.setup();
    const toggle = screen.getByTestId("chats-group-toggle");
    const listBtn = toggle.querySelector('[data-value="list"]') as HTMLElement;

    await user.click(listBtn);

    // Default mode renders as a clean URL — no ?group=list noise.
    expect(probe.current.search).not.toContain("group=");
  });

  it("group toggle preserves an existing ?q= param", async () => {
    const probe = renderWithRouter("/chats?q=plan", <ChatsToolbar />);

    const user = userEvent.setup();
    const toggle = screen.getByTestId("chats-group-toggle");
    const projectBtn = toggle.querySelector(
      '[data-value="project"]',
    ) as HTMLElement;

    await user.click(projectBtn);

    expect(probe.current.search).toContain("q=plan");
    expect(probe.current.search).toContain("group=project");
  });
});

describe("ChatsToolbar — + New chat button", () => {
  it("renders a primary + New chat button (unified Button component) and forwards the click", async () => {
    const onNewChat = vi.fn();
    renderWithRouter("/chats", <ChatsToolbar onNewChat={onNewChat} />);

    const btn = screen.getByTestId("chats-new-chat-button");
    // Unified label: <Plus /> icon + "New chat" text. The literal "+ "
    // prefix has been retired in favour of the lucide-react Plus icon
    // so the affordance matches every other "New X" button site-wide.
    expect(btn).toHaveTextContent("New chat");
    expect(btn.querySelector("svg")).toBeTruthy();
    // Unified Button component: default variant resolves to bg-primary
    // (the same indigo via CSS variable) and primary-foreground text.
    // We assert on the Button data-slot + data-variant attributes so
    // tests track the canonical button API rather than utility-class
    // strings that change when the variant recipe is tuned.
    expect(btn.getAttribute("data-slot")).toBe("button");
    expect(btn.getAttribute("data-variant")).toBe("default");
    expect(btn.getAttribute("data-size")).toBe("sm");

    const user = userEvent.setup();
    await user.click(btn);
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });
});
