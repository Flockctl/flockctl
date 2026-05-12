import { describe, it, expect, beforeEach } from "vitest";
import { score, rankRows, entitiesToRows, NAV_ROWS } from "@/components/palette/cmdk-data";
import { cmdkStore } from "@/components/palette/cmdk-store";

describe("cmdk-data.score", () => {
  it("empty needle returns 1 (everything matches softly)", () => {
    expect(score("anything", "")).toBe(1);
  });

  it("exact match outscores prefix match outscores substring outscores subsequence", () => {
    const exact = score("dashboard", "dashboard");
    const prefix = score("dashboard view", "dash");
    const substring = score("project dashboard", "dash");
    const subseq = score("dashboard view", "dvw");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(0);
  });

  it("returns 0 for needles that cannot be matched", () => {
    expect(score("dashboard", "xyz")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(score("Dashboard", "DASH")).toBeGreaterThan(0);
    expect(score("DASHBOARD", "dash")).toBeGreaterThan(0);
  });
});

describe("cmdk-data.rankRows", () => {
  const rows = [...NAV_ROWS];

  it("with empty query, nav rows come first in order", () => {
    const ranked = rankRows(rows, "");
    expect(ranked[0]?.label).toBe("Dashboard");
    expect(ranked.length).toBe(NAV_ROWS.length);
  });

  it("filters out non-matching rows on a query", () => {
    const ranked = rankRows(rows, "dash");
    expect(ranked.every(r => r.label.toLowerCase().includes("d"))).toBe(true);
    // Dashboard should be first; Inbox should NOT be in the list
    // (no 'd' subsequence in 'Inbox').
    expect(ranked[0]?.label).toBe("Dashboard");
    expect(ranked.find(r => r.label === "Inbox")).toBeUndefined();
  });

  it("returns empty array when nothing matches", () => {
    expect(rankRows(rows, "xyzqqq")).toEqual([]);
  });
});

describe("cmdk-data.entitiesToRows", () => {
  it("flattens projects/workspaces/chats/tasks into the row union", () => {
    const out = entitiesToRows({
      projects: [
        // @ts-expect-error fixture: minimal Project shape
        { id: "p1", name: "alpha" },
      ],
      workspaces: [
        // @ts-expect-error fixture: minimal Workspace shape
        { id: "w1", name: "ws1" },
      ],
      chats: [
        // @ts-expect-error fixture: minimal ChatResponse shape
        { id: "c1", title: "discuss things", project_name: "alpha", workspace_name: null },
      ],
      tasks: [
        // @ts-expect-error fixture: minimal Task shape
        { id: "t1", prompt: "fix the bug", status: "queued" },
      ],
    });
    expect(out.find(r => r.id === "project:p1")?.label).toBe("alpha");
    expect(out.find(r => r.id === "workspace:w1")?.label).toBe("ws1");
    expect(out.find(r => r.id === "chat:c1")?.label).toBe("discuss things");
    expect(out.find(r => r.id === "task:t1")?.label).toBe("fix the bug");
  });

  it("falls back to short id labels when title/prompt is missing", () => {
    const out = entitiesToRows({
      projects: [],
      workspaces: [],
      chats: [
        // @ts-expect-error fixture
        { id: "abcdefg-rest", title: null, project_name: null, workspace_name: null },
      ],
      tasks: [
        // @ts-expect-error fixture
        { id: "1234567abc", prompt: null, status: "done" },
      ],
    });
    expect(out.find(r => r.id === "chat:abcdefg-rest")?.label).toBe("Chat abcdefg");
    expect(out.find(r => r.id === "task:1234567abc")?.label).toBe("Task 1234567");
  });
});

describe("cmdkStore", () => {
  beforeEach(() => {
    cmdkStore.__resetForTests();
  });

  it("starts closed with empty query", () => {
    expect(cmdkStore.getSnapshot()).toEqual({ open: false, query: "" });
  });

  it("open() / close() flip the boolean", () => {
    cmdkStore.open();
    expect(cmdkStore.getSnapshot().open).toBe(true);
    cmdkStore.close();
    expect(cmdkStore.getSnapshot().open).toBe(false);
  });

  it("close() resets the query so the next open starts fresh", () => {
    cmdkStore.open();
    cmdkStore.setQuery("foo");
    expect(cmdkStore.getSnapshot().query).toBe("foo");
    cmdkStore.close();
    expect(cmdkStore.getSnapshot().query).toBe("");
  });

  it("toggle() open then closed when starting open", () => {
    cmdkStore.open();
    cmdkStore.toggle();
    expect(cmdkStore.getSnapshot().open).toBe(false);
    cmdkStore.toggle();
    expect(cmdkStore.getSnapshot().open).toBe(true);
  });

  it("subscribers fire on every state change", () => {
    let count = 0;
    const unsub = cmdkStore.subscribe(() => {
      count++;
    });
    cmdkStore.open();
    cmdkStore.setQuery("hello");
    cmdkStore.close();
    unsub();
    expect(count).toBeGreaterThanOrEqual(3);
  });
});
