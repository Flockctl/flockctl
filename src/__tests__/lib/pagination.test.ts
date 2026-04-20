import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Hono context for paginationParams
function mockContext(query: Record<string, string> = {}): any {
  return {
    req: {
      query: (key: string) => query[key],
    },
  };
}

// We import after defining mocks
import { paginationParams } from "../../lib/pagination.js";

describe("paginationParams", () => {
  it("returns defaults when no query params", () => {
    const result = paginationParams(mockContext());
    expect(result).toEqual({ page: 1, perPage: 20, offset: 0 });
  });

  it("parses page and per_page", () => {
    const result = paginationParams(mockContext({ page: "3", per_page: "10" }));
    expect(result).toEqual({ page: 3, perPage: 10, offset: 20 });
  });

  it("clamps page minimum to 1", () => {
    const result = paginationParams(mockContext({ page: "0" }));
    expect(result.page).toBe(1);
  });

  it("clamps page minimum for negative", () => {
    const result = paginationParams(mockContext({ page: "-5" }));
    expect(result.page).toBe(1);
  });

  it("clamps per_page minimum to 1", () => {
    const result = paginationParams(mockContext({ per_page: "0" }));
    expect(result.perPage).toBe(1);
  });

  it("clamps per_page maximum to 100", () => {
    const result = paginationParams(mockContext({ per_page: "500" }));
    expect(result.perPage).toBe(100);
  });

  it("handles NaN values", () => {
    const result = paginationParams(mockContext({ page: "abc", per_page: "xyz" }));
    // Number("abc") = NaN, Math.max(1, NaN) = NaN
    expect(Number.isNaN(result.page)).toBe(true);
    expect(Number.isNaN(result.perPage)).toBe(true);
  });

  it("calculates offset correctly", () => {
    const result = paginationParams(mockContext({ page: "5", per_page: "25" }));
    expect(result.offset).toBe(100); // (5-1)*25
  });

  it("page 1 always has offset 0", () => {
    const result = paginationParams(mockContext({ page: "1", per_page: "50" }));
    expect(result.offset).toBe(0);
  });
});
