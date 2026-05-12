import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync } from "fs";
import { join, resolve, dirname, relative, sep } from "path";
import { execSync, execFileSync } from "child_process";
import { globSync } from "glob";
import { z } from "zod";
import { getFlockctlHome } from "../config/index.js";

// Dangerous commands that could escape sandbox or damage the system
const BLOCKED_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(?![\w])/,  // rm -rf / or rm /
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  />\s*\/dev\/sd/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bsystemctl\s+(start|stop|restart|enable|disable)\b/,
  /\blaunchctl\s+(load|unload|remove)\b/,
  /\bchmod\s+[0-7]*\s+\/(?![\w])/,   // chmod on root paths
  /\bchown\s+.*\s+\/(?![\w])/,        // chown on root paths
];

function isCommandBlocked(command: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked: command matches dangerous pattern ${pattern}`;
    }
  }
  return null;
}

/**
 * Minimal shape of an error thrown by `execSync` / `execFileSync` when the
 * subprocess exits non-zero. Node's type does not export it directly, so we
 * narrow at the catch boundary with this interface plus a tiny type guard.
 */
interface SubprocessError {
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  message?: string;
}

function asSubprocessError(e: unknown): SubprocessError {
  return (e && typeof e === "object" ? e : {}) as SubprocessError;
}

// ─── Read tool: mtime+size-keyed line cache ─────────────────────────────
//
// Agents typically Read the same file 2–3 times within a single turn (the
// Claude harness fans out tool calls speculatively; a sub-agent often
// re-reads to look at a different range). Each re-read previously paid:
//   1. readFileSync (sync disk read)
//   2. content.split("\n") (linear; expensive for big files)
//
// The cache below memoises the split lines keyed by `(absPath, mtimeMs,
// size)`. A write to the file (by any tool, by an external editor, or by
// the agent's own Edit/Write) bumps mtime and the next Read sees a cache
// miss — so the cache is correct under concurrent edits without explicit
// invalidation.
//
// Bounded by entry count AND total line count to keep memory predictable.
// LRU eviction via Map insertion order — a delete-then-set "refreshes" an
// entry's position.
//
// Pattern mirrors `fs-gitignore.ts` (TTL+size cap) and `templates.ts`
// (mtime+size cap).
interface ReadCacheEntry {
  mtimeMs: number;
  size: number;
  lines: string[];
}
const READ_CACHE_MAX_ENTRIES = 128;
const READ_CACHE_MAX_TOTAL_LINES = 200_000;
const readCache = new Map<string, ReadCacheEntry>();
let readCacheTotalLines = 0;

function readFileLinesCached(absPath: string): string[] | null {
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const cached = readCache.get(absPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    // Refresh LRU position.
    readCache.delete(absPath);
    readCache.set(absPath, cached);
    return cached.lines;
  }
  // Miss → read fresh, split once, cache.
  const content = readFileSync(absPath, "utf-8");
  const lines = content.split("\n");
  if (cached) readCacheTotalLines -= cached.lines.length;
  readCache.set(absPath, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    lines,
  });
  readCacheTotalLines += lines.length;
  // Evict by entry count.
  while (readCache.size > READ_CACHE_MAX_ENTRIES) {
    const oldestKey = readCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = readCache.get(oldestKey)!;
    readCacheTotalLines -= oldest.lines.length;
    readCache.delete(oldestKey);
  }
  // Evict by total line count.
  while (readCacheTotalLines > READ_CACHE_MAX_TOTAL_LINES && readCache.size > 0) {
    const oldestKey = readCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = readCache.get(oldestKey)!;
    readCacheTotalLines -= oldest.lines.length;
    readCache.delete(oldestKey);
  }
  return lines;
}

function invalidateReadCache(absPath: string): void {
  const cached = readCache.get(absPath);
  if (cached) {
    readCacheTotalLines -= cached.lines.length;
    readCache.delete(absPath);
  }
}

/** @internal — test seam. */
export function __resetReadCacheForTests(): void {
  readCache.clear();
  readCacheTotalLines = 0;
}

// Input schema for the AskUserQuestion tool. Exported as a Zod schema so the
// session interception layer can reuse it for runtime validation.
//
// Divergence from the upstream Claude Code harness: the harness accepts up to
// 4 options per question and supports a `questions[]` outer array (multiple
// questions in one call). Flockctl's M05 model is "one question at a time,
// oldest first" — so we collapse to a flat single-question shape with up to
// 20 options, and tolerate harness-style payloads on the way in:
//   - if `{ questions: [...] }` is present, we use the first element
//   - both `multi_select` (snake_case) and `multiSelect` (camelCase) are accepted
const askUserQuestionOptionSchema = z.object({
  label: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  preview: z.string().max(2000).optional(),
});

export const askUserQuestionInputSchema = z.object({
  question: z.string().min(1).max(2000),
  header: z.string().max(40).optional(),
  multi_select: z.boolean().optional().default(false),
  options: z.array(askUserQuestionOptionSchema).max(20).optional(),
});

export type ParsedAskUserQuestion = z.infer<typeof askUserQuestionInputSchema>;

// JSON schema sent to Anthropic's tool API — must mirror the Zod shape above.
// Kept as a separate value because the Anthropic SDK expects a plain JSON
// schema object, not a Zod schema instance.
const askUserQuestionJsonSchema = {
  type: "object" as const,
  properties: {
    question: { type: "string" as const, minLength: 1, maxLength: 2000 },
    header: { type: "string" as const, maxLength: 40 },
    multi_select: { type: "boolean" as const },
    options: {
      type: "array" as const,
      maxItems: 20,
      items: {
        type: "object" as const,
        properties: {
          label: { type: "string" as const, minLength: 1, maxLength: 200 },
          description: { type: "string" as const, maxLength: 500 },
          preview: { type: "string" as const, maxLength: 2000 },
        },
        required: ["label"],
      },
    },
  },
  required: ["question"],
};

/**
 * Parse + validate an AskUserQuestion tool input payload.
 *
 * - Strips unknown top-level fields (Zod default `.strip()` mode).
 * - If the payload is a harness-style `{ questions: [...] }`, uses the first
 *   element.
 * - Normalizes `multiSelect` (camelCase) → `multi_select` (snake_case).
 * - Drops empty `options: []` so callers can treat absence and emptiness the
 *   same (free-form text answer).
 *
 * Returns a discriminated union so callers can handle the failure path
 * without throwing.
 */
export function parseAskUserQuestionInput(
  raw: unknown
):
  | { ok: true; value: ParsedAskUserQuestion }
  | { ok: false; error: z.ZodError } {
  let payload: unknown = raw;

  // Harness sometimes wraps as { questions: [{...}] } — collapse to the first.
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Array.isArray((payload as { questions?: unknown }).questions) &&
    (payload as { questions: unknown[] }).questions.length > 0
  ) {
    payload = (payload as { questions: unknown[] }).questions[0];
  }

  // Normalize camelCase `multiSelect` → snake_case `multi_select`. Only
  // promote when the snake_case key isn't already present.
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "multiSelect" in (payload as Record<string, unknown>) &&
    !("multi_select" in (payload as Record<string, unknown>))
  ) {
    const src = payload as Record<string, unknown>;
    payload = { ...src, multi_select: src.multiSelect };
  }

  const result = askUserQuestionInputSchema.safeParse(payload);
  if (!result.success) return { ok: false, error: result.error };

  // Drop empty options entirely — callers should not need to distinguish
  // "no options field" from "empty options array".
  const value = result.data;
  if (value.options && value.options.length === 0) {
    const { options: _drop, ...rest } = value;
    return { ok: true, value: rest as ParsedAskUserQuestion };
  }
  return { ok: true, value };
}

// Tool definitions for Anthropic API (tool_use)
export function getAgentTools(workingDir?: string) {
  const cwd = workingDir ?? getFlockctlHome();
  return [
    {
      name: "Read",
      description: "Read the contents of a file. All paths are relative to the workspace root. Supports optional line range.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "File path relative to workspace root" },
          startLine: { type: "integer", description: "Optional: first line to read (1-based)" },
          endLine: { type: "integer", description: "Optional: last line to read (1-based)" },
        },
        required: ["path"],
      },
    },
    {
      name: "Write",
      description: "Write content to a file. Creates parent directories if needed. Use for creating new files or fully replacing file content.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "File path relative to workspace root" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "Edit",
      description: "Replace an exact string in a file with new content. The oldString must match exactly one occurrence. Use for surgical edits.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "File path relative to workspace root" },
          oldString: { type: "string", description: "Exact text to find (must be unique in file)" },
          newString: { type: "string", description: "Replacement text" },
        },
        required: ["path", "oldString", "newString"],
      },
    },
    {
      name: "MultiEdit",
      description: "Apply multiple edits to a single file atomically. Each edit replaces oldString with newString. All edits are applied sequentially.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "File path relative to workspace root" },
          edits: {
            type: "array",
            description: "Array of {oldString, newString} pairs to apply",
            items: {
              type: "object",
              properties: {
                oldString: { type: "string" },
                newString: { type: "string" },
              },
              required: ["oldString", "newString"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
    {
      name: "Bash",
      description: `Execute a shell command in the workspace directory (${cwd}). All commands run with cwd set to the workspace. You can run npm, git, make, curl, node, python, etc. Timeout defaults to 120s.`,
      input_schema: {
        type: "object" as const,
        properties: {
          command: { type: "string", description: "Shell command to run" },
          timeout: { type: "integer", description: "Timeout in ms (default: 120000)" },
        },
        required: ["command"],
      },
    },
    {
      name: "Grep",
      description: "Search for a regex pattern in files. Returns matching lines with file paths and line numbers. Searches within the workspace only.",
      input_schema: {
        type: "object" as const,
        properties: {
          pattern: { type: "string", description: "Regex pattern to search" },
          path: { type: "string", description: "Directory or file to search in (default: workspace root)" },
          include: { type: "string", description: "File glob pattern to include (e.g. *.ts)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "Glob",
      description: "Find files matching a glob pattern within the workspace. Returns list of relative file paths.",
      input_schema: {
        type: "object" as const,
        properties: {
          pattern: { type: "string", description: "Glob pattern (e.g. **/*.ts, src/**/*.tsx)" },
          path: { type: "string", description: "Base directory relative to workspace (default: .)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "ListDir",
      description: "List contents of a directory. Returns names with '/' suffix for directories. Useful for exploring project structure.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Directory path relative to workspace root (default: .)" },
        },
        required: [],
      },
    },
    {
      name: "Delete",
      description: "Delete a file or directory (recursively). Use with care.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "File or directory path relative to workspace root" },
        },
        required: ["path"],
      },
    },
    {
      name: "AskUserQuestion",
      description: "Ask the user an open-ended clarification question that cannot be answered by calling another tool. Use sparingly — only when progress is blocked on information only the user can provide.",
      input_schema: askUserQuestionJsonSchema,
    },
  ];
}

// Tool execution. `input` is typed loosely as `any` because the
// SDK callback shape is itself unstable across versions and the
// per-tool switch below performs runtime checks (`String(...)`,
// `Array.isArray(...)`) on each accessed field — strict narrowing
// here would require duplicating every tool's Zod schema in the type
// system without runtime benefit. The audit-round-8 hardening of
// `tool-format.ts` (`rawInput: unknown` + parseToolInput narrowing)
// covers the same surface from the display side.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function executeToolCall(
  name: string,
  input: any,
  workingDir?: string,
  _signal?: AbortSignal,
): string {
  const cwd = workingDir ?? getFlockctlHome();
  const cwdResolved = resolve(cwd);
  const resolvePath = (p: string) => resolve(cwd, p);

  // Safety: don't allow escaping the working directory.
  // Use a true separator-boundary check; a prefix-only check would let
  // `cwd="/a/ws"` accept `/a/ws-evil/...` because the string starts the same.
  const safePath = (p: string) => {
    const abs = resolve(cwd, p);
    if (abs !== cwdResolved && !abs.startsWith(cwdResolved + sep)) {
      throw new Error(`Path '${p}' is outside working directory`);
    }
    return abs;
  };

  switch (name) {
    case "Read": {
      const abs = safePath(input.path);
      // Cached read — mtime+size key. Agents re-read the same file 2–3×
      // per turn; without this each Read paid sync disk + split(\n) work.
      const lines = readFileLinesCached(abs);
      if (lines === null) return `Error: File not found: ${input.path}`;
      const start = (input.startLine ?? 1) - 1;
      const end = input.endLine ?? lines.length;
      return lines.slice(start, end).join("\n");
    }
    case "Write": {
      const abs = safePath(input.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, input.content, "utf-8");
      invalidateReadCache(abs);
      return `File written: ${input.path} (${input.content.length} bytes)`;
    }
    case "Edit": {
      const abs = safePath(input.path);
      if (!existsSync(abs)) return `Error: File not found: ${input.path}`;
      const content = readFileSync(abs, "utf-8");
      if (!content.includes(input.oldString)) return `Error: oldString not found in ${input.path}`;
      // Count occurrences via indexOf scan (stops at second hit) instead of
      // .split(...).length - 1 which allocates a full intermediate array.
      // On a 1 MB file with a 50-char oldString that's ~20 K-element array
      // we never use. indexOf early-exits after the second match.
      let firstAt = content.indexOf(input.oldString);
      if (firstAt !== -1) {
        const secondAt = content.indexOf(input.oldString, firstAt + input.oldString.length);
        if (secondAt !== -1) {
          // Compute precise count only for the error message — rare path.
          const count = content.split(input.oldString).length - 1;
          return `Error: oldString found ${count} times, must be unique`;
        }
      }
      // Use the function-form `replace` so `$&`, `$\``, `$'`, `$1`-`$9`
      // patterns inside `newString` are NOT interpreted as substitution
      // tokens. Without this, an LLM-emitted patch containing a literal `$&`
      // would silently get expanded into the matched `oldString`, corrupting
      // the file in a way that is invisible to the model.
      writeFileSync(abs, content.replace(input.oldString, () => input.newString), "utf-8");
      invalidateReadCache(abs);
      return `Edited ${input.path}`;
    }
    case "MultiEdit": {
      const abs = safePath(input.path);
      if (!existsSync(abs)) return `Error: File not found: ${input.path}`;
      let content = readFileSync(abs, "utf-8");
      const results: string[] = [];
      for (let i = 0; i < input.edits.length; i++) {
        const edit = input.edits[i];
        // Defensive: under TS `noUncheckedIndexedAccess` `input.edits[i]` is
        // `T | undefined`. A naive destructure would throw rather than skip.
        if (!edit) continue;
        const { oldString, newString } = edit;
        const firstAt = content.indexOf(oldString);
        if (firstAt === -1) {
          results.push(`Edit ${i + 1}: oldString not found`);
          continue;
        }
        const secondAt = content.indexOf(oldString, firstAt + oldString.length);
        if (secondAt !== -1) {
          // Precise count for the error message; .split is fine here because
          // the duplicate-match path is the rare failure case, not the hot
          // success path.
          const count = content.split(oldString).length - 1;
          results.push(`Edit ${i + 1}: oldString found ${count} times, must be unique`);
          continue;
        }
        // Function-form replace: see Edit case above for rationale.
        content = content.replace(oldString, () => newString);
        results.push(`Edit ${i + 1}: OK`);
      }
      writeFileSync(abs, content, "utf-8");
      invalidateReadCache(abs);
      return `MultiEdit ${input.path}: ${results.join("; ")}`;
    }
    case "Bash": {
      // Sandbox enforcement for shell commands
      const blocked = isCommandBlocked(input.command);
      if (blocked) return blocked;

      // Pre-check the AbortSignal so a session that was cancelled while the
      // tool was queued bails immediately instead of holding the event loop
      // for the timeout window. (Mid-run cancellation still relies on the
      // timeout — true mid-run abort requires async execa; the async sibling
      // `executeToolCallAsync` exists for that path.)
      if (_signal?.aborted) {
        return "Error: aborted before execution";
      }

      try {
        const result = execSync(input.command, {
          cwd,
          timeout: input.timeout ?? 120_000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            HOME: cwd,  // Restrict HOME to workspace
            SANDBOX_DIR: cwdResolved,
          },
        });
        return result || "(no output)";
      } catch (e: unknown) {
        const err = asSubprocessError(e);
        const output = [err.stdout, err.stderr].filter(Boolean).join("\n");
        /* v8 ignore next — execFileSync's thrown error always carries a
           numeric `status`; the ?? 1 fallback is TS glue only. */
        return `Exit code ${err.status ?? 1}\n${output}`;
      }
    }
    case "Grep": {
      if (_signal?.aborted) return "Error: aborted before execution";
      try {
        const grepPath = safePath(input.path ?? ".");
        const args = ["-rn", "--color=never"];
        if (input.include) args.push(`--include=${input.include}`);
        args.push(input.pattern, grepPath);
        const result = execFileSync("grep", args, {
          cwd, encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"],
        });
        /* v8 ignore next — grep exits non-zero (→ catch below) when there
           are no matches; the empty-string truthy fallback here is defensive. */
        return result || "No matches found";
      } catch (e: unknown) {
        const err = asSubprocessError(e);
        if (err.status === 1) return "No matches found";
        /* v8 ignore next — defensive: grep error path other than "no matches" */
        return `Error: ${err.message ?? "unknown"}`;
      }
    }
    case "Glob": {
      const base = safePath(input.path ?? ".");
      const files = globSync(input.pattern, { cwd: base, nodir: true });
      return files.length > 0 ? files.join("\n") : "No files matched";
    }
    case "ListDir": {
      const abs = safePath(input.path ?? ".");
      // No `existsSync(abs)` precheck: that would race a concurrent unlink
      // (TOCTOU) and adds an extra syscall. `readdirSync({ withFileTypes:
      // true })` already throws ENOENT/ENOTDIR which we map to the same
      // error strings, AND it returns Dirent objects whose isDirectory()
      // is free — eliminating the per-entry statSync (audit-round-2 #16).
      try {
        const stat = statSync(abs);
        if (!stat.isDirectory()) return `Error: Not a directory: ${input.path ?? "."}`;
        const entries = readdirSync(abs, { withFileTypes: true });
        return entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty directory)";
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return `Error: Directory not found: ${input.path ?? "."}`;
        if (code === "ENOTDIR") return `Error: Not a directory: ${input.path ?? "."}`;
        /* v8 ignore next — defensive: any other readdir error surface as the typed message */
        return `Error: ${(err as Error).message}`;
      }
    }
    case "AskUserQuestion": {
      // No-op placeholder — the real routing happens in agent-session before
      // a tool_use for AskUserQuestion ever reaches this executor.
      throw new Error("AskUserQuestion must be handled by the session, not the tool executor");
    }
    case "Delete": {
      const abs = safePath(input.path);
      // Never allow deleting the workspace root
      if (abs === cwdResolved) return "Error: Cannot delete the workspace root directory";
      if (!existsSync(abs)) return `Error: Not found: ${input.path}`;
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        rmSync(abs, { recursive: true, force: true });
        return `Deleted directory: ${input.path}`;
      } else {
        unlinkSync(abs);
        return `Deleted file: ${input.path}`;
      }
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

/**
 * Async sibling of `executeToolCall`. Currently identical for the non-shell
 * tools (Read/Write/Edit/MultiEdit/Glob/ListDir/Delete), but Bash and Grep
 * route through `execa` with a real `signal` instead of `execSync` — so
 * mid-run cancellation actually kills the subprocess instead of waiting for
 * the timeout window.
 *
 * Why a separate function rather than swapping the existing one:
 *   * `executeToolCall` is called synchronously from many places (tests + the
 *     production `session.ts:648`). Promoting the whole API to async would
 *     cascade through ~30 callers. The async sibling lets new callers opt
 *     in incrementally.
 *
 * The Bash/Grep paths fall through to the sync implementation for the
 * non-shell tools to avoid copy-paste; only the two shell tools have async
 * bodies here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executeToolCallAsync(
  name: string,
  input: any,
  workingDir?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (name !== "Bash" && name !== "Grep") {
    // Non-shell tools have no benefit from async — defer to the sync path.
    return executeToolCall(name, input, workingDir, signal);
  }

  const cwd = workingDir ?? getFlockctlHome();
  const cwdResolved = resolve(cwd);
  const safePath = (p: string) => {
    const abs = resolve(cwd, p);
    if (abs !== cwdResolved && !abs.startsWith(cwdResolved + sep)) {
      throw new Error(`Path '${p}' is outside working directory`);
    }
    return abs;
  };

  if (signal?.aborted) return "Error: aborted before execution";

  // Lazy execa import — keeps `executeToolCall` (sync) free of the execa
  // dep at module load, preserves the partial-mock tests that already exist
  // for `node:child_process`.
  const { execa } = await import("execa");

  if (name === "Bash") {
    const blocked = isCommandBlocked(input.command);
    if (blocked) return blocked;
    try {
      // `shell: true` matches `execSync`'s default. execa runs the command
      // through `sh -c` on POSIX. The signal is what we gained over
      // execSync — mid-run abort actually kills the child.
      const result = await execa(input.command, {
        cwd,
        shell: true,
        timeout: input.timeout ?? 120_000,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          HOME: cwd,
          SANDBOX_DIR: cwdResolved,
        },
        signal,
      });
      return result.stdout || "(no output)";
    } catch (e: unknown) {
      const err = asSubprocessError(e);
      const output = [err.stdout, err.stderr].filter(Boolean).join("\n");
      return `Exit code ${err.status ?? 1}\n${output}`;
    }
  }

  // Grep
  try {
    const grepPath = safePath(input.path ?? ".");
    const args = ["-rn", "--color=never"];
    if (input.include) args.push(`--include=${input.include}`);
    args.push(input.pattern, grepPath);
    const result = await execa("grep", args, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      signal,
    });
    return result.stdout || "No matches found";
  } catch (e: unknown) {
    const err = asSubprocessError(e);
    if (err.status === 1) return "No matches found";
    return `Error: ${err.message ?? "unknown"}`;
  }
}
