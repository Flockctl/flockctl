import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TreeContextMenu } from "@/components/file-tree/TreeContextMenu";

/**
 * Unit tests for the right-click context menu primitive.
 *
 * The boundaries we exercise:
 *   - Folder rows surface "New File" / "New Folder"; file rows do not.
 *   - "Rename" / "Delete" / "Copy Path" / "Copy Relative Path" appear
 *     for both kinds.
 *   - "Reveal in Finder" is conditional on the active server being the
 *     local daemon AND the caller having an absolute path; missing
 *     either removes the item.
 *   - Each item invokes its callback with the row's path. Copy items
 *     write to `navigator.clipboard.writeText` (or the
 *     `document.execCommand` fallback when clipboard is missing).
 *
 * Radix's ContextMenu uses a `<ContextMenuTrigger>` that opens on
 * `contextmenu` (right-click) — not click. We fire that event directly
 * via `fireEvent.contextMenu` rather than `userEvent`, because user-
 * event's pointer pipeline doesn't open Radix's portal under jsdom in
 * a single tick.
 */

beforeEach(() => {
  // Clipboard mock — `navigator.clipboard.writeText` is the canonical
  // path the menu uses; tests stub it so we can assert on the value
  // without polluting the test runner's clipboard.
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("<TreeContextMenu />", () => {
  it("shows folder-only items (New File / New Folder) for kind='dir'", async () => {
    render(
      <TreeContextMenu kind="dir" path="src" isLocalServer={true}>
        <div data-testid="trigger">trigger</div>
      </TreeContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("trigger"));

    expect(
      await screen.findByTestId("tree-context-menu-new-file"),
    ).toBeTruthy();
    expect(screen.getByTestId("tree-context-menu-new-folder")).toBeTruthy();
    expect(screen.getByTestId("tree-context-menu-rename")).toBeTruthy();
    expect(screen.getByTestId("tree-context-menu-delete")).toBeTruthy();
    expect(screen.getByTestId("tree-context-menu-copy-path")).toBeTruthy();
    expect(
      screen.getByTestId("tree-context-menu-copy-relative-path"),
    ).toBeTruthy();
  });

  it("hides New File / New Folder for kind='file'", async () => {
    render(
      <TreeContextMenu
        kind="file"
        path="src/foo.ts"
        isLocalServer={true}
      >
        <div data-testid="trigger">trigger</div>
      </TreeContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("trigger"));

    // Wait for the menu to open by querying for an always-present item
    // first, then assert the folder items are absent.
    await screen.findByTestId("tree-context-menu-rename");
    expect(screen.queryByTestId("tree-context-menu-new-file")).toBeNull();
    expect(screen.queryByTestId("tree-context-menu-new-folder")).toBeNull();
  });

  it("hides Reveal in Finder when the active server is remote", async () => {
    render(
      <TreeContextMenu
        kind="file"
        path="src/foo.ts"
        absolutePath="/Users/dev/proj/src/foo.ts"
        isLocalServer={false}
      >
        <div data-testid="trigger">trigger</div>
      </TreeContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("trigger"));

    await screen.findByTestId("tree-context-menu-copy-path");
    expect(screen.queryByTestId("tree-context-menu-reveal")).toBeNull();
  });

  it("hides Reveal in Finder when the absolute path is unknown", async () => {
    render(
      <TreeContextMenu
        kind="file"
        path="src/foo.ts"
        // absolutePath omitted on purpose — read-only embedding
        isLocalServer={true}
      >
        <div data-testid="trigger">trigger</div>
      </TreeContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("trigger"));

    await screen.findByTestId("tree-context-menu-copy-path");
    expect(screen.queryByTestId("tree-context-menu-reveal")).toBeNull();
  });

  it("invokes onRename / onDelete with the row path", async () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();

    render(
      <TreeContextMenu
        kind="file"
        path="src/foo.ts"
        onRename={onRename}
        onDelete={onDelete}
        isLocalServer={true}
      >
        <div data-testid="trigger">trigger</div>
      </TreeContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("trigger"));

    const rename = await screen.findByTestId("tree-context-menu-rename");
    fireEvent.click(rename);
    expect(onRename).toHaveBeenCalledWith("src/foo.ts");

    // Re-open the menu — Radix closes on item activation, so we need a
    // second contextMenu before the next click resolves.
    fireEvent.contextMenu(screen.getByTestId("trigger"));
    const del = await screen.findByTestId("tree-context-menu-delete");
    fireEvent.click(del);
    expect(onDelete).toHaveBeenCalledWith("src/foo.ts");
  });

  it("invokes onNewFile / onNewFolder with the parent path on a folder row", async () => {
    const onNewFile = vi.fn();
    const onNewFolder = vi.fn();

    render(
      <TreeContextMenu
        kind="dir"
        path="src/components"
        onNewFile={onNewFile}
        onNewFolder={onNewFolder}
        isLocalServer={true}
      >
        <div data-testid="trigger">trigger</div>
      </TreeContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("trigger"));
    fireEvent.click(await screen.findByTestId("tree-context-menu-new-file"));
    expect(onNewFile).toHaveBeenCalledWith("src/components");

    fireEvent.contextMenu(screen.getByTestId("trigger"));
    fireEvent.click(
      await screen.findByTestId("tree-context-menu-new-folder"),
    );
    expect(onNewFolder).toHaveBeenCalledWith("src/components");
  });

  it("Copy Path writes the absolute path to the clipboard when known", async () => {
    render(
      <TreeContextMenu
        kind="file"
        path="src/foo.ts"
        absolutePath="/Users/dev/proj/src/foo.ts"
        isLocalServer={true}
      >
        <div data-testid="trigger">trigger</div>
      </TreeContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("trigger"));
    fireEvent.click(await screen.findByTestId("tree-context-menu-copy-path"));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "/Users/dev/proj/src/foo.ts",
    );
  });

  it("Copy Relative Path writes the project-relative path", async () => {
    render(
      <TreeContextMenu
        kind="file"
        path="src/foo.ts"
        absolutePath="/Users/dev/proj/src/foo.ts"
        isLocalServer={true}
      >
        <div data-testid="trigger">trigger</div>
      </TreeContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("trigger"));
    fireEvent.click(
      await screen.findByTestId("tree-context-menu-copy-relative-path"),
    );

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("src/foo.ts");
  });

  it("Copy Path falls back to the relative path when no absolute is provided", async () => {
    render(
      <TreeContextMenu kind="file" path="src/foo.ts" isLocalServer={true}>
        <div data-testid="trigger">trigger</div>
      </TreeContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("trigger"));
    fireEvent.click(await screen.findByTestId("tree-context-menu-copy-path"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("src/foo.ts");
  });
});
