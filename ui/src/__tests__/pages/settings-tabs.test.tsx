import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router-dom";

import {
  SETTINGS_TAB_IDS,
  SettingsTabs,
  type SettingsTabId,
} from "@/pages/settings-components/SettingsTabs";

/**
 * Contract tests for the settings page tab strip.
 *
 * Pins down:
 *   - 4 tabs (ai-keys / server / secrets / skills) render in order.
 *   - The active tab is visually distinct via bg-white (or dark variant)
 *     + shadow-sm + font-semibold; inactive tabs are zinc-500.
 *   - The URL `?tab=` query param drives + reflects the active state via
 *     `useSearchParams` (with `replace: true` semantics).
 *   - Keyboard navigation (ArrowLeft / ArrowRight wraps; Home / End jump).
 */

// --- helpers -----------------------------------------------------------------

function URLProbe({ onUrl }: { onUrl: (search: string, tab: string) => void }) {
  const location = useLocation();
  const [params] = useSearchParams();
  const search = location.search;
  const tab = params.get("tab") ?? "";
  onUrl(search, tab);
  return null;
}

function renderTabs(
  ui: ReactNode,
  { initialUrl = "/settings" }: { initialUrl?: string } = {},
) {
  let lastSearch = "";
  let lastTab = "";
  const probe = (search: string, tab: string) => {
    lastSearch = search;
    lastTab = tab;
  };
  const utils = render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <Routes>
        <Route
          path="/settings"
          element={
            <>
              {ui}
              <URLProbe onUrl={probe} />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return {
    ...utils,
    getSearch: () => lastSearch,
    getTabParam: () => lastTab,
  };
}

// --- tests -------------------------------------------------------------------

describe("SettingsTabs — tab strip", () => {
  it("renders exactly the 4 expected tabs in order", () => {
    renderTabs(<SettingsTabs />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    const labels = tabs.map((t) => t.textContent?.trim());
    expect(labels).toEqual(["AI Keys", "Server", "Secrets", "Skills"]);
    expect(tabs.map((t) => t.getAttribute("data-tab-id"))).toEqual([
      ...SETTINGS_TAB_IDS,
    ]);
  });

  it("defaults to 'ai-keys' when no ?tab= is present", () => {
    renderTabs(<SettingsTabs />);
    const aiKeysTab = screen.getByRole("tab", { name: "AI Keys" });
    expect(aiKeysTab.getAttribute("aria-selected")).toBe("true");
    expect(aiKeysTab.getAttribute("data-active")).toBe("true");
    for (const id of ["server", "secrets", "skills"]) {
      const tab = screen.getByTestId(`settings-tab-${id}`);
      expect(tab.getAttribute("aria-selected")).toBe("false");
      expect(tab.getAttribute("data-active")).toBeNull();
    }
  });

  it("normalises an unknown ?tab= value back to ai-keys", () => {
    renderTabs(<SettingsTabs />, {
      initialUrl: "/settings?tab=mystery",
    });
    expect(
      screen
        .getByRole("tab", { name: "AI Keys" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("active tab is visually distinct (bg-card + shadow + font-semibold)", () => {
    renderTabs(<SettingsTabs />, { initialUrl: "/settings?tab=server" });
    const server = screen.getByRole("tab", { name: "Server" });
    expect(server.className).toContain("bg-white");
    expect(server.className).toContain("dark:bg-zinc-900");
    expect(server.className).toContain("shadow-sm");
    expect(server.className).toContain("font-semibold");

    const aiKeys = screen.getByRole("tab", { name: "AI Keys" });
    expect(aiKeys.className).toContain("text-zinc-500");
    expect(aiKeys.className).not.toContain("font-semibold");
  });

  it("container uses the segmented-pill classes from the spec", () => {
    renderTabs(<SettingsTabs />);
    const list = screen.getByRole("tablist", { name: "Settings sections" });
    for (const cls of [
      "inline-flex",
      "rounded-lg",
      "bg-zinc-100",
      "dark:bg-zinc-800",
      "p-0.5",
    ]) {
      expect(list.className).toContain(cls);
    }
  });

  it("clicking a tab updates ?tab= via useSearchParams", async () => {
    const user = userEvent.setup();
    const { getTabParam } = renderTabs(<SettingsTabs />);
    await user.click(screen.getByRole("tab", { name: "Secrets" }));
    expect(getTabParam()).toBe("secrets");
    expect(
      screen.getByRole("tab", { name: "Secrets" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("selecting AI Keys clears the ?tab= param entirely", async () => {
    const user = userEvent.setup();
    const { getSearch } = renderTabs(<SettingsTabs />, {
      initialUrl: "/settings?tab=server",
    });
    expect(getSearch()).toContain("tab=server");
    await user.click(screen.getByRole("tab", { name: "AI Keys" }));
    expect(getSearch()).toBe("");
  });

  it("fires onTabChange with the new id when a tab is clicked", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn<(tab: SettingsTabId) => void>();
    renderTabs(<SettingsTabs onTabChange={onTabChange} />);
    await user.click(screen.getByRole("tab", { name: "Skills" }));
    expect(onTabChange).toHaveBeenCalledWith("skills");
  });

  it("ArrowRight cycles to the next tab and wraps at the end", async () => {
    const user = userEvent.setup();
    const { getTabParam } = renderTabs(<SettingsTabs />);
    const aiKeys = screen.getByRole("tab", { name: "AI Keys" });
    aiKeys.focus();

    await user.keyboard("{ArrowRight}");
    expect(getTabParam()).toBe("server");
    await user.keyboard("{ArrowRight}");
    expect(getTabParam()).toBe("secrets");
    await user.keyboard("{ArrowRight}");
    expect(getTabParam()).toBe("skills");
    // Wrap.
    await user.keyboard("{ArrowRight}");
    // AI Keys is the default — param is cleared rather than set to "ai-keys".
    expect(getTabParam()).toBe("");
    expect(
      screen.getByRole("tab", { name: "AI Keys" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("ArrowLeft cycles to the previous tab and wraps at the start", async () => {
    const user = userEvent.setup();
    const { getTabParam } = renderTabs(<SettingsTabs />);
    screen.getByRole("tab", { name: "AI Keys" }).focus();
    await user.keyboard("{ArrowLeft}");
    // Wrapped to last (skills).
    expect(getTabParam()).toBe("skills");
    await user.keyboard("{ArrowLeft}");
    expect(getTabParam()).toBe("secrets");
  });

  it("Home jumps to the first tab and End jumps to the last", async () => {
    const user = userEvent.setup();
    const { getTabParam } = renderTabs(<SettingsTabs />, {
      initialUrl: "/settings?tab=secrets",
    });
    const secrets = screen.getByRole("tab", { name: "Secrets" });
    secrets.focus();

    await user.keyboard("{End}");
    expect(getTabParam()).toBe("skills");
    await user.keyboard("{Home}");
    // AI Keys is default — param cleared.
    expect(getTabParam()).toBe("");
    expect(
      screen.getByRole("tab", { name: "AI Keys" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("only the active tab is in the focus ring (roving tabindex)", () => {
    renderTabs(<SettingsTabs />, { initialUrl: "/settings?tab=server" });
    expect(
      screen.getByRole("tab", { name: "Server" }).getAttribute("tabindex"),
    ).toBe("0");
    for (const name of ["AI Keys", "Secrets", "Skills"]) {
      expect(
        screen.getByRole("tab", { name }).getAttribute("tabindex"),
      ).toBe("-1");
    }
  });
});
