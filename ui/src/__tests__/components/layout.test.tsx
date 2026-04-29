import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { __resetSidebarCollapseStoreForTests } from "@/lib/sidebar-collapse-store";
import { __resetSidebarRailStoreForTests } from "@/lib/sidebar-rail-store";

// --- Mock the heavier dependencies so the test stays focused on the accordion
// behaviour of the sidebar itself. Each mock returns a minimal placeholder. ---

vi.mock("@/components/server-switcher", () => ({
  ServerSwitcher: () => <div data-testid="server-switcher" />,
}));

vi.mock("@/components/sidebar-footer", () => ({
  SidebarFooter: () => <div data-testid="sidebar-footer" />,
}));

vi.mock("@/components/connection-banner", () => ({
  ConnectionBanner: () => null,
}));

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));

const attentionMock = { total: 0 };
vi.mock("@/lib/hooks", () => ({
  useAttention: () => ({ total: attentionMock.total }),
}));

// AttentionNotificationsRunner is mounted inside <Layout /> at runtime —
// it pulls `useAttention` directly (relative path, bypassing the mock
// above) and `useNotificationDispatcher` from a context that this test
// doesn't provide. Replace the runner with a no-op so the sidebar
// accordion suite doesn't have to set up QueryClient + dispatcher
// plumbing it doesn't care about.
vi.mock("@/lib/hooks/use-attention-notifications", () => ({
  AttentionNotificationsRunner: () => null,
}));

// Same rationale as the attention runner mock: the task-terminal runner
// opens a global WebSocket and pulls a NotificationDispatcher from
// context. The sidebar test doesn't care about either; stub it out.
vi.mock("@/lib/hooks/use-task-terminal-notifications", () => ({
  TaskTerminalNotificationsRunner: () => null,
}));

// Same rationale: the chat-reply runner mounts a global WS subscription
// and reads the dispatcher context. Stub it for the sidebar suite.
vi.mock("@/lib/hooks/use-chat-reply-notifications", () => ({
  ChatReplyNotificationsRunner: () => null,
}));

import Layout from "@/components/layout";

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Layout />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  __resetSidebarCollapseStoreForTests();
  __resetSidebarRailStoreForTests();
  attentionMock.total = 0;
});

describe("Layout sidebar — collapsible groups", () => {
  it("renders all four group headers with expanded state by default", () => {
    renderLayout();
    for (const label of ["Overview", "Work", "Automate", "System"]) {
      const header = screen.getByRole("button", { name: new RegExp(label, "i") });
      expect(header.getAttribute("aria-expanded")).toBe("true");
    }
  });

  it("renders every nav item inside its group while all groups are open", () => {
    renderLayout();
    expect(screen.getByRole("link", { name: /Dashboard/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Inbox/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Analytics/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Workspaces/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Projects/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Tasks/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Chat$/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Templates/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Schedules/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Skills & MCP/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Settings/ })).toBeTruthy();
  });

  it("collapsing a group hides its nav items from the keyboard tab order", async () => {
    const user = userEvent.setup();
    renderLayout();
    const workHeader = screen.getByRole("button", { name: /^Work/i });
    await user.click(workHeader);
    expect(workHeader.getAttribute("aria-expanded")).toBe("false");

    // Items still exist in the DOM (kept around so the grid-rows animation
    // can play) but the region is aria-hidden and tabindex=-1 — so we must
    // opt into `hidden: true` to find the link in the accessibility tree.
    const projectsLink = screen.getByRole("link", {
      name: /Projects/,
      hidden: true,
    });
    expect(projectsLink.getAttribute("tabindex")).toBe("-1");

    // Re-opening restores normal tab order + accessibility-tree visibility.
    await user.click(workHeader);
    expect(workHeader.getAttribute("aria-expanded")).toBe("true");
    const projectsLinkAfter = screen.getByRole("link", { name: /Projects/ });
    expect(projectsLinkAfter.getAttribute("tabindex")).toBe("0");
  });

  it("surfaces an attention rollup badge on the Overview header", () => {
    attentionMock.total = 5;
    renderLayout();
    const overviewHeader = screen.getByRole("button", { name: /Overview/ });
    // Label "5 items in Overview" comes from the rollup span aria-label.
    expect(within(overviewHeader).getByLabelText(/5 items in Overview/)).toBeTruthy();
  });

  it("does not render a rollup badge when the group has no attention items", () => {
    attentionMock.total = 0;
    renderLayout();
    const workHeader = screen.getByRole("button", { name: /^Work/i });
    expect(within(workHeader).queryByText(/^\d+$/)).toBeNull();
  });

  it("collapses to icon-only rail when the rail toggle is clicked", async () => {
    const user = userEvent.setup();
    const { container } = renderLayout();

    // Default state: full-width desktop sidebar — group headers visible
    // and the desktop `aside` carries data-rail="false".
    const desktopAside = container.querySelector(
      'aside[data-rail]',
    ) as HTMLElement;
    expect(desktopAside).toBeTruthy();
    expect(desktopAside.getAttribute("data-rail")).toBe("false");
    expect(within(desktopAside).getByText("Flockctl")).toBeTruthy();
    expect(within(desktopAside).getByRole("button", { name: /Overview/ })).toBeTruthy();

    const railToggle = screen.getByRole("button", { name: /Collapse sidebar/i });
    await user.click(railToggle);

    // After collapse: brand label and group headers are gone from the
    // desktop aside, but the nav links (now icon-only) remain reachable
    // via their aria-labels. The `data-rail` flag flips to "true" and the
    // width class swaps to w-14.
    expect(desktopAside.getAttribute("data-rail")).toBe("true");
    expect(desktopAside.className).toMatch(/\bw-14\b/);
    expect(within(desktopAside).queryByText("Flockctl")).toBeNull();
    expect(within(desktopAside).queryByRole("button", { name: /^Overview/ })).toBeNull();
    expect(within(desktopAside).getByRole("link", { name: /Dashboard/ })).toBeTruthy();
    expect(within(desktopAside).getByRole("link", { name: /Settings/ })).toBeTruthy();

    // Toggle button now offers the inverse action.
    expect(screen.getByRole("button", { name: /Expand sidebar/i })).toBeTruthy();
  });

  it("persists the rail state across remounts", async () => {
    const user = userEvent.setup();
    const first = renderLayout();
    await user.click(screen.getByRole("button", { name: /Collapse sidebar/i }));
    const firstAside = first.container.querySelector(
      'aside[data-rail]',
    ) as HTMLElement;
    expect(firstAside.getAttribute("data-rail")).toBe("true");
    first.unmount();

    const { container } = renderLayout();
    // Still in rail mode after a remount — preference round-trips through
    // the store's localStorage layer.
    const aside = container.querySelector('aside[data-rail]') as HTMLElement;
    expect(aside.getAttribute("data-rail")).toBe("true");
    expect(screen.getByRole("button", { name: /Expand sidebar/i })).toBeTruthy();
  });

  it("persists the collapsed state across remounts", async () => {
    const user = userEvent.setup();
    const first = renderLayout();
    await user.click(screen.getByRole("button", { name: /Automate/i }));
    expect(
      screen.getByRole("button", { name: /Automate/i }).getAttribute("aria-expanded"),
    ).toBe("false");
    first.unmount();

    renderLayout();
    expect(
      screen.getByRole("button", { name: /Automate/i }).getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
