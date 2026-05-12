import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "fs";
import { mkdir, writeFile, rename, unlink } from "fs/promises";
import { dirname } from "path";
import { randomBytes } from "crypto";

/**
 * Idempotent `mkdir -p`. Creates `dir` (and any missing parents) when it does
 * not already exist; no-op when it already does.
 *
 * Why a wrapper rather than calling `mkdirSync(dir, { recursive: true })`
 * everywhere: 50+ inline copies of that two-token expression were scattered
 * across `src/routes/*` and `src/services/*`. Centralising lets a future
 * change (e.g. adding a path-safety check, switching to async, capturing
 * EEXIST silently when the racey peer wins) land in one place.
 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Atomic write: write to a sibling temp file, then rename onto the final path.
 * Renames within the same filesystem are atomic on POSIX, so a concurrent
 * reader either sees the old contents (before the rename) or the new contents
 * (after) — never a partial write.
 *
 * The temp suffix is randomised so two concurrent atomic writes targeting the
 * same final path don't collide on each other's tmp file. The leftover tmp
 * file is unlinked on a failed write so a partially-written .tmp doesn't
 * pollute the directory.
 *
 * Replaces five hand-rolled copies (services/project-import.ts,
 * services/claude/agents-io.ts, services/project-config.ts,
 * services/workspace-config.ts, services/templates.ts) plus a handful of
 * inline tmp+rename blocks in services/claude/skills-sync.ts and mcp-sync.ts.
 *
 * Optional `mode` is forwarded to `writeFileSync` so callers that need
 * 0o600 (master keys, rc files, secret stores) can express that without an
 * after-the-fact `chmodSync`.
 */
export function writeFileAtomic(
  path: string,
  content: string,
  opts: { mode?: number } = {},
): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, {
      encoding: "utf-8",
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    });
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup. If the tmp file never landed on disk this is a
    // no-op; if it did, removing it stops the directory from accumulating
    // half-written `.tmp` artefacts after repeated failures.
    try {
      unlinkSync(tmp);
    } catch {
      /* ignored — tmp may not have been created */
    }
    throw err;
  }
}

/**
 * Async sibling of {@link writeFileAtomic} — same atomic tmp+rename
 * pattern but routed through `fs/promises` so the event loop isn't
 * blocked while the kernel flushes large frontmatter blobs. Used from
 * `writeMdAsync` and any other route-level write path that already
 * sits inside an async handler. Audit-round-7 finding.
 */
export async function writeFileAtomicAsync(
  path: string,
  content: string,
  opts: { mode?: number } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, content, {
      encoding: "utf-8",
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    });
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* ignored — tmp may not have been created */
    }
    throw err;
  }
}
