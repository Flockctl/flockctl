import { memo, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Loader2, Wrench, Brain } from "lucide-react";
import { InlineDiff, synthesizeDiffFromEdit } from "@/components/InlineDiff";
import { StatusPill, type StatusPillTone } from "@/components/design/StatusPill";
import { cn, parseServerTimestamp } from "@/lib/utils";
import { formatDurationMs } from "@/lib/format";

export interface ToolExecution {
  id: string;
  name: string;
  input: unknown;
  status: "pending" | "success" | "error";
  result?: Record<string, unknown> | string;
  error?: string;
  /**
   * Wall-clock duration of the tool call. Rendered in the header in mono
   * (e.g. `850ms`, `1.2s`, `1m 30s`) when present. Optional — most live
   * stream callers don't compute it until the result event arrives.
   */
  durationMs?: number;
}

/**
 * Payload stored in `chat_messages.content` for rows with role="tool". The
 * chat executor writes one row per tool call and one row per tool result
 * (see src/services/chat-executor.ts) — calls and results are paired in
 * `groupStoredToolMessages` below by order+name.
 */
interface StoredToolPayload {
  kind: "call" | "result";
  name: string;
  input?: unknown;
  output?: unknown;
  summary?: string;
}

// `content` arrives either as the raw JSON string from the DB or — when the
// API layer's toSnakeKeys/tryParseJsonString auto-parses values that look like
// JSON — as the already-parsed object. Handle both so the row renders in
// either case.
function parseStoredTool(content: string | Record<string, unknown>): StoredToolPayload | null {
  let parsed: unknown;
  if (typeof content === "string") {
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
  } else {
    parsed = content;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.kind !== "call" && obj.kind !== "result") return null;
  if (typeof obj.name !== "string") return null;
  return obj as unknown as StoredToolPayload;
}

/**
 * Render a persisted `role: "tool"` chat message as a collapsible one-liner
 * showing the tool name and summary, with the raw input/output available on
 * demand. Used for chat transcripts — the live streaming counterpart is
 * `ToolExecutionItem`.
 *
 * `createdAt` (ISO 8601) is rendered as a `HH:mm` clock on the right of the
 * row so an operator can spot a hung agent at a glance — e.g. a tool call
 * stamped 10:16 with no follow-up means the run has been wedged ever since
 * that point. Mirrors the timestamp footer on `ChatMessage` for parity.
 */
export function StoredToolMessageItem({
  id,
  content,
  createdAt,
}: {
  id: string | number;
  content: string | Record<string, unknown>;
  createdAt?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const payload = useMemo(() => parseStoredTool(content), [content]);

  if (!payload) return null;

  const detail =
    payload.kind === "call" ? payload.input : payload.output;

  // When the tool call is an edit (Edit / Write / str_replace variants),
  // synthesize a unified diff from the call input so the expanded body
  // shows the same structured diff view used in the task page instead
  // of a raw JSON blob.
  const editDiff = payload.kind === "call" ? tryBuildEditDiff(payload.name, payload.input) : null;

  const formattedTime = createdAt
    ? formatToolTimestamp(createdAt)
    : null;

  return (
    <div
      className="rounded-xl border-l-2 border-blue-500 bg-blue-500/10 text-sm my-1"
      data-testid="stored-tool-message"
      data-tool-message-id={String(id)}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-blue-500/20"
        onClick={() => setExpanded(v => !v)}
      >
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
        <Wrench className="h-3.5 w-3.5 shrink-0 text-blue-400" />
        <span className="font-mono font-medium text-blue-300">{payload.name}</span>
        {payload.summary && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{payload.summary}</span>
        )}
        <span className="ml-auto shrink-0 text-[10px] uppercase text-muted-foreground">
          {payload.kind}
        </span>
        {formattedTime && (
          <span
            className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground"
            data-testid="stored-tool-timestamp"
            title={parseServerTimestamp(createdAt!).toLocaleString()}
          >
            {formattedTime}
          </span>
        )}
      </button>
      {expanded && editDiff && (
        <div className="border-t border-border bg-background/60 p-2">
          <InlineDiff diff={editDiff} />
        </div>
      )}
      {expanded && !editDiff && detail !== undefined && (
        <div className="border-t border-border bg-background/40 p-2">
          <JsonCodeView value={detail} />
        </div>
      )}
    </div>
  );
}

/**
 * Best-effort adapter from an edit-tool call payload to a unified diff.
 * Returns `null` when the payload doesn't look like an edit we can render,
 * letting the caller fall back to the raw JSON view.
 *
 * Supported shapes:
 *   Edit              → { file_path, old_string, new_string }
 *   Write             → { file_path, content } (shown as pure additions)
 *   str_replace_*     → { path, old_str, new_str }
 */
function tryBuildEditDiff(name: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;

  const filePath =
    (typeof obj.file_path === "string" && obj.file_path) ||
    (typeof obj.path === "string" && obj.path) ||
    "";
  if (!filePath) return null;

  // Edit-style: old/new string pair
  const oldString =
    typeof obj.old_string === "string" ? obj.old_string :
      typeof obj.old_str === "string" ? obj.old_str : null;
  const newString =
    typeof obj.new_string === "string" ? obj.new_string :
      typeof obj.new_str === "string" ? obj.new_str : null;

  if (oldString !== null && newString !== null) {
    return synthesizeDiffFromEdit({ filePath, oldString, newString });
  }

  // Write-style: whole-file content → render as pure additions so the chat
  // shows what was written rather than a meaningless JSON dump.
  const lowered = name.toLowerCase();
  if ((lowered === "write" || lowered === "create_file") && typeof obj.content === "string") {
    return synthesizeDiffFromEdit({ filePath, oldString: "", newString: obj.content });
  }

  return null;
}

/**
 * Collapsed "Thought for Ns" block. Shows a single-line summary and expands
 * to reveal the full extended-thinking text. Used both for live streaming
 * (while the assistant is thinking) and for persisted `role: "thinking"`
 * rows loaded from chat history.
 */
export function ThinkingBlock({
  content,
  streaming = false,
  durationMs,
}: {
  content: string;
  streaming?: boolean;
  durationMs?: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const label = streaming
    ? "Thinking…"
    : durationMs != null
      ? `Thought for ${Math.max(1, Math.round(durationMs / 1000))}s`
      : "Thought";

  return (
    <div
      className="rounded-xl border-l-2 border-muted-foreground/40 bg-muted/30 text-sm my-1"
      data-testid="thinking-block"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-muted-foreground hover:bg-muted/50"
        onClick={() => setExpanded(v => !v)}
      >
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
        {streaming
          ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          : <Brain className="h-3.5 w-3.5 shrink-0" />}
        <span className="italic">{label}</span>
      </button>
      {expanded && content && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border bg-background/40 p-2 text-[11px] text-muted-foreground">
          {content}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// JSON code view — renders a value as numbered lines using the shared
// `editor-line` + `tok-*` utilities (see ui/src/index.css). Long values are
// capped with a "show more" affordance so a 500-line tool result doesn't
// blow out the chat scrollback.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LINES = 20;

/**
 * Match every JSON token kind we colour. The order matters — strings (which
 * may include escaped quotes) come first, then numbers, then literals, then
 * single-character punctuation. Anything that doesn't match falls through as
 * the default "punctuation" colour (no token class).
 *
 * The `g` flag is required for `matchAll`.
 */
const JSON_TOKEN_RE =
  /"(?:[^"\\]|\\.)*"(?:\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}[\],:]/g;

function tokenizeJsonLine(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of line.matchAll(JSON_TOKEN_RE)) {
    const start = m.index!;
    if (start > last) out.push(line.slice(last, start));
    const tok = m[0];
    if (tok.startsWith('"')) {
      // String literal. If it ends with `:` (with optional whitespace), it's
      // an object key — render the quoted portion as `tok-type` and the
      // trailing `:` as plain punctuation so the key colour stops at the
      // quote.
      const colonIdx = tok.lastIndexOf(":");
      const isKey = colonIdx > tok.lastIndexOf('"');
      if (isKey) {
        const strPart = tok.slice(0, colonIdx).trimEnd();
        const tail = tok.slice(strPart.length);
        out.push(
          <span key={`k${key++}`} className="tok-type">{strPart}</span>,
          <span key={`k${key++}`}>{tail}</span>,
        );
      } else {
        out.push(<span key={`k${key++}`} className="tok-str">{tok}</span>);
      }
    } else if (/^-?\d/.test(tok)) {
      out.push(<span key={`k${key++}`} className="tok-num">{tok}</span>);
    } else if (tok === "true" || tok === "false" || tok === "null") {
      out.push(<span key={`k${key++}`} className="tok-kw">{tok}</span>);
    } else {
      out.push(tok);
    }
    last = start + tok.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/**
 * Defensive guard around the canonical {@link formatDurationMs} for the
 * tool-execution row's millisecond input. The shared helper does not
 * sanity-check the value (Infinity / NaN / negative would render as
 * `"NaNms"` or `"-1s"`), so we keep the local guard but delegate the
 * actual formatting to the shared module to avoid drift.
 */
function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  return formatDurationMs(ms);
}

/**
 * Render an ISO 8601 timestamp as `HH:mm` (locale-aware, 24h or 12h based on
 * the user's locale defaults). Returns `null` for unparseable input so the
 * caller can omit the slot rather than rendering `Invalid Date`.
 *
 * Used by the tool-call row header so operators can correlate a stalled
 * stream with when the last tool fired.
 */
function formatToolTimestamp(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Render an arbitrary value (string, object, array, …) as numbered code
 * lines using the shared `.editor-line` + `.tok-*` utilities. Falls back
 * to plain text for non-JSON-stringifiable values (e.g. circular refs).
 */
export function JsonCodeView({
  value,
  maxLines = DEFAULT_MAX_LINES,
}: {
  value: unknown;
  maxLines?: number;
}) {
  const { text, isJson } = useMemo(() => {
    if (typeof value === "string") return { text: value, isJson: false };
    try {
      return { text: JSON.stringify(value, null, 2) ?? "", isJson: true };
    } catch {
      // Circular references or BigInt — render the raw `String(value)` so
      // we never throw inside the chat scrollback.
      return { text: String(value), isJson: false };
    }
  }, [value]);

  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => text.split("\n"), [text]);
  const overflow = lines.length > maxLines;
  const visible = !overflow || expanded ? lines : lines.slice(0, maxLines);

  return (
    <div
      className="rounded border border-border bg-muted/30 py-1 font-mono text-[11px]"
      data-testid="tool-code-view"
    >
      {visible.map((line, i) => (
        <div key={i} className="editor-line">
          <span className="ln">{i + 1}</span>
          <span className="whitespace-pre-wrap break-all pr-2">
            {isJson ? tokenizeJsonLine(line) : line}
          </span>
        </div>
      ))}
      {overflow && !expanded && (
        <button
          type="button"
          data-testid="tool-show-more"
          onClick={() => setExpanded(true)}
          className="ml-[56px] mt-1 text-[11px] text-indigo-500 hover:underline"
        >
          Show more ({lines.length - maxLines} more lines)
        </button>
      )}
      {overflow && expanded && (
        <button
          type="button"
          data-testid="tool-show-less"
          onClick={() => setExpanded(false)}
          className="ml-[56px] mt-1 text-[11px] text-indigo-500 hover:underline"
        >
          Show less
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolExecutionItem — live tool-call accordion.
// ---------------------------------------------------------------------------

const STATUS_TONE: Record<ToolExecution["status"], StatusPillTone> = {
  pending: "info",
  success: "success",
  error: "danger",
};

const STATUS_LABEL: Record<ToolExecution["status"], string> = {
  pending: "running",
  success: "done",
  error: "error",
};

export const ToolExecutionItem = memo(function ToolExecutionItem({
  tool,
}: {
  tool: ToolExecution;
}) {
  const [expanded, setExpanded] = useState(false);

  const tone = STATUS_TONE[tool.status];
  const label = STATUS_LABEL[tool.status];
  const duration = tool.durationMs != null ? formatToolDuration(tool.durationMs) : null;

  return (
    <div
      className="rounded-md border border-border text-[12px] my-1"
      data-testid="tool-execution"
      data-status={tool.status}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/50 text-[12px]"
      >
        <Wrench
          aria-hidden="true"
          data-testid="tool-icon"
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />
        <span className="font-mono font-medium" data-testid="tool-name">
          {tool.name}
        </span>
        <StatusPill
          tone={tone}
          size="sm"
          data-testid="tool-status-pill"
          aria-label={`tool ${label}`}
        >
          {tool.status === "pending" && (
            <Loader2 aria-hidden="true" className="mr-1 h-2.5 w-2.5 animate-spin" />
          )}
          {label}
        </StatusPill>
        {duration && (
          <span
            className="font-mono text-[10px] text-muted-foreground"
            data-testid="tool-duration"
          >
            {duration}
          </span>
        )}
        <ChevronRight
          aria-hidden="true"
          data-testid="tool-chevron"
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && (
        <div className="border-t border-border bg-background/40 p-2 space-y-2">
          {tool.input != null && (
            <div data-testid="tool-args-section">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Args
              </div>
              <JsonCodeView value={tool.input} />
            </div>
          )}
          {tool.result != null && (
            <div data-testid="tool-result-section">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Result
              </div>
              <JsonCodeView value={tool.result} />
            </div>
          )}
          {tool.error != null && (
            <div data-testid="tool-error-section">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-destructive">
                Error
              </div>
              <pre className="whitespace-pre-wrap rounded bg-destructive/10 p-2 font-mono text-[11px] text-destructive">
                {tool.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
