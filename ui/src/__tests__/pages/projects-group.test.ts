import { describe, it, expect } from "vitest";
import {
  groupByWorkspace,
  type GroupableProject,
  type GroupableWorkspace,
} from "@/pages/projects-components/groupByWorkspace";

// ─── Test fixtures ────────────────────────────────────────────────────
//
// Workspace IDs use both string and number forms because the underlying
// DB schema is in transition (Project.workspace_id is `number | null`,
// Workspace.id is `string`). The helper must tolerate either; tests
// pin both shapes so a future strict-typing of the helper surfaces as
// a deliberate change, not a silent regression.

const ws = (id: string | number, name: string): GroupableWorkspace => ({
  id,
  name,
});

const proj = (
  id: string,
  workspace_id: string | number | null,
  last_activity_at: string,
): GroupableProject => ({ id, workspace_id, last_activity_at });

describe("groupByWorkspace", () => {
  it("returns empty structure for empty input", () => {
    expect(groupByWorkspace([], [])).toEqual({ workspaces: [], standalone: [] });
  });

  it("places projects with no workspace_id into standalone", () => {
    const projects = [
      proj("p1", null, "2024-01-01T00:00:00Z"),
      proj("p2", null, "2024-02-01T00:00:00Z"),
    ];
    const result = groupByWorkspace(projects, []);
    expect(result.workspaces).toEqual([]);
    expect(result.standalone.map((p) => p.id)).toEqual(["p2", "p1"]);
  });

  it("treats undefined workspace_id as standalone", () => {
    const p: GroupableProject = {
      id: "p1",
      workspace_id: undefined,
      last_activity_at: "2024-01-01T00:00:00Z",
    };
    const result = groupByWorkspace([p], []);
    expect(result.standalone).toHaveLength(1);
    expect(result.workspaces).toHaveLength(0);
  });

  it("falls back to standalone when workspace_id does not match any workspace", () => {
    const projects = [proj("p1", "missing-ws", "2024-01-01T00:00:00Z")];
    const result = groupByWorkspace(projects, [ws("ws-real", "Real")]);
    expect(result.workspaces).toEqual([]);
    expect(result.standalone.map((p) => p.id)).toEqual(["p1"]);
  });

  it("groups projects by their workspace_id", () => {
    const workspaces = [ws("ws-a", "Alpha"), ws("ws-b", "Bravo")];
    const projects = [
      proj("p1", "ws-a", "2024-01-01T00:00:00Z"),
      proj("p2", "ws-b", "2024-01-02T00:00:00Z"),
      proj("p3", "ws-a", "2024-01-03T00:00:00Z"),
    ];
    const result = groupByWorkspace(projects, workspaces);
    expect(result.standalone).toEqual([]);
    expect(result.workspaces).toHaveLength(2);
    expect(result.workspaces[0]!.ws.name).toBe("Alpha");
    expect(result.workspaces[0]!.projects.map((p) => p.id)).toEqual(["p3", "p1"]);
    expect(result.workspaces[1]!.ws.name).toBe("Bravo");
    expect(result.workspaces[1]!.projects.map((p) => p.id)).toEqual(["p2"]);
  });

  it("sorts workspaces by name ascending (locale-aware)", () => {
    const workspaces = [
      ws("ws-z", "Zeta"),
      ws("ws-a", "Alpha"),
      ws("ws-m", "Mike"),
    ];
    const projects = [
      proj("p1", "ws-z", "2024-01-01T00:00:00Z"),
      proj("p2", "ws-a", "2024-01-02T00:00:00Z"),
      proj("p3", "ws-m", "2024-01-03T00:00:00Z"),
    ];
    const result = groupByWorkspace(projects, workspaces);
    expect(result.workspaces.map((g) => g.ws.name)).toEqual([
      "Alpha",
      "Mike",
      "Zeta",
    ]);
  });

  it("sorts projects within a workspace by last_activity_at descending", () => {
    const workspaces = [ws("ws-a", "Alpha")];
    const projects = [
      proj("oldest", "ws-a", "2023-06-01T00:00:00Z"),
      proj("newest", "ws-a", "2025-01-01T00:00:00Z"),
      proj("middle", "ws-a", "2024-03-15T00:00:00Z"),
    ];
    const result = groupByWorkspace(projects, workspaces);
    expect(result.workspaces[0]!.projects.map((p) => p.id)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("sorts standalone projects by last_activity_at descending", () => {
    const projects = [
      proj("a", null, "2023-01-01T00:00:00Z"),
      proj("b", null, "2025-06-01T00:00:00Z"),
      proj("c", null, "2024-04-04T00:00:00Z"),
    ];
    const result = groupByWorkspace(projects, []);
    expect(result.standalone.map((p) => p.id)).toEqual(["b", "c", "a"]);
  });

  it("mixes grouped and standalone projects in one pass", () => {
    const workspaces = [ws("ws-a", "Alpha")];
    const projects = [
      proj("g1", "ws-a", "2024-01-01T00:00:00Z"),
      proj("s1", null, "2024-02-01T00:00:00Z"),
      proj("g2", "ws-a", "2024-03-01T00:00:00Z"),
      proj("s2", null, "2024-04-01T00:00:00Z"),
    ];
    const result = groupByWorkspace(projects, workspaces);
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]!.projects.map((p) => p.id)).toEqual(["g2", "g1"]);
    expect(result.standalone.map((p) => p.id)).toEqual(["s2", "s1"]);
  });

  it("supports numeric workspace ids", () => {
    const workspaces = [ws(1, "One"), ws(2, "Two")];
    const projects = [
      proj("p1", 1, "2024-01-01T00:00:00Z"),
      proj("p2", 2, "2024-01-02T00:00:00Z"),
      proj("p3", null, "2024-01-03T00:00:00Z"),
    ];
    const result = groupByWorkspace(projects, workspaces);
    expect(result.workspaces.map((g) => g.ws.name)).toEqual(["One", "Two"]);
    expect(result.workspaces[0]!.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(result.workspaces[1]!.projects.map((p) => p.id)).toEqual(["p2"]);
    expect(result.standalone.map((p) => p.id)).toEqual(["p3"]);
  });

  it("does not mutate the input arrays", () => {
    const workspaces = [ws("ws-a", "Alpha")];
    const projects = [
      proj("p1", "ws-a", "2024-01-01T00:00:00Z"),
      proj("p2", "ws-a", "2025-01-01T00:00:00Z"),
    ];
    const projectsCopy = projects.map((p) => ({ ...p }));
    const workspacesCopy = workspaces.map((w) => ({ ...w }));
    groupByWorkspace(projects, workspaces);
    expect(projects).toEqual(projectsCopy);
    expect(workspaces).toEqual(workspacesCopy);
  });

  it("handles Date and number values for last_activity_at", () => {
    const workspaces = [ws("ws-a", "Alpha")];
    const projects: GroupableProject[] = [
      { id: "as-date", workspace_id: "ws-a", last_activity_at: new Date("2024-01-01T00:00:00Z") },
      { id: "as-number", workspace_id: "ws-a", last_activity_at: new Date("2025-01-01T00:00:00Z").getTime() },
      { id: "as-string", workspace_id: "ws-a", last_activity_at: "2023-01-01T00:00:00Z" },
    ];
    const result = groupByWorkspace(projects, workspaces);
    expect(result.workspaces[0]!.projects.map((p) => p.id)).toEqual([
      "as-number",
      "as-date",
      "as-string",
    ]);
  });

  it("treats unparseable last_activity_at as 0 (oldest)", () => {
    const projects = [
      proj("good", null, "2024-01-01T00:00:00Z"),
      proj("garbage", null, "not-a-date"),
    ];
    const result = groupByWorkspace(projects, []);
    expect(result.standalone.map((p) => p.id)).toEqual(["good", "garbage"]);
  });
});
