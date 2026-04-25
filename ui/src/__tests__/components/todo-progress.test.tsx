import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TodoProgress } from "@/components/TodoProgress";

describe("TodoProgress", () => {
  it("shows 'N / M done' label", () => {
    render(
      <TodoProgress counts={{ total: 4, completed: 2, in_progress: 1, pending: 1 }} />
    );
    expect(screen.getByText(/2 \/ 4 done/)).toBeTruthy();
  });

  it("includes in-progress sub-label when present", () => {
    render(
      <TodoProgress counts={{ total: 4, completed: 2, in_progress: 1, pending: 1 }} />
    );
    expect(screen.getByText(/1 in progress/)).toBeTruthy();
  });

  it("omits in-progress sub-label when 0", () => {
    render(
      <TodoProgress counts={{ total: 4, completed: 2, in_progress: 0, pending: 2 }} />
    );
    expect(screen.queryByText(/in progress/)).toBeNull();
  });

  it("does not NaN when total is 0", () => {
    render(
      <TodoProgress counts={{ total: 0, completed: 0, in_progress: 0, pending: 0 }} />
    );
    expect(screen.getByTestId("todo-progress").textContent).toContain("0 / 0 done");
  });

  it("clamps completed above total", () => {
    render(
      <TodoProgress counts={{ total: 3, completed: 10, in_progress: 0, pending: 0 }} />
    );
    expect(screen.getByText(/3 \/ 3 done/)).toBeTruthy();
  });
});
