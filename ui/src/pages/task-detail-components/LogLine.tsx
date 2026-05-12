import { cn } from "@/lib/utils";

/**
 * LogLine — a single row in the task-detail streaming log (M19/02).
 *
 * Pure presentational. Stream-type colour mapping mirrors the existing
 * `logLineClass()` helper in `pages/task-detail.tsx` so the visual
 * output is the same set of colours the operator is already used to.
 *
 * The component renders `[hh:mm:ss] [stream_type] content` with the
 * timestamp + badge fixed-width so successive lines align cleanly.
 * Long content wraps inside the row; ANSI is preserved verbatim
 * because the server hands us pre-decoded text.
 */

export interface LogLineProps {
  ts: number | string | null | undefined;
  /** stdout / stderr / system / tool_call / tool_result / agent / etc. */
  streamType: string;
  content: string;
  /**
   * Optional click target for diff-eligible lines (e.g. a "wrote
   * file foo.ts" log entry). When set, the row becomes interactive.
   */
  onClick?: () => void;
}

const STREAM_TONE: Record<string, string> = {
  stdout: "text-foreground/85",
  stderr: "text-red-600 dark:text-red-400",
  system: "text-muted-foreground",
  agent: "text-emerald-600 dark:text-emerald-400",
  tool_call: "text-blue-600 dark:text-blue-400",
  tool_result: "text-blue-500/80 dark:text-blue-400/80",
  permission: "text-amber-600 dark:text-amber-400",
  question: "text-yellow-600 dark:text-yellow-400",
  user: "text-foreground",
};

function formatTs(ts: LogLineProps["ts"]): string {
  if (ts == null) return "—";
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toTimeString().slice(0, 8); // hh:mm:ss
}

export function LogLine({ ts, streamType, content, onClick }: LogLineProps) {
  const tone = STREAM_TONE[streamType] ?? "text-foreground/80";
  const RowTag: "button" | "div" = onClick ? "button" : "div";
  return (
    <RowTag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      data-testid="log-line"
      data-stream-type={streamType}
      className={cn(
        "flex w-full items-baseline gap-2 px-3 py-1 font-mono text-[12.5px] leading-snug",
        onClick && "cursor-pointer text-left hover:bg-accent/40",
      )}
    >
      <span className="w-[68px] shrink-0 text-right text-[10.5px] text-muted-foreground">
        {formatTs(ts)}
      </span>
      <span
        className={cn(
          "w-[88px] shrink-0 truncate text-[10px] font-semibold uppercase tracking-wider",
          tone,
        )}
      >
        {streamType}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground/90">
        {content}
      </span>
    </RowTag>
  );
}

export default LogLine;
