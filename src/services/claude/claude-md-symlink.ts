import { existsSync, lstatSync, readlinkSync, symlinkSync } from "fs";
import { join } from "path";

const AGENTS_FILE = "AGENTS.md";
const CLAUDE_FILE = "CLAUDE.md";

/**
 * Ensure `<root>/CLAUDE.md` is a symlink to `./AGENTS.md`.
 *
 * Contract:
 *  - If `<root>/AGENTS.md` does not exist → no-op (nothing to point at; the
 *    CLI `migrate` command creates AGENTS.md explicitly).
 *  - If `<root>/CLAUDE.md` does not exist → create symlink to `./AGENTS.md`.
 *  - If `<root>/CLAUDE.md` is a symlink to `./AGENTS.md` → no-op.
 *  - If `<root>/CLAUDE.md` is a symlink to something else → warn, do nothing.
 *  - If `<root>/CLAUDE.md` is a regular file → warn, do nothing. The user is
 *    curating it manually; we never overwrite.
 *
 * Idempotent: safe to call repeatedly.
 */
export async function ensureClaudeMdSymlink(rootPath: string): Promise<void> {
  if (!rootPath) return;

  const agentsPath = join(rootPath, AGENTS_FILE);
  if (!existsSync(agentsPath)) return;

  const claudePath = join(rootPath, CLAUDE_FILE);

  let lst;
  try {
    lst = lstatSync(claudePath);
  } catch {
    lst = null;
  }

  if (!lst) {
    try {
      symlinkSync(AGENTS_FILE, claudePath);
    } catch (err) {
      console.warn(
        `[claude-md-symlink] failed to symlink ${claudePath} -> ${AGENTS_FILE}:`,
        err,
      );
    }
    return;
  }

  if (lst.isSymbolicLink()) {
    let target: string | null;
    try {
      target = readlinkSync(claudePath);
    } catch {
      target = null;
    }
    if (target === AGENTS_FILE) return;
    console.warn(
      `[claude-md-symlink] ${claudePath} is a symlink to ${target ?? "<unreadable>"} — leaving it untouched. Delete it manually if you want CLAUDE.md to track AGENTS.md.`,
    );
    return;
  }

  // Regular file — user manually curates CLAUDE.md. Never overwrite.
  console.warn(
    `[claude-md-symlink] ${claudePath} is a regular file — leaving it untouched. Delete it manually if you want CLAUDE.md to track AGENTS.md.`,
  );
}
