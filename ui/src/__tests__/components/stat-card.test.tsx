import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatCard } from "@/components/stat-card";
import { Activity } from "lucide-react";

describe("StatCard", () => {
  it("renders value and subtitle when not loading", () => {
    render(
      <StatCard
        icon={Activity}
        label="Runs"
        value={42}
        subtitle="past week"
        isLoading={false}
      />
    );
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("Runs")).toBeTruthy();
    expect(screen.getByText("past week")).toBeTruthy();
  });

  it("renders a skeleton when loading and hides the subtitle", () => {
    const { container } = render(
      <StatCard
        icon={Activity}
        label="Runs"
        value={42}
        subtitle="past week"
        isLoading
      />
    );
    expect(screen.queryByText("42")).toBeNull();
    expect(screen.queryByText("past week")).toBeNull();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });

  it("accepts string values", () => {
    render(
      <StatCard icon={Activity} label="Uptime" value="99%" isLoading={false} />
    );
    expect(screen.getByText("99%")).toBeTruthy();
  });
});
