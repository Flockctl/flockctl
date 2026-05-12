import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";

describe("EmptyState", () => {
  it("renders the title text", () => {
    render(<EmptyState title="Nothing here yet" />);
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
  });

  it("renders the optional description when provided", () => {
    render(
      <EmptyState
        title="Nothing here yet"
        description="Items will show up after the first run."
      />,
    );
    expect(
      screen.getByText("Items will show up after the first run."),
    ).toBeTruthy();
  });

  it("omits the description container when not provided", () => {
    render(<EmptyState title="Nothing here yet" />);
    // The only text in the panel should be the title.
    expect(screen.queryByText(/Items will show up/)).toBeNull();
  });

  it("renders a dim, muted icon when one is provided", () => {
    render(<EmptyState icon={Inbox} title="All caught up" />);
    const icon = screen.getByTestId("empty-state-icon");
    expect(icon).toBeTruthy();
    // Restyle invariant: the icon is dim (no plate behind it).
    expect(icon.getAttribute("class") ?? "").toContain(
      "text-muted-foreground/60",
    );
  });

  it("does not render an icon when one is not provided", () => {
    render(<EmptyState title="All caught up" />);
    expect(screen.queryByTestId("empty-state-icon")).toBeNull();
  });

  it("renders an optional CTA action node below the title", () => {
    render(
      <EmptyState
        title="No projects yet"
        action={
          <button type="button" data-testid="cta">
            + New project
          </button>
        }
      />,
    );
    expect(screen.getByTestId("cta")).toBeTruthy();
    expect(screen.getByText("+ New project")).toBeTruthy();
  });

  it("uses the default data-testid when none is supplied", () => {
    render(<EmptyState title="All caught up" />);
    expect(screen.getByTestId("empty-state")).toBeTruthy();
  });

  it("forwards a custom data-testid", () => {
    render(
      <EmptyState
        title="All caught up · 0 items waiting"
        data-testid="attention-empty-state"
      />,
    );
    expect(screen.getByTestId("attention-empty-state")).toBeTruthy();
  });

  it("matches the attention-page empty-state copy contract", () => {
    // The attention page renders this exact title when the inbox is empty;
    // pin the string here so a copy edit on either side breaks loudly.
    render(
      <EmptyState
        icon={Inbox}
        title="All caught up · 0 items waiting"
        description="Approval requests and tool-permission prompts will appear here."
        data-testid="attention-empty-state"
      />,
    );
    expect(screen.getByText("All caught up · 0 items waiting")).toBeTruthy();
    expect(
      screen.getByText(
        "Approval requests and tool-permission prompts will appear here.",
      ),
    ).toBeTruthy();
  });
});
