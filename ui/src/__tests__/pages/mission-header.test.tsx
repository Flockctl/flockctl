import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { MissionHeader } from "@/pages/mission-detail-components/MissionHeader";
import type { Mission } from "@/lib/hooks/missions";

/**
 * Unit tests for {@link MissionHeader} (slice 24/01 T01).
 *
 * Surface area:
 *   - h1 carries the objective text and the slice's typography
 *     contract (`text-[18px] font-semibold`).
 *   - Trigger source line falls back to an autonomy + status combo
 *     when no explicit `triggerSource` is supplied.
 *   - Status + autonomy badges render as <StatusPill>s with the
 *     correct tone for each lifecycle status.
 */

function makeMission(over: Partial<Mission> = {}): Mission {
  return {
    id: "m-1",
    project_id: "p-1",
    objective: "Ship the supervisor onboarding flow",
    status: "active",
    autonomy: "suggest",
    budget_tokens: 100_000,
    budget_usd_cents: 500,
    spent_tokens: 12_345,
    spent_usd_cents: 67,
    supervisor_prompt_version: "1.0.0",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_500,
    ...over,
  };
}

describe("MissionHeader / objective", () => {
  it("renders the objective in an h1", () => {
    render(<MissionHeader mission={makeMission()} />);
    const h1 = screen.getByTestId("mission-header-objective");
    expect(h1.tagName).toBe("H1");
    expect(h1).toHaveTextContent("Ship the supervisor onboarding flow");
  });

  it("applies the slice typography contract (text-[18px] + font-semibold)", () => {
    render(<MissionHeader mission={makeMission()} />);
    const h1 = screen.getByTestId("mission-header-objective");
    expect(h1.className).toContain("text-[18px]");
    expect(h1.className).toContain("font-semibold");
  });
});

describe("MissionHeader / trigger source line", () => {
  it("renders the explicit triggerSource when provided", () => {
    render(
      <MissionHeader
        mission={makeMission()}
        triggerSource="Operator · 4 minutes ago"
      />,
    );
    const trigger = screen.getByTestId("mission-header-trigger");
    expect(trigger).toHaveTextContent("Operator · 4 minutes ago");
  });

  it("uses an autonomy + status fallback when no triggerSource is supplied", () => {
    render(
      <MissionHeader
        mission={makeMission({ autonomy: "manual", status: "paused" })}
      />,
    );
    const trigger = screen.getByTestId("mission-header-trigger");
    expect(trigger).toHaveTextContent(/Manual approvals/);
    expect(trigger).toHaveTextContent(/paused/);
  });

  it("uses the slice typography contract (text-[12px] + zinc-500)", () => {
    render(<MissionHeader mission={makeMission()} />);
    const trigger = screen.getByTestId("mission-header-trigger");
    expect(trigger.className).toContain("text-[12px]");
    expect(trigger.className).toContain("text-zinc-500");
  });
});

describe("MissionHeader / status + autonomy pills", () => {
  it("paints status='active' with the info tone", () => {
    render(<MissionHeader mission={makeMission({ status: "active" })} />);
    const pill = screen.getByTestId("mission-header-status");
    expect(pill).toHaveTextContent("active");
    expect(pill.getAttribute("data-tone")).toBe("info");
  });

  it("paints status='completed' with the success tone", () => {
    render(<MissionHeader mission={makeMission({ status: "completed" })} />);
    const pill = screen.getByTestId("mission-header-status");
    expect(pill.getAttribute("data-tone")).toBe("success");
  });

  it("paints status='failed' with the danger tone", () => {
    render(<MissionHeader mission={makeMission({ status: "failed" })} />);
    const pill = screen.getByTestId("mission-header-status");
    expect(pill.getAttribute("data-tone")).toBe("danger");
  });

  it("paints status='paused' with the warning tone", () => {
    render(<MissionHeader mission={makeMission({ status: "paused" })} />);
    const pill = screen.getByTestId("mission-header-status");
    expect(pill.getAttribute("data-tone")).toBe("warning");
  });

  it("renders the autonomy pill alongside status", () => {
    render(<MissionHeader mission={makeMission({ autonomy: "auto" })} />);
    const pill = screen.getByTestId("mission-header-autonomy");
    expect(pill).toHaveTextContent("auto");
  });
});
