import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { cn, slugify, timeAgo } from "@/lib/utils";

describe("cn", () => {
  it("merges multiple class tokens", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("collapses tailwind conflicts (twMerge)", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("handles falsy values", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("handles object form", () => {
    expect(cn({ a: true, b: false, c: true })).toBe("a c");
  });
});

describe("slugify", () => {
  it("replaces spaces with underscores", () => {
    expect(slugify("my project")).toBe("my_project");
  });

  it("strips unsafe characters", () => {
    expect(slugify("Hello, World!")).toBe("Hello_World");
  });

  it("collapses multiple underscores", () => {
    expect(slugify("a    b    c")).toBe("a_b_c");
  });

  it("trims leading/trailing separators", () => {
    expect(slugify("  __hello__  ")).toBe("hello");
  });

  it("preserves hyphens and dots", () => {
    expect(slugify("foo-bar.v1.2")).toBe("foo-bar.v1.2");
  });

  it("falls back to 'unnamed' for empty result", () => {
    expect(slugify("!!!")).toBe("unnamed");
    expect(slugify("")).toBe("unnamed");
    expect(slugify("   ")).toBe("unnamed");
  });
});

describe("timeAgo", () => {
  const FIXED_NOW = new Date("2026-04-20T12:00:00Z").getTime();

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("returns em-dash for nullish input", () => {
    expect(timeAgo(null)).toBe("—");
    expect(timeAgo(undefined)).toBe("—");
    expect(timeAgo("")).toBe("—");
  });

  it("returns 'just now' for timestamps in the future", () => {
    expect(timeAgo(new Date(FIXED_NOW + 10_000).toISOString())).toBe("just now");
  });

  it("returns seconds when <1 minute", () => {
    expect(timeAgo(new Date(FIXED_NOW - 30_000).toISOString())).toBe("30s ago");
  });

  it("returns minutes when <1 hour", () => {
    expect(timeAgo(new Date(FIXED_NOW - 5 * 60_000).toISOString())).toBe("5m ago");
  });

  it("returns hours when <1 day", () => {
    expect(timeAgo(new Date(FIXED_NOW - 3 * 3_600_000).toISOString())).toBe("3h ago");
  });

  it("returns days for longer intervals", () => {
    expect(timeAgo(new Date(FIXED_NOW - 5 * 86_400_000).toISOString())).toBe("5d ago");
  });
});
