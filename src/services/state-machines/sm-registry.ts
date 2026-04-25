/**
 * State-machine registry.
 *
 * Scans `<projectPath>/.flockctl/state-machines/*.md` on boot (and, when
 * asked, on file-system change) and returns the parsed machines keyed by
 * entity name.
 *
 * Each `*.md` file describes one entity and must look like:
 *
 *   ---
 *   entity: task
 *   filePatterns:
 *     - "src/tasks/**"
 *     - "src/routes/tasks.ts"
 *   ---
 *
 *   # Any prose here is ignored.
 *
 *   ```mermaid
 *   stateDiagram-v2
 *   [*] --> pending
 *   pending --> running : start
 *   running --> done : finish
 *   done --> [*]
 *   ```
 *
 * The frontmatter is YAML (failsafe — strings only), and the registry
 * accepts exactly one mermaid fenced block per file. The diagram itself
 * is handed to `parseMermaidStateDiagram` so the StateMachine type stays
 * identical to the one produced by the YAML DSL.
 */

import { existsSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { load, FAILSAFE_SCHEMA } from "js-yaml";
import { minimatch } from "minimatch";

import type { ParseError, StateMachine } from "./sm-parser.js";
import { parseMermaidStateDiagram } from "./sm-mermaid-parser.js";

export interface RegistryEntry {
  sm: StateMachine;
  filePatterns: string[];
  sourcePath: string;
  /**
   * Free-text invariants ("must be paid before shipping"). Parsed from the
   * optional `invariants:` sequence in the file's YAML frontmatter and
   * surfaced to the agent via `formatRegistryMatches` when this entity is in
   * scope for a task.
   */
  invariants?: string[];
}

/**
 * One matched registry row — the entity name plus its parsed entry — as
 * returned by `matchRegistryForFiles`. A separate shape (rather than just
 * reusing `[string, RegistryEntry]`) keeps the formatter call sites readable.
 */
export interface MatchedEntity {
  entity: string;
  entry: RegistryEntry;
}

export interface RegistryLoadError {
  sourcePath: string;
  errors: ParseError[];
}

export interface RegistryLoadResult {
  /** entity name → parsed entry */
  entries: Map<string, RegistryEntry>;
  /** per-file parse failures; successful entries are in `entries` */
  errors: RegistryLoadError[];
}

const STATE_MACHINES_SUBDIR = join(".flockctl", "state-machines");
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const MERMAID_FENCE_RE = /```mermaid\r?\n([\s\S]*?)```/;

interface ParsedMarkdown {
  entity: string;
  filePatterns: string[];
  invariants: string[];
  mermaid: string;
}

/**
 * Pull the frontmatter + first mermaid block out of a `.md` file.
 * Returns a list of ParseError on any structural problem.
 */
function parseMarkdownFile(
  content: string,
): { ok: true; value: ParsedMarkdown } | { ok: false; errors: ParseError[] } {
  const errors: ParseError[] = [];

  const fmMatch = FRONTMATTER_RE.exec(content);
  if (!fmMatch) {
    errors.push({ message: "missing YAML frontmatter (--- … ---)" });
    return { ok: false, errors };
  }

  let fmRaw: unknown;
  try {
    /* v8 ignore next — the FRONTMATTER_RE has a mandatory capture group that
       always matches when the regex itself matches; the ?? "" is TS glue. */
    fmRaw = load(fmMatch[1] ?? "", { schema: FAILSAFE_SCHEMA });
  } catch (e) {
    /* v8 ignore next — js-yaml's load() only throws Error subclasses; the
       String(e) fallback is defensive typing. */
    const msg = e instanceof Error ? e.message : String(e);
    errors.push({ message: `frontmatter yaml: ${msg}` });
    return { ok: false, errors };
  }

  if (typeof fmRaw !== "object" || fmRaw === null || Array.isArray(fmRaw)) {
    errors.push({ message: "frontmatter must be a YAML mapping" });
    return { ok: false, errors };
  }
  const fm = fmRaw as Record<string, unknown>;

  const entity = fm.entity;
  if (typeof entity !== "string" || entity.length === 0) {
    errors.push({
      message: "`entity` is required and must be a non-empty string",
      path: "entity",
    });
  }

  let filePatterns: string[] = [];
  if ("filePatterns" in fm && fm.filePatterns !== undefined) {
    if (
      !Array.isArray(fm.filePatterns) ||
      !fm.filePatterns.every((p) => typeof p === "string")
    ) {
      errors.push({
        message: "`filePatterns` must be a sequence of strings",
        path: "filePatterns",
      });
    } else {
      filePatterns = fm.filePatterns as string[];
    }
  }

  let invariants: string[] = [];
  if ("invariants" in fm && fm.invariants !== undefined) {
    if (
      !Array.isArray(fm.invariants) ||
      !fm.invariants.every((p) => typeof p === "string")
    ) {
      errors.push({
        message: "`invariants` must be a sequence of strings",
        path: "invariants",
      });
    } else {
      invariants = fm.invariants as string[];
    }
  }

  const mermaidMatch = MERMAID_FENCE_RE.exec(content);
  if (!mermaidMatch) {
    errors.push({ message: "missing ```mermaid … ``` fenced block" });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      entity: entity as string,
      filePatterns,
      invariants,
      /* v8 ignore next — MERMAID_FENCE_RE has a single mandatory capture
         group; whenever the regex matches, [1] is a string. The ?? "" is
         TS glue. */
      mermaid: mermaidMatch![1] ?? "",
    },
  };
}

/**
 * Load every `*.md` file under `<projectPath>/.flockctl/state-machines/`
 * and return the resulting registry.
 *
 * If the directory does not exist the result is an empty map with no
 * errors — a brand-new project with no state machines is valid.
 */
export function loadRegistry(projectPath: string): RegistryLoadResult {
  const dir = join(projectPath, STATE_MACHINES_SUBDIR);
  const entries = new Map<string, RegistryEntry>();
  const errors: RegistryLoadError[] = [];

  if (!existsSync(dir)) {
    return { entries, errors };
  }
  let st;
  try {
    st = statSync(dir);
  } catch {
    return { entries, errors };
  }
  if (!st.isDirectory()) return { entries, errors };

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch (e) {
    /* v8 ignore next — readdirSync throws Error subclasses; the String(e)
       fallback is defensive glue only. */
    const msg = e instanceof Error ? e.message : String(e);
    errors.push({ sourcePath: dir, errors: [{ message: `readdir: ${msg}` }] });
    return { entries, errors };
  }

  for (const file of files) {
    const sourcePath = join(dir, file);
    let content: string;
    try {
      content = readFileSync(sourcePath, "utf8");
    } catch (e) {
      /* v8 ignore next — readFileSync throws Error subclasses; the String(e)
         fallback is defensive glue only. */
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ sourcePath, errors: [{ message: `read: ${msg}` }] });
      continue;
    }

    const md = parseMarkdownFile(content);
    if (!md.ok) {
      errors.push({ sourcePath, errors: md.errors });
      continue;
    }

    const smResult = parseMermaidStateDiagram(md.value.mermaid);
    if (!smResult.ok) {
      errors.push({ sourcePath, errors: smResult.errors });
      continue;
    }

    if (entries.has(md.value.entity)) {
      const prior = entries.get(md.value.entity)!.sourcePath;
      errors.push({
        sourcePath,
        errors: [
          {
            message: `duplicate entity \`${md.value.entity}\` (first declared in ${prior})`,
            path: "entity",
          },
        ],
      });
      continue;
    }

    const entry: RegistryEntry = {
      sm: smResult.value,
      filePatterns: md.value.filePatterns,
      sourcePath,
    };
    if (md.value.invariants.length > 0) {
      entry.invariants = md.value.invariants;
    }
    entries.set(md.value.entity, entry);
  }

  return { entries, errors };
}

/**
 * Watch `<projectPath>/.flockctl/state-machines/` for changes and invoke
 * `onChange` with a freshly-loaded registry each time a `.md` file there
 * is written / renamed / removed.
 *
 * Returns a disposer that stops the watcher. If the directory does not
 * exist the function returns a no-op disposer — callers are expected to
 * retry on project restructure.
 *
 * `fs.watch` is deliberately used rather than a heavyweight chokidar
 * dependency; its cross-platform quirks are fine for "rescan everything
 * on any notification" semantics.
 */
export function watchRegistry(
  projectPath: string,
  onChange: (result: RegistryLoadResult) => void,
): () => void {
  const dir = join(projectPath, STATE_MACHINES_SUBDIR);
  if (!existsSync(dir)) return () => {};
  let watcher;
  try {
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename !== null && !String(filename).endsWith(".md")) return;
      onChange(loadRegistry(projectPath));
    });
  } catch {
    return () => {};
  }
  return () => watcher.close();
}

/* -------------------------------------------------------------------------- */
/* File-pattern matching + system-prompt rendering                            */
/* -------------------------------------------------------------------------- */

/**
 * Normalized input shape for `matchRegistryForFiles`. Accepts either the
 * Map returned by `loadRegistry` or a plain iterable of `[name, entry]`
 * tuples so tests can construct tiny fixtures without going through the
 * file-system loader.
 */
export type RegistryLike =
  | Map<string, RegistryEntry>
  | Iterable<[string, RegistryEntry]>;

/**
 * Return every entity whose `filePatterns` matches at least one path in
 * `touchedFiles`. Order follows the registry's own iteration order (Map
 * insertion order by default) so the injection output is deterministic
 * across runs with identical input.
 *
 * Matching uses `minimatch` with `dot: true` so `src/**` also matches
 * `src/.hidden/foo.ts`. We do NOT enable `matchBase`, because registry
 * patterns are expected to be rooted at the repo — writing `foo.ts` and
 * having it match every `foo.ts` anywhere is almost always a bug.
 */
export function matchRegistryForFiles(
  touchedFiles: string[],
  registry: RegistryLike,
): MatchedEntity[] {
  if (touchedFiles.length === 0) return [];
  const entries =
    registry instanceof Map
      ? Array.from(registry.entries())
      : Array.from(registry);
  if (entries.length === 0) return [];
  const matched: MatchedEntity[] = [];
  for (const [entity, entry] of entries) {
    const hit = entry.filePatterns.some((pattern) =>
      touchedFiles.some((file) => minimatch(file, pattern, { dot: true })),
    );
    if (hit) matched.push({ entity, entry });
  }
  return matched;
}

/**
 * Render matched entities as a compact system-prompt block. Mirrors the
 * `<past_incidents>` style already used by `agent-session` so the model
 * sees both context blocks in the same structured format.
 *
 * Shape (one line per entity):
 *
 *   <state_machines>
 *   ## State machines in scope: order, payment
 *
 *   Entity: order — Valid transitions: pending→paid (event: pay), paid→shipped (event: ship) | Invariants: must be paid before shipping
 *   Entity: payment — Valid transitions: …
 *   </state_machines>
 *
 * Returns the empty string when there are no matches; callers can then
 * short-circuit the append.
 */
export function formatRegistryMatches(matches: MatchedEntity[]): string {
  if (matches.length === 0) return "";
  const names = matches.map((m) => m.entity).join(", ");
  const lines: string[] = [
    "<state_machines>",
    `## State machines in scope: ${names}`,
    "",
  ];
  for (const { entity, entry } of matches) {
    const transitions = entry.sm.transitions
      .map((t) => `${t.from}→${t.to} (event: ${t.event})`)
      .join(", ");
    let line = `Entity: ${entity} — Valid transitions: ${
      transitions || "(none)"
    }`;
    if (entry.invariants && entry.invariants.length > 0) {
      line += ` | Invariants: ${entry.invariants.join("; ")}`;
    }
    lines.push(line);
  }
  lines.push("</state_machines>");
  return lines.join("\n");
}
