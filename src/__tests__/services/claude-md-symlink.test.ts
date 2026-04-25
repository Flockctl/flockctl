import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ensureClaudeMdSymlink } from "../../services/claude/claude-md-symlink.js";

const tmpBase = join(tmpdir(), `flockctl-claude-md-symlink-${process.pid}`);

beforeEach(() => {
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  mkdirSync(tmpBase, { recursive: true });
});

afterAll(() => {
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

function makeRoot(name: string, opts: { agents?: string | null } = { agents: "" }): string {
  const root = join(tmpBase, name);
  mkdirSync(root, { recursive: true });
  if (opts.agents !== null && opts.agents !== undefined) {
    writeFileSync(join(root, "AGENTS.md"), opts.agents);
  }
  return root;
}

describe("ensureClaudeMdSymlink", () => {
  it("claude_symlink_creator_idempotent — call twice, assert single symlink, same target", async () => {
    const root = makeRoot("idempotent", { agents: "# rules\n" });
    const link = join(root, "CLAUDE.md");

    await ensureClaudeMdSymlink(root);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("AGENTS.md");
    const inode1 = lstatSync(link).ino;

    await ensureClaudeMdSymlink(root);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("AGENTS.md");
    const inode2 = lstatSync(link).ino;

    expect(inode2).toBe(inode1);
  });

  it("claude_symlink_creator_preserves_existing_symlink — pre-create CLAUDE.md as symlink to AGENTS.md, call ensure, assert unchanged", async () => {
    const root = makeRoot("preserve-link", { agents: "# rules\n" });
    const link = join(root, "CLAUDE.md");
    symlinkSync("AGENTS.md", link);
    const inoBefore = lstatSync(link).ino;
    const targetBefore = readlinkSync(link);

    await ensureClaudeMdSymlink(root);

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(targetBefore);
    expect(lstatSync(link).ino).toBe(inoBefore);
  });

  it("claude_symlink_creator_does_not_overwrite_existing_file — pre-create CLAUDE.md as regular file, call ensure, assert content unchanged", async () => {
    const root = makeRoot("preserve-file", { agents: "# rules\n" });
    const claudePath = join(root, "CLAUDE.md");
    writeFileSync(claudePath, "MANUAL");

    await ensureClaudeMdSymlink(root);

    const lst = lstatSync(claudePath);
    expect(lst.isSymbolicLink()).toBe(false);
    expect(lst.isFile()).toBe(true);
    expect(readFileSync(claudePath, "utf-8")).toBe("MANUAL");
  });

  it("does nothing when AGENTS.md is missing", async () => {
    const root = makeRoot("no-agents", { agents: null });
    const link = join(root, "CLAUDE.md");

    await ensureClaudeMdSymlink(root);

    expect(existsSync(link)).toBe(false);
  });

  it("leaves a symlink pointing elsewhere untouched", async () => {
    const root = makeRoot("wrong-link", { agents: "# rules\n" });
    const link = join(root, "CLAUDE.md");
    symlinkSync("SOMEWHERE_ELSE.md", link);

    await ensureClaudeMdSymlink(root);

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("SOMEWHERE_ELSE.md");
  });
});
