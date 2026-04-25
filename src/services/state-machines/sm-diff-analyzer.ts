/**
 * State machine diff analyzer — heuristic v1.
 *
 * Core idea: the repo ships a registry of allowed state transitions for each
 * entity under `.flockctl/state-machines/*.md`. A `git diff` (typically
 * `git diff HEAD`) is scanned for lines that look like they introduce a new
 * state transition. Transitions not declared in the registry are reported as
 * violations so the CLI can fail a pre-commit hook.
 *
 * Detection heuristics (all applied to added / modified lines only):
 *
 *   1. Explicit annotation — zero false positives
 *      `// @sm:<entity> <from> -> <to>`
 *      `// @sm <entity>: <from> -> <to>`
 *      `// flockctl-sm <entity> <from>-><to>`
 *
 *   2. Object-literal transition — low false positive rate
 *      `{ from: 'shipped', to: 'cancelled' }`
 *      Entity inferred from `entity: '<name>'` nearby or filename.
 *
 *   3. Event call — used in conjunction with the registry
 *      `.transition('<event>')`
 *      The event name is looked up in the registry to derive (from, to).
 *
 * Override: a line (or the preceding line) containing the literal string
 * `flockctl-sm-ignore` suppresses any detection on that line.
 *
 * The registry supports Mermaid `stateDiagram-v2` fenced code blocks inside
 * markdown. Entity name comes from (in priority order):
 *
 *   1. YAML frontmatter `entity: <name>`
 *   2. HTML comment `<!-- entity: <name> -->`
 *   3. First markdown H1 heading (e.g. `# Order`)
 *   4. Filename stem (`order.md` → `order`)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, extname, join } from "path";
import { execSync } from "child_process";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface RegistryTransition {
  from: string;
  to: string;
  event?: string;
}

export interface RegistryEntry {
  entity: string;
  sourcePath: string;
  states: string[];
  transitions: RegistryTransition[];
  initial?: string;
}

export interface DetectedTransition {
  entity: string; // "*" when unknown / could not be inferred
  from: string;
  to: string;
  event?: string;
  file: string;
  line: number;
  raw: string;
  pattern: "annotation" | "object-literal" | "event-call";
}

export interface Violation {
  detected: DetectedTransition;
  registeredTransitions: RegistryTransition[];
  registrySource?: string;
  message: string;
  suggestion: string;
}

/* -------------------------------------------------------------------------- */
/* Mermaid stateDiagram-v2 subset parser                                      */
/* -------------------------------------------------------------------------- */

/**
 * Parse a Mermaid `stateDiagram-v2` block. Supports the subset:
 *
 *   [*] --> initialState
 *   A --> B
 *   A --> B : eventName
 *   A --> [*]                 (becomes `final`; no transition emitted)
 *
 * Unrecognised lines are silently ignored to stay robust against comments
 * and future mermaid extensions.
 */
export function parseMermaidBlock(text: string): {
  states: string[];
  transitions: RegistryTransition[];
  initial?: string;
} {
  const states = new Set<string>();
  const transitions: RegistryTransition[] = [];
  let initial: string | undefined;

  const transitionRe =
    /^\s*([A-Za-z_][\w*]*|\[\*\])\s*-->\s*([A-Za-z_][\w*]*|\[\*\])\s*(?::\s*(.+?))?\s*$/;

  for (const raw of text.split("\n")) {
    const line = raw.replace(/%%.*$/, "").trim(); // strip mermaid `%%` comments
    if (!line) continue;
    if (/^stateDiagram(-v2)?\b/.test(line)) continue;
    if (/^(direction|classDef|class|note|state)\b/.test(line)) continue;

    const m = transitionRe.exec(line);
    if (!m) continue;
    /* v8 ignore next 2 — defensive: transitionRe has two mandatory capture groups,
     * so when `m` is non-null both m[1] and m[2] are always strings. */
    const fromRaw = m[1] ?? "";
    const toRaw = m[2] ?? "";
    const eventRaw = m[3];

    if (fromRaw === "[*]" && toRaw !== "[*]") {
      initial = toRaw;
      states.add(toRaw);
      continue;
    }
    if (toRaw === "[*]") {
      // final marker — track the state but emit no transition
      if (fromRaw !== "[*]") states.add(fromRaw);
      continue;
    }
    /* v8 ignore next — defensive: the `toRaw === "[*]"` branch above already
     * consumes every `X --> [*]` shape, so this line is unreachable. */
    if (fromRaw === "[*]" && toRaw === "[*]") continue;

    states.add(fromRaw);
    states.add(toRaw);
    const event = eventRaw?.trim();
    const t: RegistryTransition = { from: fromRaw, to: toRaw };
    if (event) t.event = event;
    transitions.push(t);
  }

  return { states: [...states], transitions, initial };
}

/* -------------------------------------------------------------------------- */
/* Registry markdown loader                                                   */
/* -------------------------------------------------------------------------- */

function extractMermaidBlocks(md: string): string[] {
  const blocks: string[] = [];
  const re = /```mermaid\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    /* v8 ignore next — defensive: the mermaid regex has a mandatory capture
     * group so m[1] is always a string when m is non-null. */
    if (m[1] !== undefined) blocks.push(m[1]);
  }
  return blocks;
}

function extractEntityName(md: string, filePath: string): string {
  // Frontmatter
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(md);
  if (fm?.[1] !== undefined) {
    const entityLine = /^\s*entity\s*:\s*(.+?)\s*$/m.exec(fm[1]);
    /* v8 ignore next — defensive: entityLine regex has a mandatory capture
     * group, so `entityLine[1]` is always a string when the match succeeds. */
    if (entityLine?.[1] !== undefined) return entityLine[1].replace(/^["']|["']$/g, "");
  }
  // HTML comment
  const html = /<!--\s*entity\s*:\s*([\w-]+)\s*-->/i.exec(md);
  /* v8 ignore next — defensive: the regex has a mandatory capture group, so
   * `html[1]` is always a string when the match succeeds. */
  if (html?.[1] !== undefined) return html[1];
  // H1 heading
  const h1 = /^#\s+(.+)$/m.exec(md);
  /* v8 ignore next 2 — defensive: `h1[1]` is always a string when match
   * succeeds, and `.split(/\s+/)` on a non-empty string always yields [0]. */
  if (h1?.[1] !== undefined) return h1[1].trim().toLowerCase().split(/\s+/)[0] ?? "";
  // Filename
  return basename(filePath, extname(filePath));
}

export function parseRegistryMarkdown(
  md: string,
  filePath: string,
): RegistryEntry | null {
  const blocks = extractMermaidBlocks(md);
  if (blocks.length === 0) return null;

  const states = new Set<string>();
  const transitions: RegistryTransition[] = [];
  let initial: string | undefined;

  for (const b of blocks) {
    const parsed = parseMermaidBlock(b);
    for (const s of parsed.states) states.add(s);
    for (const t of parsed.transitions) transitions.push(t);
    if (parsed.initial && !initial) initial = parsed.initial;
  }

  if (transitions.length === 0 && states.size === 0) return null;

  return {
    entity: extractEntityName(md, filePath),
    sourcePath: filePath,
    states: [...states],
    transitions,
    initial,
  };
}

export function loadRegistry(projectRoot: string): Map<string, RegistryEntry> {
  const registry = new Map<string, RegistryEntry>();
  const dir = join(projectRoot, ".flockctl", "state-machines");
  if (!existsSync(dir)) return registry;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return registry;
  }

  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const md = readFileSync(full, "utf8");
    const parsed = parseRegistryMarkdown(md, full);
    if (parsed) registry.set(parsed.entity, parsed);
  }

  return registry;
}

/* -------------------------------------------------------------------------- */
/* Diff parser — unified diff format                                          */
/* -------------------------------------------------------------------------- */

export interface DiffLine {
  file: string;
  line: number; // 1-based line number in the NEW file
  content: string; // without leading '+'
}

/**
 * Parse a unified diff (as produced by `git diff`) and return all ADDED lines
 * (prefix `+` but not file headers `+++`). Deleted lines are ignored — we
 * only care about newly introduced transitions.
 */
export function parseDiffAddedLines(diff: string): DiffLine[] {
  const added: DiffLine[] = [];
  let currentFile: string | null = null;
  let newLineNo = 0;

  const lines = diff.split("\n");
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      // "+++ b/path/to/file" — strip the a/ or b/ prefix
      const m = /^\+\+\+\s+(?:[ab]\/)?(.+?)(?:\t.*)?$/.exec(line);
      currentFile = m?.[1] ?? null;
      if (currentFile === "/dev/null") currentFile = null;
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("diff --git")) continue;
    if (line.startsWith("index ")) continue;
    if (line.startsWith("new file mode")) continue;
    if (line.startsWith("deleted file mode")) continue;
    if (line.startsWith("rename ")) continue;
    if (line.startsWith("similarity ")) continue;

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk?.[1] !== undefined) {
      newLineNo = parseInt(hunk[1], 10);
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith("+")) {
      added.push({
        file: currentFile,
        line: newLineNo,
        content: line.slice(1),
      });
      newLineNo++;
    } else if (line.startsWith("-")) {
      // removed line — doesn't advance new-file counter
    } else if (line.startsWith(" ")) {
      newLineNo++;
    } else {
      // fall-through (e.g. "\ No newline at end of file") — ignore
    }
  }

  return added;
}

/* -------------------------------------------------------------------------- */
/* Heuristic transition detection                                             */
/* -------------------------------------------------------------------------- */

const IGNORE_MARKER = "flockctl-sm-ignore";

const ANNOTATION_RES = [
  // `// @sm:entity from -> to`  or  `// @sm:entity from->to`
  /@sm\s*:\s*([\w-]+)\s+([\w-]+)\s*->\s*([\w-]+)/,
  // `// @sm entity: from -> to`
  /@sm\s+([\w-]+)\s*:\s*([\w-]+)\s*->\s*([\w-]+)/,
  // `// flockctl-sm entity from -> to` or `// flockctl-sm entity from->to`
  /flockctl-sm\s+([\w-]+)\s+([\w-]+)\s*->\s*([\w-]+)/,
];

// { from: 'X', to: 'Y' } — optional event: 'E' and entity: 'Z'
const OBJECT_LITERAL_RE =
  /\bfrom\s*:\s*['"]([\w-]+)['"]\s*,\s*to\s*:\s*['"]([\w-]+)['"](?:\s*,\s*event\s*:\s*['"]([\w-]+)['"])?/;

const ENTITY_HINT_RE = /\bentity\s*:\s*['"]([\w-]+)['"]/;

const EVENT_CALL_RE = /\.transition\s*\(\s*['"]([\w-]+)['"]/;

export interface DetectOptions {
  /** Restrict detection to transitions for this entity. */
  entity?: string;
  /** Registry — required when interpreting `.transition('event')` calls. */
  registry?: Map<string, RegistryEntry>;
}

export function detectTransitionsInLines(
  lines: DiffLine[],
  opts: DetectOptions = {},
): DetectedTransition[] {
  const out: DetectedTransition[] = [];

  // Build a prev-content map so we can honour ignore markers on the preceding
  // line (common convention for lint-style suppressors).
  const byFile = new Map<string, DiffLine[]>();
  for (const l of lines) {
    const arr = byFile.get(l.file) ?? [];
    arr.push(l);
    byFile.set(l.file, arr);
  }

  for (const dl of lines) {
    if (dl.content.includes(IGNORE_MARKER)) continue;

    // Check preceding added line in same file for ignore marker
    /* v8 ignore next — defensive: `byFile` was just populated from the same
     * `lines` array, so every dl.file is guaranteed to have an entry. */
    const fileLines = byFile.get(dl.file) ?? [];
    const idx = fileLines.indexOf(dl);
    const prev = idx > 0 ? fileLines[idx - 1] : undefined;
    if (prev && prev.line === dl.line - 1) {
      if (prev.content.includes(IGNORE_MARKER)) continue;
    }

    const content = dl.content;

    // 1) explicit annotation
    let matched = false;
    for (const re of ANNOTATION_RES) {
      const m = re.exec(content);
      if (m) {
        /* v8 ignore next 3 — defensive: each ANNOTATION_RES has three
         * mandatory capture groups, so m[1..3] are always strings. */
        const entity = m[1] ?? "";
        const from = m[2] ?? "";
        const to = m[3] ?? "";
        if (opts.entity && opts.entity !== entity) continue;
        out.push({
          entity,
          from,
          to,
          file: dl.file,
          line: dl.line,
          raw: content.trim(),
          pattern: "annotation",
        });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // 2) object literal
    const olm = OBJECT_LITERAL_RE.exec(content);
    if (olm) {
      /* v8 ignore next 2 — defensive: OBJECT_LITERAL_RE has two mandatory
       * capture groups for from/to, so olm[1] and olm[2] are always strings. */
      const from = olm[1] ?? "";
      const to = olm[2] ?? "";
      const event = olm[3];
      const entityHint = ENTITY_HINT_RE.exec(content);
      const entity = entityHint?.[1] ?? opts.entity ?? "*";
      const t: DetectedTransition = {
        entity,
        from,
        to,
        file: dl.file,
        line: dl.line,
        raw: content.trim(),
        pattern: "object-literal",
      };
      if (event) t.event = event;
      out.push(t);
      continue;
    }

    // 3) event call — needs registry
    if (opts.registry) {
      const ecm = EVENT_CALL_RE.exec(content);
      if (ecm) {
        const event = ecm[1];
        // Look up the event in every registered entity (or the scoped one)
        for (const [entity, entry] of opts.registry) {
          if (opts.entity && opts.entity !== entity) continue;
          // Only report via event-call when the event is UNKNOWN in registry —
          // a known event is by definition a declared transition.
          const known = entry.transitions.some((t) => t.event === event);
          if (!known) {
            out.push({
              entity,
              from: "?",
              to: "?",
              event,
              file: dl.file,
              line: dl.line,
              raw: content.trim(),
              pattern: "event-call",
            });
          }
        }
      }
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Violation check                                                            */
/* -------------------------------------------------------------------------- */

function transitionDeclared(
  detected: DetectedTransition,
  entry: RegistryEntry,
): boolean {
  if (detected.pattern === "event-call") {
    return entry.transitions.some((t) => t.event === detected.event);
  }
  return entry.transitions.some(
    (t) => t.from === detected.from && t.to === detected.to,
  );
}

function suggestEdit(detected: DetectedTransition, entry?: RegistryEntry): string {
  if (detected.pattern === "event-call") {
    return `Add an event named \`${detected.event}\` to ${
      entry?.sourcePath ?? `.flockctl/state-machines/${detected.entity}.md`
    } or remove the \`.transition('${detected.event}')\` call.`;
  }
  const line = `    ${detected.from} --> ${detected.to}${
    detected.event ? ` : ${detected.event}` : ""
  }`;
  return `Add to ${
    entry?.sourcePath ?? `.flockctl/state-machines/${detected.entity}.md`
  }:\n${line}`;
}

export function checkAgainstRegistry(
  detected: DetectedTransition[],
  registry: Map<string, RegistryEntry>,
): Violation[] {
  const violations: Violation[] = [];

  for (const d of detected) {
    const candidates =
      d.entity === "*" ? [...registry.values()] : registry.has(d.entity) ? [registry.get(d.entity)!] : [];

    if (candidates.length === 0) {
      violations.push({
        detected: d,
        registeredTransitions: [],
        message:
          d.pattern === "event-call"
            ? `unknown event \`${d.event}\` — no state-machine registry found for entity \`${d.entity}\``
            : `new transition ${d.from}→${d.to} not declared in registry (no registry for entity \`${d.entity}\`)`,
        suggestion: suggestEdit(d),
      });
      continue;
    }

    // For entity="*" (unknown) — declared in at least one entity counts as OK
    const declaredSomewhere = candidates.some((c) => transitionDeclared(d, c));
    if (declaredSomewhere) continue;

    const entry = candidates.length === 1 ? candidates[0] : undefined;
    violations.push({
      detected: d,
      registeredTransitions: entry ? entry.transitions : [],
      registrySource: entry?.sourcePath,
      message:
        d.pattern === "event-call"
          ? `unknown event \`${d.event}\` for entity \`${d.entity}\` not declared in registry`
          : `new transition ${d.from}→${d.to} not declared in registry`,
      suggestion: suggestEdit(d, entry),
    });
  }

  return violations;
}

/* -------------------------------------------------------------------------- */
/* Glob filter                                                                */
/* -------------------------------------------------------------------------- */

/** Minimal glob → RegExp. Supports `*`, `**`, `?`, and path separators. */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (glob[i] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c !== undefined && ".+^$(){}|[]\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      /* v8 ignore next — defensive: the `while (i < glob.length)` loop
       * guarantees `glob[i]` (== c) is a defined string. */
      re += c ?? "";
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function filterLinesByGlob(
  lines: DiffLine[],
  glob: string | undefined,
): DiffLine[] {
  if (!glob) return lines;
  const re = globToRegExp(glob);
  return lines.filter((l) => re.test(l.file));
}

/* -------------------------------------------------------------------------- */
/* Top-level runner                                                           */
/* -------------------------------------------------------------------------- */

export interface RunCheckOptions {
  cwd: string;
  diffRef?: string; // e.g. "HEAD" — passed to `git diff <ref>`
  files?: string; // glob to restrict detection
  /** Override diff source instead of shelling out to git (used by tests). */
  diffText?: string;
  /** Override registry (used by tests). */
  registry?: Map<string, RegistryEntry>;
}

export interface RunCheckResult {
  violations: Violation[];
  exitCode: 0 | 1;
  detected: DetectedTransition[];
  registry: Map<string, RegistryEntry>;
}

export function formatViolations(violations: Violation[]): string {
  const lines: string[] = [];
  for (const v of violations) {
    const { detected } = v;
    lines.push(`${detected.file}:${detected.line}  ${v.message}`);
    if (v.registeredTransitions.length > 0) {
      const reg = v.registeredTransitions
        .map((t) => `${t.from}→${t.to}${t.event ? `:${t.event}` : ""}`)
        .join(", ");
      lines.push(`  registered: ${reg}`);
    }
    lines.push(`  ${v.suggestion.split("\n").join("\n  ")}`);
    lines.push("");
  }
  lines.push(
    violations.length === 1
      ? "1 state-machine violation found"
      : `${violations.length} state-machine violations found`,
  );
  return lines.join("\n");
}

export function runCheck(opts: RunCheckOptions): RunCheckResult {
  const registry = opts.registry ?? loadRegistry(opts.cwd);

  let diff = opts.diffText;
  if (diff === undefined) {
    const ref = opts.diffRef ?? "HEAD";
    try {
      diff = execSync(`git diff --no-color ${ref}`, {
        cwd: opts.cwd,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err) {
      /* v8 ignore next — defensive: execSync always throws an Error subclass,
       * so the `String(err)` RHS is unreachable in practice. */
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to run \`git diff ${ref}\`: ${msg}`);
    }
  }

  const allAdded = parseDiffAddedLines(diff);
  const scoped = filterLinesByGlob(allAdded, opts.files);
  const detected = detectTransitionsInLines(scoped, { registry });
  const violations = checkAgainstRegistry(detected, registry);

  return {
    violations,
    exitCode: violations.length > 0 ? 1 : 0,
    detected,
    registry,
  };
}
