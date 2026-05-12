/**
 * Extension → (lucide icon, tailwind colour-class) mapping for file-tree
 * rows.
 *
 * Why a separate module instead of inlining inside `TreeNode`:
 *   - The mapping is pure data, exercised by a unit test
 *     (`__tests__/components/file-icon.test.ts`) without booting a
 *     React render tree.
 *   - Keeping the table in one place means the e2e screenshot tests for
 *     the file tree only need to be re-baselined here when the visual
 *     contract for "what colour is a .ts file" shifts.
 *
 * Coverage rule: top-15 file extensions Flockctl actually opens
 * (TS/JS source, JSON config, markdown, YAML, CSS, HTML, three popular
 * compiled languages, shell, TOML, lockfiles, dotenvs) plus a small
 * basename allowlist for files that have NO extension but a strong
 * conventional identity (Makefile, Dockerfile, .gitignore, .env). Anything
 * outside the table falls through to the neutral `File` icon — picking a
 * "best guess" icon for unknown extensions creates more visual noise than
 * it removes.
 *
 * Colours are tailwind utility classes, not raw hex, so dark/light themes
 * compose with the rest of the UI without per-icon overrides. The
 * `text-muted-foreground` fallback keeps unknown files from popping out
 * relative to known ones.
 */

import {
  Braces,
  File as FileIcon,
  FileCode,
  FileText,
  KeyRound,
  Lock,
  type LucideIcon,
  Palette,
  Terminal,
} from "lucide-react";

export interface FileIconSpec {
  icon: LucideIcon;
  /**
   * Tailwind colour class applied to the icon (`text-...`). Kept as a
   * string instead of a CSS variable so consumers can pass it directly
   * to `className` without an extra wrapper.
   */
  colorClass: string;
}

/**
 * Top-15 extensions. Order is alphabetical for grep-ability, NOT
 * priority — extensions don't overlap so first-match doesn't apply.
 */
const EXT_ICONS: Record<string, FileIconSpec> = {
  css: { icon: Palette, colorClass: "text-blue-300" },
  env: { icon: KeyRound, colorClass: "text-yellow-300" },
  go: { icon: FileCode, colorClass: "text-cyan-500" },
  html: { icon: FileCode, colorClass: "text-orange-400" },
  js: { icon: FileCode, colorClass: "text-yellow-500" },
  json: { icon: Braces, colorClass: "text-orange-500" },
  jsx: { icon: FileCode, colorClass: "text-yellow-400" },
  lock: { icon: Lock, colorClass: "text-muted-foreground" },
  md: { icon: FileText, colorClass: "text-muted-foreground" },
  py: { icon: FileCode, colorClass: "text-green-500" },
  rs: { icon: FileCode, colorClass: "text-orange-600" },
  sh: { icon: Terminal, colorClass: "text-green-400" },
  toml: { icon: FileText, colorClass: "text-orange-500" },
  ts: { icon: FileCode, colorClass: "text-blue-500" },
  tsx: { icon: FileCode, colorClass: "text-blue-400" },
  yaml: { icon: FileText, colorClass: "text-purple-500" },
  yml: { icon: FileText, colorClass: "text-purple-500" },
};

/**
 * Basename allowlist — files identified by their full filename instead
 * of an extension. Keys are matched case-sensitively because the
 * conventional spelling matters: `Makefile` not `makefile`.
 */
const BASENAME_ICONS: Record<string, FileIconSpec> = {
  Dockerfile: { icon: FileCode, colorClass: "text-blue-400" },
  Makefile: { icon: Terminal, colorClass: "text-orange-500" },
  ".env": { icon: KeyRound, colorClass: "text-yellow-300" },
  ".gitignore": { icon: FileText, colorClass: "text-muted-foreground" },
};

/**
 * Neutral fallback. Returned (not exported) so the test can assert it
 * by reference — kept as a constant rather than building a fresh object
 * on each call.
 */
const FALLBACK: FileIconSpec = {
  icon: FileIcon,
  colorClass: "text-muted-foreground",
};

/**
 * Resolve a filename to an icon + colour-class pair.
 *
 * Resolution order:
 *   1. Exact basename match (handles `Makefile`, `.gitignore`).
 *   2. Extension after the LAST dot, lowercased (handles `Foo.TS` and
 *      `archive.tar.gz` → `gz` falls through to the fallback rather
 *      than trying to be clever about compound extensions).
 *   3. Neutral `File` fallback.
 *
 * The empty-string and dotless cases both return the fallback — we
 * never throw, because the function is hot-path code on every tree row
 * render and a thrown error would crash the whole tree.
 */
export function fileIcon(name: string): FileIconSpec {
  if (!name) return FALLBACK;

  // Exact basename takes priority over extension. `.env` is BOTH a
  // basename and (after dot-stripping) an extension; handling the
  // basename first makes the precedence explicit.
  const exact = BASENAME_ICONS[name];
  if (exact) return exact;

  // `Foo.tsx` → `tsx`; `Makefile` → "" (no dot) → fallback.
  // We use `lastIndexOf` instead of split to avoid allocating an array
  // for the common file-tree-row case where this fires on every render.
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return FALLBACK;

  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_ICONS[ext] ?? FALLBACK;
}
