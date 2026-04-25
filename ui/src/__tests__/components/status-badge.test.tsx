import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { statusBadge } from "@/components/status-badge";

describe("statusBadge", () => {
  it("renders known statuses with their label", () => {
    for (const status of [
      "pending",
      "planning",
      "active",
      "running",
      "failed",
      "completed",
      "done",
      "merged",
      "skipped",
      "cancelled",
      "verifying",
      "merging",
    ]) {
      const { container } = render(statusBadge(status));
      expect(container.textContent?.toLowerCase()).toContain(status.replace("_", " "));
    }
  });

  it("normalises in_progress to 'active' label", () => {
    const { container } = render(statusBadge("in_progress"));
    expect(container.textContent).toBe("active");
  });

  it("renders 'pending approval' for pending_approval status", () => {
    const { container } = render(statusBadge("pending_approval"));
    expect(container.textContent).toBe("pending approval");
  });

  it("status_badge_renders_proposed with violet variant", () => {
    const { container } = render(statusBadge("proposed"));
    expect(container.textContent).toBe("proposed");
    const badge = container.firstElementChild as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.className).toMatch(/violet-500/);
    expect(badge.className).toMatch(/violet-600/);
    expect(badge.className).toMatch(/violet-400/);
  });

  it("falls back to the raw status for unknown values", () => {
    const { container } = render(statusBadge("unknown_state"));
    expect(container.textContent).toBe("unknown_state");
  });
});
