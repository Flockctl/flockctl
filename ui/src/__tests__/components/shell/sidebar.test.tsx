/**
 * Sidebar — tests for the M22 slice-03 token refresh.
 *
 * The sidebar fans out to three child components (`RecentList`,
 * `BrowseNav`, `SidebarFooter`); each is exercised here through the
 * top-level `<Sidebar />` so the tests double as a parity contract
 * for the prototype lines 94–210.
 *
 * Hooks used by `BrowseNav` (`useAttention`, `useChatListLiveState`,
 * `useTasks`) and `SidebarFooter` (`fetchVersion`) are mocked at the
 * module boundary so the tests stay pure and fast — no fetch traffic,
 * no WebSocket plumbing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- Mocks (declared before the SUT import so vi.mock hoists correctly) ---

vi.mock("@/lib/hooks/attention", () => ({
  useAttention: () => ({
    items: [],
    total: 3,
    isLoading: false,
    error: null,
    connectionState: "open",
  }),
}));

vi.mock("@/lib/hooks/chat-list-live", () => ({
  useChatListLiveState: () => ({
    pendingCount: {},
    running: { "chat-1": true, "chat-2": true },
  }),
}));

vi.mock("@/lib/hooks/tasks", () => ({
  useTasks: () => ({
    data: {
      items: [
        { id: "t1", status: "running" },
        { id: "t2", status: "queued" },
      ],
      total: 2,
    },
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchVersion: vi.fn().mockResolvedValue({
      current: "0.0.4",
      latest: null,
      update_available: false,
      error: null,
      install_mode: "global",
    }),
  };
});

import { Sidebar } from "@/components/shell/Sidebar";
import { recentStore } from "@/lib/recent-store";

function mount({ initial = "/dashboard" }: { initial?: string } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Sidebar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  recentStore.__resetForTests();
});

describe("Sidebar — container shell", () => {
  it("uses the prototype's w-56 shrink-0 + flex-col + py-2 token shell", () => {
    const { container } = mount();
    const aside = container.querySelector("aside[data-slot='sidebar']");
    expect(aside).not.toBeNull();
    const cls = aside?.getAttribute("class") ?? "";
    expect(cls).toContain("w-56");
    expect(cls).toContain("shrink-0");
    expect(cls).toContain("flex-col");
    expect(cls).toContain("py-2");
    expect(cls).toContain("overflow-y-auto");
    expect(cls).toContain("border-r");
    expect(cls).toContain("divider-y");
  });
});

describe("Sidebar — Recent group", () => {
  it("hides the Recent header entirely when the store is empty", () => {
    const { container } = mount();
    expect(
      container.querySelector("[data-shell-slot='recent-list-header']"),
    ).toBeNull();
    // Negative test: sidebar.test.tsx::empty Recent shows zero rows.
    expect(container.querySelector("[data-shell-slot='recent-list']")).toBeNull();
  });

  it("renders pinned + recent rows with workspace-coloured swatch + ★ marker", () => {
    recentStore.track({
      kind: "project",
      id: "proj-my-app",
      label: "my-app",
      href: "/projects/proj-my-app",
    });
    recentStore.pin("proj-my-app", "project");
    recentStore.track({
      kind: "project",
      id: "proj-admin",
      label: "admin-panel",
      href: "/projects/proj-admin",
    });

    const { container } = mount({ initial: "/projects/proj-my-app" });

    const list = container.querySelector("[data-shell-slot='recent-list']");
    expect(list).not.toBeNull();
    const links = list!.querySelectorAll("a");
    expect(links.length).toBe(2);

    // Pinned row: solid coloured swatch + star.
    const pinned = within(links[0] as HTMLElement);
    expect(pinned.getByText("my-app")).toBeTruthy();
    expect(pinned.getByText("★")).toBeTruthy();
    const pinnedSwatch = (links[0] as HTMLElement).querySelector(
      "span[aria-hidden='true']",
    );
    expect(pinnedSwatch?.className).toMatch(/bg-(indigo|pink|amber|emerald|sky)-400/);
    expect(pinnedSwatch?.className).toContain("h-2");
    expect(pinnedSwatch?.className).toContain("w-2");
    expect(pinnedSwatch?.className).toContain("rounded-sm");

    // Pinned + active route → trailing LiveDot (state="live").
    const liveDot = (links[0] as HTMLElement).querySelector(
      "span[aria-label='active']",
    );
    expect(liveDot).not.toBeNull();
    expect(liveDot?.getAttribute("data-state")).toBe("live");

    // Unpinned, inactive row: dashed swatch, no star.
    const unpinned = within(links[1] as HTMLElement);
    expect(unpinned.getByText("admin-panel")).toBeTruthy();
    expect(unpinned.queryByText("★")).toBeNull();
    const unpinnedSwatch = (links[1] as HTMLElement).querySelector(
      "span[aria-hidden='true']",
    );
    expect(unpinnedSwatch?.className).toContain("border-dashed");
  });

  it("renders chat rows with the emerald chat-bubble glyph and a 'chat' kind label", () => {
    recentStore.track({
      kind: "chat",
      id: "chat-1",
      label: "refactor auth",
      href: "/chats/chat-1",
    });
    const { container } = mount();
    const list = container.querySelector("[data-shell-slot='recent-list']");
    expect(list).not.toBeNull();
    expect(list?.querySelector("svg")).not.toBeNull();
    expect(list?.textContent).toContain("refactor auth");
    expect(list?.textContent).toContain("chat");
  });

  it("scrolls without overflow when 50 recent projects are tracked", () => {
    // Negative test: sidebar.test.tsx::50 recent projects scroll without overflow.
    for (let i = 0; i < 50; i += 1) {
      recentStore.track({
        kind: "project",
        id: `p-${i}`,
        label: `project-${i}`,
        href: `/projects/p-${i}`,
      });
    }
    const { container } = mount();
    const aside = container.querySelector("aside[data-slot='sidebar']");
    expect(aside?.className).toContain("overflow-y-auto");
    // Cap is 5 non-pinned rows (RECENT_MAX). The list MUST stay
    // bounded even when the store sees 50 writes.
    const list = container.querySelector("[data-shell-slot='recent-list']");
    expect(list).not.toBeNull();
    const links = list!.querySelectorAll("a");
    expect(links.length).toBeLessThanOrEqual(5);
  });
});

describe("Sidebar — Browse group", () => {
  it("renders Dashboard / Workspaces / Projects / Chats / Tasks / Schedules / Attention in order", () => {
    // Missions row is intentionally absent until the /missions list page +
    // GET /missions endpoint land — see BrowseNav.tsx and TODO.md
    // ("Missions list page (/missions)"). Restore between Tasks and
    // Schedules when the list page ships.
    const { container } = mount();
    const nav = container.querySelector("[data-shell-slot='browse-nav']");
    expect(nav).not.toBeNull();
    const labels = Array.from(nav!.querySelectorAll("a"))
      .slice(0, 7)
      .map(a => a.textContent?.replace(/\d.*$/, "").trim() || "")
      .map(s => s.replace(/\s+(live|task running|item.*)$/, "").trim());
    expect(labels).toEqual([
      "Dashboard",
      "Workspaces",
      "Projects",
      "Chats",
      "Tasks",
      "Schedules",
      "Attention",
    ]);
  });

  it("each Browse row has a 15×15 stroke-1.8 SVG icon", () => {
    const { container } = mount();
    const nav = container.querySelector("[data-shell-slot='browse-nav']");
    const links = Array.from(nav!.querySelectorAll("a")).slice(0, 7);
    for (const link of links) {
      const svg = link.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("width")).toBe("15");
      expect(svg?.getAttribute("height")).toBe("15");
      expect(svg?.getAttribute("stroke-width")).toBe("1.8");
    }
  });

  it("Chats row renders a '{n} live' StatusPill in success tone when chats are streaming", () => {
    const { container } = mount();
    const link = container.querySelector("a[data-nav='chats']") as HTMLElement | null;
    expect(link).not.toBeNull();
    const pill = link!.querySelector("[data-tone='success']");
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe("2 live");
  });

  it("Tasks row renders a LiveDot when any task is in 'running' status", () => {
    const { container } = mount();
    const link = container.querySelector("a[data-nav='tasks']") as HTMLElement | null;
    expect(link).not.toBeNull();
    const dot = link!.querySelector("span[data-state='live']");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("data-size")).toBe("xs");
  });

  it("Attention row renders an amber-500 count badge when there are pending items", () => {
    const { container } = mount();
    const link = container.querySelector("a[data-nav='attention']") as HTMLElement | null;
    expect(link).not.toBeNull();
    const badge = link!.querySelector("span[aria-label*='attention']");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("3");
    expect(badge?.getAttribute("class") ?? "").toContain("bg-amber-500");
    expect(badge?.getAttribute("class") ?? "").toContain("rounded-full");
  });

  it("does NOT render the Chats live-pill when zero chats are streaming", async () => {
    // Re-mount with a zero-running override so the negative branch is covered.
    const liveMod = await import("@/lib/hooks/chat-list-live");
    const orig = liveMod.useChatListLiveState;
    (liveMod as { useChatListLiveState: typeof orig }).useChatListLiveState = () => ({
      pendingCount: {},
      running: {},
    });
    try {
      const { container } = mount();
      const link = container.querySelector("a[data-nav='chats']") as HTMLElement | null;
      expect(link?.querySelector("[data-tone='success']")).toBeNull();
    } finally {
      (liveMod as { useChatListLiveState: typeof orig }).useChatListLiveState = orig;
    }
  });
});

describe("Sidebar — Library group", () => {
  it("renders Templates / Skills & MCP / Analytics / Incidents in order", () => {
    const { container } = mount();
    const nav = container.querySelector("[data-shell-slot='browse-nav']");
    expect(nav).not.toBeNull();
    // Browse group is 7 rows while Missions is hidden (see TODO.md
     // "Missions list page (/missions)"); bump back to 8 once it lands.
    const links = Array.from(nav!.querySelectorAll("a")).slice(7);
    const labels = links.map(a => a.textContent?.trim() ?? "");
    expect(labels).toEqual(["Templates", "Skills & MCP", "Analytics", "Incidents"]);
  });
});

describe("Sidebar — Footer", () => {
  it("renders a Settings link + a muted daemon version line (no user pill)", async () => {
    const { container, findByText } = mount();
    const footer = container.querySelector("[data-shell-slot='sidebar-footer']");
    expect(footer).not.toBeNull();

    // Settings link.
    const settings = footer!.querySelector("a[data-nav='settings']");
    expect(settings).not.toBeNull();
    expect(settings?.textContent).toContain("Settings");
    const ic = settings?.querySelector("svg");
    expect(ic?.getAttribute("width")).toBe("15");
    expect(ic?.getAttribute("stroke-width")).toBe("1.8");

    // The legacy user pill (avatar + username) was removed. Verify it
    // doesn't sneak back in — no `[data-shell-slot='user-pill']`,
    // no gradient avatar.
    expect(footer!.querySelector("[data-shell-slot='user-pill']")).toBeNull();
    expect(footer!.querySelector("div.bg-gradient-to-br")).toBeNull();

    // What remains is a small muted version line resolving from the
    // mocked fetchVersion (0.0.4).
    const versionLine = footer!.querySelector(
      "[data-shell-slot='version-line']",
    );
    expect(versionLine).not.toBeNull();
    expect(await findByText("v0.0.4")).toBeTruthy();
  });
});
