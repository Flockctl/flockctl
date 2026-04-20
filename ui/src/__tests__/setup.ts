import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Force apiFetch to a stable base url so fetch mocks can assert on absolute paths.
(globalThis as any).__API_BASE_URL__ = "";

beforeEach(() => {
  // Each test gets a fresh fetch mock.
  (globalThis as any).fetch = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
