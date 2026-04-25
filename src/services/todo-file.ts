/**
 * TODO.md file helpers — one plain Markdown file lives at the root of every
 * project and every workspace directory. Unlike AGENTS.md, it is NOT merged
 * or reconciled — it is simply a flat, user-editable notepad that the UI can
 * read and write. The seed template is only written when the file does not
 * already exist, so we never clobber human edits on creation.
 *
 * Scope is intentionally tiny: load, save, init. No overlays, no caching.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export const TODO_FILE_NAME = "TODO.md";

/** Hard cap so a runaway editor or paste doesn't bloat disk / WS events.
 *  Matches the AGENTS.md limit for consistency. */
export const TODO_FILE_MAX_BYTES = 256 * 1024;

/** Returned when a project/workspace row has no path recorded — lets the
 *  routes respond with the same empty-shape contract instead of throwing. */
export const EMPTY_TODO: TodoFileContent = { content: "", path: "" };

export interface TodoFileContent {
  content: string;
  /** Absolute filesystem path to the TODO.md. Empty when the caller had no
   *  root path; callers should treat "" as "not applicable". */
  path: string;
}

/** Default seed written on first init. Kept short and in English per the
 *  project-wide "English only" rule. */
export const DEFAULT_TODO_TEMPLATE = `# TODO

Track work-in-progress notes, follow-ups, and reminders here. Edited directly
from the Flockctl UI (project / workspace detail page → "TODO") or from any
editor — this file lives at the root of the directory.

## Open

- [ ] Replace this placeholder with your first item

## Done

`;

function todoPath(rootPath: string): string {
  return join(rootPath, TODO_FILE_NAME);
}

/** Read TODO.md from disk. Returns `{ content: "", path }` when the file
 *  does not exist so the UI can distinguish "root missing" (path === "") from
 *  "file not yet created" (path set, content empty). */
export function loadTodoFile(rootPath: string): TodoFileContent {
  if (!rootPath) return EMPTY_TODO;
  const p = todoPath(rootPath);
  if (!existsSync(p)) return { content: "", path: p };
  try {
    return { content: readFileSync(p, "utf-8"), path: p };
  } catch {
    // Unreadable file (permissions, device error) — behave like absent so the
    // UI can still open its editor and offer to rewrite it.
    return { content: "", path: p };
  }
}

/** Write TODO.md to disk, overwriting any existing content. Assumes the
 *  root directory already exists (project/workspace creation guarantees it). */
export function saveTodoFile(rootPath: string, content: string): TodoFileContent {
  const p = todoPath(rootPath);
  writeFileSync(p, content, "utf-8");
  return { content, path: p };
}

/**
 * Idempotent initializer — writes DEFAULT_TODO_TEMPLATE if TODO.md is
 * absent. Never overwrites an existing file. Returns true when a new file
 * was written, false when one was already present. Any filesystem error is
 * swallowed (best-effort during project/workspace creation).
 */
export function initTodoFile(rootPath: string): boolean {
  if (!rootPath) return false;
  const p = todoPath(rootPath);
  if (existsSync(p)) return false;
  try {
    writeFileSync(p, DEFAULT_TODO_TEMPLATE, "utf-8");
    return true;
  } catch {
    // Best-effort: a missing parent dir or readonly fs shouldn't fail
    // project/workspace creation over a convenience file.
    return false;
  }
}
