import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ServerConnection } from "@/lib/types";

// ── Mock the server context — we want deterministic state per test, no
//    real /health probes, no SSH tunnel dependencies. The shape mirrors
//    the slice of `ServerContextValue` the TitleBar consumes.
const ctx: {
  connectionStatus: "connected" | "checking" | "error";
  activeServer: ServerConnection;
  servers: ServerConnection[];
  switchServer: ReturnType<typeof vi.fn>;
} = {
  connectionStatus: "connected",
  activeServer: { id: "local", name: "Local", is_local: true },
  servers: [{ id: "local", name: "Local", is_local: true }],
  switchServer: vi.fn(),
};

vi.mock("@/contexts/server-context", () => ({
  useServerContext: () => ctx,
}));

// ── Theme provider state (in-memory). The TitleBar only reads/writes
//    via `useTheme`; we don't care about persistence in unit tests.
const themeState: { theme: "light" | "dark" | "system"; setTheme: ReturnType<typeof vi.fn> } = {
  theme: "light",
  setTheme: vi.fn(),
};

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => themeState,
}));

// Stub the Breadcrumb so the TitleBar test stays focused on the bar
// itself. The breadcrumb's own behaviour is covered in
// `__tests__/shell/breadcrumb.test.tsx`.
vi.mock("@/components/shell/Breadcrumb", () => ({
  Breadcrumb: () => <span data-testid="breadcrumb-stub">Dashboard</span>,
}));

import { TitleBar } from "@/components/shell/TitleBar";

function mount(props: { onCmdK?: () => void } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TitleBar {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  ctx.connectionStatus = "connected";
  ctx.activeServer = { id: "local", name: "Local", is_local: true };
  ctx.servers = [{ id: "local", name: "Local", is_local: true }];
  ctx.switchServer.mockReset();
  themeState.theme = "light";
  themeState.setTheme.mockReset();
});

describe("TitleBar", () => {
  it("renders the prototype container chrome (h-9, divider, white bg)", () => {
    const { container } = mount();
    const header = container.querySelector("header[data-slot='title-bar']");
    expect(header).not.toBeNull();
    const cls = header!.className;
    // These four classes are the prototype-line-60 contract.
    expect(cls).toContain("h-9");
    expect(cls).toContain("shrink-0");
    expect(cls).toContain("border-b");
    expect(cls).toContain("divider-y");
    expect(cls).toContain("bg-white");
    expect(cls).toContain("dark:bg-zinc-900");
    expect(cls).toContain("flex");
    expect(cls).toContain("items-center");
    expect(cls).toContain("px-3");
    expect(cls).toContain("gap-3");
  });

  it("renders the brand logo (matching favicon.svg) and 'flockctl' wordmark", () => {
    const { container } = mount();
    const link = screen.getByRole("link", { name: /flockctl home/i });
    expect(link.getAttribute("href")).toBe("/dashboard");
    const svg = link.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("width")).toBe("16");
    expect(svg!.getAttribute("height")).toBe("16");
    // Logo is the favicon mark — three chevrons in indigo `#863bff`,
    // shared with `public/favicon.svg` via `<Logo>`.
    expect(svg!.getAttribute("viewBox")).toBe("0 0 64 64");
    const group = svg!.querySelector("g");
    expect(group).not.toBeNull();
    expect(group!.getAttribute("stroke")).toBe("#863bff");
    expect(svg!.querySelectorAll("path").length).toBe(3);
    expect(container.textContent).toContain("flockctl");
  });

  it("renders the · divider with prototype tone classes", () => {
    const { container } = mount();
    const dividers = Array.from(container.querySelectorAll("div")).filter(
      (d) => d.textContent === "·",
    );
    expect(dividers.length).toBeGreaterThanOrEqual(1);
    const cls = dividers[0]!.className;
    expect(cls).toContain("text-zinc-400");
    expect(cls).toContain("dark:text-zinc-700");
  });

  it("wraps the breadcrumb in a slot with prototype classes", () => {
    const { container } = mount();
    const slot = container.querySelector("[data-slot='breadcrumb-slot']");
    expect(slot).not.toBeNull();
    const cls = slot!.className;
    expect(cls).toContain("flex");
    expect(cls).toContain("items-center");
    expect(cls).toContain("gap-1.5");
    expect(cls).toContain("text-[12.5px]");
    expect(slot!.querySelector("[data-testid='breadcrumb-stub']")).not.toBeNull();
  });

  it("renders the ⌘K button as a w-72 bordered placeholder when no handler", () => {
    mount();
    const btn = screen.getByRole("button", { name: /command palette/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
    const cls = btn.className;
    expect(cls).toContain("w-72");
    expect(cls).toContain("border");
    expect(cls).toContain("border-zinc-200");
    expect(cls).toContain("dark:border-zinc-700");
    expect(cls).toContain("hover:border-indigo-400");
    expect(cls).toContain("text-[12px]");
    expect(btn.textContent).toContain("Jump to project, chat, file…");
    expect(btn.querySelector("kbd")).not.toBeNull();
  });

  it("invokes onCmdK when the palette button is clicked", async () => {
    const onCmdK = vi.fn();
    mount({ onCmdK });
    const user = userEvent.setup();
    const btn = screen.getByRole("button", { name: /command palette/i });
    expect(btn.hasAttribute("disabled")).toBe(false);
    await user.click(btn);
    expect(onCmdK).toHaveBeenCalledTimes(1);
  });

  it("renders a live LiveDot + localhost:52077 when daemon is connected", () => {
    const { container } = mount();
    expect(container.textContent).toContain("localhost:52077");
    const dot = container.querySelector("[data-state='live']");
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute("data-size")).toBe("xs");
  });

  it("flips the LiveDot to the error state when disconnected", () => {
    ctx.connectionStatus = "error";
    const { container } = mount();
    const dot = container.querySelector("[data-state='error']");
    expect(dot).not.toBeNull();
    // No live dot present.
    expect(container.querySelector("[data-state='live']")).toBeNull();
  });

  it("falls back to the SSH host when the active server is remote", () => {
    ctx.activeServer = {
      id: "r1",
      name: "remote-1",
      is_local: false,
      ssh: { host: "alice@prod.example" },
    };
    const { container } = mount();
    expect(container.textContent).toContain("alice@prod.example");
    expect(container.textContent).not.toContain("localhost:52077");
  });

  it("does NOT render an identity avatar (single-tenant local-first)", () => {
    // The prototype shipped a static "EA" gradient avatar in the
    // top-right. It was removed because Flockctl runs as a local-only
    // single-user daemon, so an identity affordance carries no
    // information for the operator. Verify it doesn't sneak back in.
    const { container } = mount();
    const avatarByInitials = Array.from(container.querySelectorAll("div")).find(
      (d) => d.textContent === "EA",
    );
    expect(avatarByInitials).toBeUndefined();
    // Belt & braces: no gradient circle inside the title-bar header.
    const header = container.querySelector("header[data-slot='title-bar']");
    expect(header).not.toBeNull();
    expect(header!.querySelector("div.bg-gradient-to-br")).toBeNull();
  });

  it("toggles theme between light and dark on click (no system step)", async () => {
    const user = userEvent.setup();
    mount();
    const toggle = screen.getByRole("button", { name: /theme: light/i });
    await user.click(toggle);
    expect(themeState.setTheme).toHaveBeenCalledWith("dark");

    themeState.setTheme.mockReset();
    themeState.theme = "dark";
    mount();
    const toggle2 = screen.getAllByRole("button", { name: /theme: dark/i })[0]!;
    await user.click(toggle2);
    expect(themeState.setTheme).toHaveBeenCalledWith("light");
  });
});
