import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
  DEFAULT_PERMISSION_MODE,
  allowedRoots,
  decideAuto,
  extractToolPaths,
  isPathWithinRoots,
  isPermissionMode,
  modeToSdkOptions,
  normalizePermissionMode,
  parsePermissionModeField,
  resolvePermissionMode,
  flockctlRoot,
} from "../../services/permission-resolver.js";

describe("isPermissionMode / normalizePermissionMode", () => {
  it("accepts all five valid modes", () => {
    for (const m of ["default", "acceptEdits", "plan", "bypassPermissions", "auto"]) {
      expect(isPermissionMode(m)).toBe(true);
      expect(normalizePermissionMode(m)).toBe(m);
    }
  });

  it("rejects garbage", () => {
    expect(isPermissionMode("nope")).toBe(false);
    expect(normalizePermissionMode("nope")).toBeNull();
    expect(normalizePermissionMode(undefined)).toBeNull();
    expect(normalizePermissionMode(null)).toBeNull();
    expect(normalizePermissionMode(42)).toBeNull();
  });
});

describe("parsePermissionModeField", () => {
  it("undefined stays undefined (no change)", () => {
    expect(parsePermissionModeField(undefined)).toBeUndefined();
  });

  it("null / empty string clear (inherit)", () => {
    expect(parsePermissionModeField(null)).toBeNull();
    expect(parsePermissionModeField("")).toBeNull();
  });

  it("valid mode passes through", () => {
    expect(parsePermissionModeField("auto")).toBe("auto");
    expect(parsePermissionModeField("bypassPermissions")).toBe("bypassPermissions");
  });

  it("invalid value throws", () => {
    expect(() => parsePermissionModeField("nonsense")).toThrow(/permission_mode/);
  });
});

describe("resolvePermissionMode precedence", () => {
  it("defaults to auto when nothing set", () => {
    expect(resolvePermissionMode({})).toBe(DEFAULT_PERMISSION_MODE);
    expect(resolvePermissionMode({})).toBe("auto");
  });

  it("task beats chat/project/workspace", () => {
    expect(
      resolvePermissionMode({
        task: "plan",
        chat: "acceptEdits",
        project: "bypassPermissions",
        workspace: "default",
      }),
    ).toBe("plan");
  });

  it("chat beats project/workspace when task is null", () => {
    expect(
      resolvePermissionMode({
        task: null,
        chat: "acceptEdits",
        project: "plan",
        workspace: "bypassPermissions",
      }),
    ).toBe("acceptEdits");
  });

  it("project beats workspace when task+chat null", () => {
    expect(
      resolvePermissionMode({
        task: null,
        chat: null,
        project: "bypassPermissions",
        workspace: "plan",
      }),
    ).toBe("bypassPermissions");
  });

  it("falls through to workspace", () => {
    expect(
      resolvePermissionMode({ task: null, chat: null, project: null, workspace: "plan" }),
    ).toBe("plan");
  });

  it("invalid values are treated as null and skipped", () => {
    expect(
      resolvePermissionMode({
        task: "garbage" as any,
        chat: "also-bad" as any,
        project: "acceptEdits",
      }),
    ).toBe("acceptEdits");
  });
});

describe("flockctlRoot / allowedRoots", () => {
  it("flockctlRoot is ~/Flockctl", () => {
    expect(flockctlRoot()).toBe(resolve(homedir(), "Flockctl"));
  });

  it("allowedRoots always includes ~/Flockctl", () => {
    const roots = allowedRoots({});
    expect(roots).toContain(flockctlRoot());
  });

  it("allowedRoots adds workspace + project + workingDir", () => {
    const roots = allowedRoots({
      workspacePath: "/tmp/ws",
      projectPath: "/tmp/ws/proj",
      workingDir: "/tmp/ws/proj/worktree",
    });
    expect(roots).toContain("/tmp/ws");
    expect(roots).toContain("/tmp/ws/proj");
    expect(roots).toContain("/tmp/ws/proj/worktree");
  });

  it("allowedRoots deduplicates", () => {
    const roots = allowedRoots({
      workspacePath: "/tmp/dup",
      projectPath: "/tmp/dup",
    });
    expect(roots.filter((r) => r === "/tmp/dup")).toHaveLength(1);
  });

  it("allowedRoots ignores null/empty entries", () => {
    const roots = allowedRoots({
      workspacePath: null,
      projectPath: "",
      workingDir: undefined,
    });
    expect(roots).toEqual([flockctlRoot()]);
  });
});

describe("isPathWithinRoots", () => {
  const roots = ["/tmp/ws/proj", "/home/x/Flockctl"];

  it("matches exact root", () => {
    expect(isPathWithinRoots("/tmp/ws/proj", roots)).toBe(true);
  });

  it("matches nested child", () => {
    expect(isPathWithinRoots("/tmp/ws/proj/src/file.ts", roots)).toBe(true);
  });

  it("rejects outside paths", () => {
    expect(isPathWithinRoots("/etc/passwd", roots)).toBe(false);
    expect(isPathWithinRoots("/tmp/ws/other", roots)).toBe(false);
  });

  it("rejects empty path", () => {
    expect(isPathWithinRoots("", roots)).toBe(false);
  });

  it("rejects sibling that shares prefix", () => {
    expect(isPathWithinRoots("/tmp/ws/proj-evil/x", roots)).toBe(false);
  });
});

describe("extractToolPaths", () => {
  it("Read uses file_path", () => {
    expect(extractToolPaths("Read", { file_path: "/a/b" })).toEqual(["/a/b"]);
  });

  it("Write/Edit uses file_path", () => {
    expect(extractToolPaths("Write", { file_path: "/a" })).toEqual(["/a"]);
    expect(extractToolPaths("Edit", { file_path: "/b" })).toEqual(["/b"]);
  });

  it("NotebookEdit falls back to notebook_path", () => {
    expect(extractToolPaths("NotebookEdit", { notebook_path: "/a.ipynb" })).toEqual([
      "/a.ipynb",
    ]);
  });

  it("Glob/Grep use path", () => {
    expect(extractToolPaths("Glob", { path: "/tmp" })).toEqual(["/tmp"]);
    expect(extractToolPaths("Grep", { path: "/tmp" })).toEqual(["/tmp"]);
  });

  it("MultiEdit uses file_path", () => {
    expect(extractToolPaths("MultiEdit", { file_path: "/multi" })).toEqual(["/multi"]);
  });

  it("LS uses path", () => {
    expect(extractToolPaths("LS", { path: "/lsdir" })).toEqual(["/lsdir"]);
  });

  it("NotebookRead falls back to notebook_path", () => {
    expect(extractToolPaths("NotebookRead", { notebook_path: "/n.ipynb" })).toEqual(["/n.ipynb"]);
  });

  it("unknown tools return []", () => {
    expect(extractToolPaths("Bash", { command: "ls" })).toEqual([]);
  });

  it("missing paths return []", () => {
    expect(extractToolPaths("Read", {})).toEqual([]);
  });
});

describe("decideAuto", () => {
  const roots = ["/tmp/ws/proj"];

  it("read-only tools always allow", () => {
    expect(decideAuto("Read", { file_path: "/etc/passwd" }, roots).behavior).toBe("allow");
    expect(decideAuto("Grep", { path: "/nowhere" }, roots).behavior).toBe("allow");
    expect(decideAuto("Glob", {}, roots).behavior).toBe("allow");
    expect(decideAuto("LS", {}, roots).behavior).toBe("allow");
  });

  it("Write inside scope allows", () => {
    const d = decideAuto("Write", { file_path: "/tmp/ws/proj/src/x.ts" }, roots);
    expect(d.behavior).toBe("allow");
  });

  it("Write outside scope prompts", () => {
    const d = decideAuto("Write", { file_path: "/etc/hosts" }, roots);
    expect(d.behavior).toBe("prompt");
    expect(d.reason).toMatch(/outside/);
  });

  it("Write with no path prompts", () => {
    expect(decideAuto("Write", {}, roots).behavior).toBe("prompt");
  });

  it("Bash always prompts", () => {
    expect(decideAuto("Bash", { command: "echo hi" }, roots).behavior).toBe("prompt");
  });

  it("unknown tool prompts", () => {
    expect(decideAuto("WeirdTool", {}, roots).behavior).toBe("prompt");
  });

  it("respects multiple roots", () => {
    const multi = ["/tmp/a", "/tmp/b"];
    expect(decideAuto("Write", { file_path: "/tmp/a/x" }, multi).behavior).toBe("allow");
    expect(decideAuto("Write", { file_path: "/tmp/b/x" }, multi).behavior).toBe("allow");
    expect(decideAuto("Write", { file_path: "/tmp/c/x" }, multi).behavior).toBe("prompt");
  });
});

describe("modeToSdkOptions", () => {
  it("bypassPermissions sets the flag and skips canUseTool", () => {
    const o = modeToSdkOptions("bypassPermissions");
    expect(o.permissionMode).toBe("bypassPermissions");
    expect(o.allowDangerouslySkipPermissions).toBe(true);
    expect(o.useCanUseTool).toBe(false);
  });

  it("acceptEdits passes through, no canUseTool", () => {
    expect(modeToSdkOptions("acceptEdits")).toMatchObject({
      permissionMode: "acceptEdits",
      useCanUseTool: false,
    });
  });

  it("plan passes through, no canUseTool", () => {
    expect(modeToSdkOptions("plan")).toMatchObject({
      permissionMode: "plan",
      useCanUseTool: false,
    });
  });

  it("default → SDK default + canUseTool", () => {
    expect(modeToSdkOptions("default")).toMatchObject({
      permissionMode: "default",
      useCanUseTool: true,
    });
  });

  it("auto → SDK default + canUseTool (for path-scoped allow)", () => {
    expect(modeToSdkOptions("auto")).toMatchObject({
      permissionMode: "default",
      useCanUseTool: true,
    });
  });
});

describe("integration: extractToolPaths + decideAuto inside flockctlRoot", () => {
  it("auto-allows writes under ~/Flockctl", () => {
    const roots = allowedRoots({});
    const target = join(flockctlRoot(), "subdir", "x.ts");
    const d = decideAuto("Write", { file_path: target }, roots);
    expect(d.behavior).toBe("allow");
  });
});
