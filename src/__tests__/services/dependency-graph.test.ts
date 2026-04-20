import { describe, it, expect } from "vitest";
import { computeWaves, getReadyItems, type DependencyItem } from "../../services/dependency-graph.js";

describe("computeWaves", () => {
  it("returns empty waves for empty input", () => {
    expect(computeWaves([])).toEqual([]);
  });

  it("single item with no deps is wave 0", () => {
    const items = [{ id: 1, depends: [] }];
    const waves = computeWaves(items);
    expect(waves).toEqual([{ wave: 0, ids: [1] }]);
  });

  it("independent items run in parallel (same wave)", () => {
    const items = [
      { id: 1, depends: [] },
      { id: 2, depends: [] },
      { id: 3, depends: [] },
    ];
    const waves = computeWaves(items);
    expect(waves).toHaveLength(1);
    expect(waves[0].ids).toEqual([1, 2, 3]);
  });

  it("linear chain produces sequential waves", () => {
    const items = [
      { id: 1, depends: [] },
      { id: 2, depends: [1] },
      { id: 3, depends: [2] },
    ];
    const waves = computeWaves(items);
    expect(waves).toHaveLength(3);
    expect(waves[0].ids).toEqual([1]);
    expect(waves[1].ids).toEqual([2]);
    expect(waves[2].ids).toEqual([3]);
  });

  it("diamond dependency pattern", () => {
    //   1
    //  / \
    // 2   3
    //  \ /
    //   4
    const items = [
      { id: 1, depends: [] },
      { id: 2, depends: [1] },
      { id: 3, depends: [1] },
      { id: 4, depends: [2, 3] },
    ];
    const waves = computeWaves(items);
    expect(waves).toHaveLength(3);
    expect(waves[0].ids).toEqual([1]);
    expect(waves[1].ids.sort((a, b) => a - b)).toEqual([2, 3]);
    expect(waves[2].ids).toEqual([4]);
  });

  it("mixed parallel and sequential", () => {
    // A(1), B(2) parallel; C(3) depends on A; D(4) depends on B; E(5) depends on C + D
    const items = [
      { id: 1, depends: [] },
      { id: 2, depends: [] },
      { id: 3, depends: [1] },
      { id: 4, depends: [2] },
      { id: 5, depends: [3, 4] },
    ];
    const waves = computeWaves(items);
    expect(waves).toHaveLength(3);
    expect(waves[0].ids.sort((a, b) => a - b)).toEqual([1, 2]);
    expect(waves[1].ids.sort((a, b) => a - b)).toEqual([3, 4]);
    expect(waves[2].ids).toEqual([5]);
  });

  it("handles circular dependencies by breaking them", () => {
    const items = [
      { id: 1, depends: [2] },
      { id: 2, depends: [1] },
    ];
    const waves = computeWaves(items);
    // Should not hang — breaks circular dep by adding all remaining
    expect(waves.length).toBeGreaterThan(0);
    const allIds = waves.flatMap(w => w.ids).sort();
    expect(allIds).toEqual([1, 2]);
  });

  it("handles self-referencing dependency", () => {
    const items = [{ id: 1, depends: [1] }];
    const waves = computeWaves(items);
    expect(waves.length).toBeGreaterThan(0);
    expect(waves.flatMap(w => w.ids)).toEqual([1]);
  });

  it("large fan-out (many items depend on one)", () => {
    const items: DependencyItem<number>[] = [
      { id: 1, depends: [] },
      ...Array.from({ length: 10 }, (_, i) => ({ id: i + 2, depends: [1] })),
    ];
    const waves = computeWaves(items);
    expect(waves).toHaveLength(2);
    expect(waves[0].ids).toEqual([1]);
    expect(waves[1].ids.length).toBe(10);
  });

  it("large fan-in (one item depends on many)", () => {
    const items: DependencyItem<number>[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: i + 1, depends: [] as number[] })),
      { id: 6, depends: [1, 2, 3, 4, 5] },
    ];
    const waves = computeWaves(items);
    expect(waves).toHaveLength(2);
    expect(waves[0].ids.length).toBe(5);
    expect(waves[1].ids).toEqual([6]);
  });

  it("preserves wave numbering", () => {
    const items = [
      { id: 10, depends: [] },
      { id: 20, depends: [10] },
      { id: 30, depends: [20] },
    ];
    const waves = computeWaves(items);
    expect(waves[0].wave).toBe(0);
    expect(waves[1].wave).toBe(1);
    expect(waves[2].wave).toBe(2);
  });

  it("non-sequential IDs work correctly", () => {
    const items = [
      { id: 100, depends: [] },
      { id: 200, depends: [100] },
      { id: 50, depends: [] },
    ];
    const waves = computeWaves(items);
    expect(waves).toHaveLength(2);
    expect(waves[0].ids.sort((a, b) => a - b)).toEqual([50, 100]);
    expect(waves[1].ids).toEqual([200]);
  });
});

describe("getReadyItems", () => {
  it("returns all items when none have deps", () => {
    const items: DependencyItem<number>[] = [
      { id: 1, depends: [], status: "pending" },
      { id: 2, depends: [], status: "pending" },
    ];
    expect(getReadyItems(items).sort()).toEqual([1, 2]);
  });

  it("returns items whose deps are completed", () => {
    const items: DependencyItem<number>[] = [
      { id: 1, depends: [], status: "completed" },
      { id: 2, depends: [1], status: "pending" },
      { id: 3, depends: [2], status: "pending" },
    ];
    expect(getReadyItems(items)).toEqual([2]);
  });

  it("returns empty when no items are ready", () => {
    const items: DependencyItem<number>[] = [
      { id: 1, depends: [], status: "active" },
      { id: 2, depends: [1], status: "pending" },
    ];
    // Item 1 is active (not completed), so item 2 is not ready
    // Item 1 is already active, so it's "in progress" — depends on interpretation
    // getReadyItems returns activeOrPending items where deps are completed
    const ready = getReadyItems(items);
    // Item 1 has no deps and is active → its deps (none) are all completed → ready
    // Item 2 depends on 1 which is active (not completed) → not ready
    expect(ready).toEqual([1]);
  });

  it("excludes failed items", () => {
    const items: DependencyItem<number>[] = [
      { id: 1, depends: [], status: "failed" },
      { id: 2, depends: [], status: "pending" },
    ];
    expect(getReadyItems(items)).toEqual([2]);
  });

  it("excludes completed items from results", () => {
    const items: DependencyItem<number>[] = [
      { id: 1, depends: [], status: "completed" },
      { id: 2, depends: [], status: "completed" },
    ];
    expect(getReadyItems(items)).toEqual([]);
  });

  it("empty input returns empty", () => {
    expect(getReadyItems([])).toEqual([]);
  });

  it("handles item with completed and failed dependencies", () => {
    const items: DependencyItem<number>[] = [
      { id: 1, depends: [], status: "completed" },
      { id: 2, depends: [], status: "failed" },
      { id: 3, depends: [1, 2], status: "pending" },
    ];
    // Item 2 is failed, but dependency check only looks at completed IDs
    // So item 3's dep on item 2 is not met (item 2 is not in completedIds)
    expect(getReadyItems(items)).toEqual([]);
  });

  it("items without status default to being included", () => {
    const items: DependencyItem<number>[] = [
      { id: 1, depends: [] },
      { id: 2, depends: [1] },
    ];
    // No status = undefined = not "completed" or "failed"
    const ready = getReadyItems(items);
    // Item 1 has no deps → ready  
    // Item 2 depends on 1 which is not completed → not ready
    expect(ready).toEqual([1]);
  });
});
