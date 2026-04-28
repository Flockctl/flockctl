import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync } from "fs";
import { join, resolve, dirname, relative } from "path";
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

// Tool execution
export function executeToolCall(
  name: string, input: any, workingDir?: string, _signal?: AbortSignal
): string {
  const cwd = workingDir ?? getFlockctlHome();
  const cwdResolved = resolve(cwd);
  const resolvePath = (p: string) => resolve(cwd, p);

  // Safety: don't allow escaping the working directory
  const safePath = (p: string) => {
    const abs = resolve(cwd, p);
    if (!abs.startsWith(cwdResolved)) throw new Error(`Path '${p}' is outside working directory`);
    return abs;
  };

  switch (name) {
    case "Read": {
      const abs = safePath(input.path);
      if (!existsSync(abs)) return `Error: File not found: ${input.path}`;
      const lines = readFileSync(abs, "utf-8").split("\n");
      const start = (input.startLine ?? 1) - 1;
      const end = input.endLine ?? lines.length;
      return lines.slice(start, end).join("\n");
    }
    case "Write": {
      const abs = safePath(input.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, input.content, "utf-8");
      return `File written: ${input.path} (${input.content.length} bytes)`;
    }
    case "Edit": {
      const abs = safePath(input.path);
      if (!existsSync(abs)) return `Error: File not found: ${input.path}`;
      const content = readFileSync(abs, "utf-8");
      if (!content.includes(input.oldString)) return `Error: oldString not found in ${input.path}`;
      const count = content.split(input.oldString).length - 1;
      if (count > 1) return `Error: oldString found ${count} times, must be unique`;
      writeFileSync(abs, content.replace(input.oldString, input.newString), "utf-8");
      return `Edited ${input.path}`;
    }
    case "MultiEdit": {
      const abs = safePath(input.path);
      if (!existsSync(abs)) return `Error: File not found: ${input.path}`;
      let content = readFileSync(abs, "utf-8");
      const results: string[] = [];
      for (let i = 0; i < input.edits.length; i++) {
        const { oldString, newString } = input.edits[i];
        if (!content.includes(oldString)) {
          results.push(`Edit ${i + 1}: oldString not found`);
          continue;
        }
        const count = content.split(oldString).length - 1;
        if (count > 1) {
          results.push(`Edit ${i + 1}: oldString found ${count} times, must be unique`);
          continue;
        }
        content = content.replace(oldString, newString);
        results.push(`Edit ${i + 1}: OK`);
      }
      writeFileSync(abs, content, "utf-8");
      return `MultiEdit ${input.path}: ${results.join("; ")}`;
    }
    case "Bash": {
      // Sandbox enforcement for shell commands
      const blocked = isCommandBlocked(input.command);
      if (blocked) return blocked;

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
      } catch (e: any) {
        const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
        /* v8 ignore next — execFileSync's thrown error always carries a
           numeric `status`; the ?? 1 fallback is TS glue only. */
        return `Exit code ${e.status ?? 1}\n${output}`;
      }
    }
    case "Grep": {
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
      } catch (e: any) {
        if (e.status === 1) return "No matches found";
        /* v8 ignore next — defensive: grep error path other than "no matches" */
        return `Error: ${e.message}`;
      }
    }
    case "Glob": {
      const base = safePath(input.path ?? ".");
      const files = globSync(input.pattern, { cwd: base, nodir: true });
      return files.length > 0 ? files.join("\n") : "No files matched";
    }
    case "ListDir": {
      const abs = safePath(input.path ?? ".");
      if (!existsSync(abs)) return `Error: Directory not found: ${input.path ?? "."}`;
      const stat = statSync(abs);
      if (!stat.isDirectory()) return `Error: Not a directory: ${input.path ?? "."}`;
      const entries = readdirSync(abs);
      return entries.map(e => {
        try {
          const s = statSync(join(abs, e));
          return s.isDirectory() ? `${e}/` : e;
        } catch {
          /* v8 ignore next — defensive: stat fails on broken symlink */
          return e;
        }
      }).join("\n") || "(empty directory)";
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
