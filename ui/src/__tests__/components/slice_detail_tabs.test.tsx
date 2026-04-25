import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  SliceDetailTabs,
  DEFAULT_SLICE_TABS,
  type TabDef,
} from "@/pages/project-detail-components/SliceDetailTabs";

describe("SliceDetailTabs", () => {
  it("renders DEFAULT_SLICE_TABS with the Slice tab active by default", () => {
    render(<SliceDetailTabs sliceId="slice-1" />);

    // The single default tab is registered as a tablist trigger.
    const trigger = screen.getByRole("tab", { name: "Slice" });
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute("data-state")).toBe("active");

    // DEFAULT_SLICE_TABS has exactly the documented shape.
    expect(DEFAULT_SLICE_TABS).toHaveLength(1);
    expect(DEFAULT_SLICE_TABS[0]!.id).toBe("slice-detail");
    expect(DEFAULT_SLICE_TABS[0]!.label).toBe("Slice");
  });

  it("slice_detail_tabs_extends_with_additional_tabdef_entry: extra TabDef renders alongside the default without editing the component", async () => {
    // Corner case: milestone 10 adds a Supervisor log tab by *composing* the
    // registry at the call site. No change to SliceDetailTabs.tsx.
    const extraTab: TabDef = {
      id: "supervisor-log",
      label: "Supervisor log",
      render: (ctx) => (
        <div data-testid="supervisor-log-panel">
          supervisor log for {ctx.sliceId}
        </div>
      ),
    };

    const tabs: TabDef[] = [...DEFAULT_SLICE_TABS, extraTab];

    render(<SliceDetailTabs sliceId="slice-42" tabs={tabs} />);

    // Both tab triggers are in the DOM.
    const defaultTrigger = screen.getByRole("tab", { name: "Slice" });
    const extraTrigger = screen.getByRole("tab", { name: "Supervisor log" });
    expect(defaultTrigger).toBeTruthy();
    expect(extraTrigger).toBeTruthy();

    // Default tab is active on mount; its panel is visible.
    expect(defaultTrigger.getAttribute("data-state")).toBe("active");
    expect(extraTrigger.getAttribute("data-state")).toBe("inactive");

    // Switching to the extra tab renders its render() output — proving the
    // second TabDef participates in the registry end-to-end.
    await userEvent.click(extraTrigger);

    expect(extraTrigger.getAttribute("data-state")).toBe("active");
    expect(defaultTrigger.getAttribute("data-state")).toBe("inactive");

    const extraPanel = screen.getByTestId("supervisor-log-panel");
    expect(extraPanel.textContent).toContain("supervisor log for slice-42");
  });
});
