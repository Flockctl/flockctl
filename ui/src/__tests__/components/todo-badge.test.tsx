import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TodoBadge } from "@/components/TodoBadge";

describe("TodoBadge", () => {
  it("renders nothing for null counts", () => {
    const { container } = render(<TodoBadge counts={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when total is zero", () => {
    const { container } = render(
      <TodoBadge counts={{ total: 0, completed: 0, in_progress: 0, pending: 0 }} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders N/M for populated counts", () => {
    render(
      <TodoBadge counts={{ total: 5, completed: 2, in_progress: 1, pending: 2 }} />
    );
    const badge = screen.getByTestId("todo-badge");
    expect(badge.textContent).toBe("2/5");
    expect(badge.getAttribute("aria-label")).toBe("2 of 5 todos done");
  });

  it("clamps completed above total to the total", () => {
    render(
      <TodoBadge counts={{ total: 3, completed: 9, in_progress: 0, pending: 0 }} />
    );
    expect(screen.getByTestId("todo-badge").textContent).toBe("3/3");
  });

  it("clamps negative completed to 0", () => {
    render(
      <TodoBadge counts={{ total: 3, completed: -1, in_progress: 0, pending: 0 }} />
    );
    expect(screen.getByTestId("todo-badge").textContent).toBe("0/3");
  });
});
