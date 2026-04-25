import { memo, useMemo, useState } from "react";
import { ChevronRight, Loader2, Check, X, Wrench, Brain } from "lucide-react";
import { InlineDiff, synthesizeDiffFromEdit } from "@/components/InlineDiff";

export interface ToolExecution {
  id: string;
  name: string;
  input: unknown;
  status: "pending" | "success" | "error";
  result?: Record<string, unknown> | string;
  error?: string;
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
 */
export function StoredToolMessageItem({
  id,
  content,
}: {
  id: string | number;
  content: string | Record<string, unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const payload = useMemo(() => parseStoredTool(content), [content]);

  if (!payload) return null;

  const detail =
    payload.kind === "call" ? payload.input : payload.output;
  const detailText =
    typeof detail === "string"
      ? detail
      : detail === undefined
        ? ""
        : JSON.stringify(detail, null, 2);

  // When the tool call is an edit (Edit / Write / str_replace variants),
  // synthesize a unified diff from the call input so the expanded body
  // shows the same structured diff view used in the task page instead
  // of a raw JSON blob.
  const editDiff = payload.kind === "call" ? tryBuildEditDiff(payload.name, payload.input) : null;

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
      </button>
      {expanded && editDiff && (
        <div className="border-t border-border bg-background/60 p-2">
          <InlineDiff diff={editDiff} />
        </div>
      )}
      {expanded && !editDiff && detailText && (
        <pre className="max-h-48 overflow-auto border-t border-border bg-muted/40 p-2 text-[10px]">
          {detailText}
        </pre>
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
    ? "Thinking\u2026"
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

export const ToolExecutionItem = memo(function ToolExecutionItem({ tool }: { tool: ToolExecution }) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = tool.status === "pending"
    ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
    : tool.status === "success"
    ? <Check className="h-3 w-3 text-green-500" />
    : <X className="h-3 w-3 text-destructive" />;

  return (
    <div className="rounded border border-border text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1 hover:bg-accent/50"
        onClick={() => setExpanded(v => !v)}
      >
        <ChevronRight className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
        <Wrench className="h-3 w-3 text-muted-foreground" />
        <span className="font-medium">{tool.name}</span>
        <span className="ml-auto">{statusIcon}</span>
      </button>
      {expanded && (
        <div className="border-t border-border px-2 py-1.5 space-y-1">
          {tool.input != null && (
            <div>
              <span className="text-muted-foreground">Input:</span>
              <pre className="mt-0.5 max-h-32 overflow-auto rounded bg-muted p-1 text-[10px]">
                {typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.result != null && (
            <div>
              <span className="text-muted-foreground">Result:</span>
              <pre className="mt-0.5 max-h-32 overflow-auto rounded bg-muted p-1 text-[10px]">
                {typeof tool.result === "string" ? tool.result : JSON.stringify(tool.result, null, 2)}
              </pre>
            </div>
          )}
          {tool.error != null && (
            <div>
              <span className="text-destructive">Error:</span>
              <pre className="mt-0.5 max-h-32 overflow-auto rounded bg-destructive/10 p-1 text-[10px] text-destructive">
                {tool.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
