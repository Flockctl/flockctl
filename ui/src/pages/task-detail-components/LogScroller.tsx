import { useEffect, useRef, type ReactNode } from "react";
import { LogLine, type LogLineProps } from "./LogLine";

/**
 * LogScroller — auto-scrolling log container for task-detail (M19/02).
 *
 * Behaviours preserved from the audit:
 *   - Auto-scroll to the bottom on every new log line, **unless** the
 *     user has scrolled up. The "stuck-to-bottom" boolean is derived
 *     from `scrollHeight - scrollTop - clientHeight < 40` (same
 *     threshold as the existing implementation).
 *   - Inline children (permission prompts, agent-question prompts)
 *     are rendered between log lines via the `interleave` prop —
 *     they participate in the same scroll container so the user
 *     sees them in chronological context.
 *
 * The component is presentational; it does NOT subscribe to the WS
 * stream itself. Callers (the page) own `useTaskLogStream` and pass
 * the rendered list down via `lines`.
 */

export interface LogScrollerProps {
  lines: ReadonlyArray<LogLineProps>;
  /**
   * Optional inline elements interleaved with log lines. Map keys
   * are the index AFTER which the element should render — pass `0`
   * to render before the first line, `lines.length` for after the
   * last. Stable across renders so reordering doesn't re-mount.
   */
  interleave?: Map<number, ReactNode>;
  /** Optional className override on the outer scroll container. */
  className?: string;
  /** Click handler forwarded to each LogLine (for diff-eligible rows). */
  onLineClick?: (index: number) => void;
}

export function LogScroller({
  lines,
  interleave,
  className,
  onLineClick,
}: LogScrollerProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const userScrolledUp = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      userScrolledUp.current = !atBottom;
    };
    el.addEventListener("scroll", handler);
    return () => el.removeEventListener("scroll", handler);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!userScrolledUp.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines.length]);

  return (
    <div
      ref={ref}
      data-testid="log-scroller"
      className={
        className ??
        "h-[420px] overflow-y-auto rounded-lg border bg-background"
      }
    >
      {interleave?.has(0) && <div data-testid="log-interleave-0">{interleave.get(0)}</div>}
      {lines.map((line, i) => (
        <span key={`l-${i}`}>
          <LogLine
            ts={line.ts}
            streamType={line.streamType}
            content={line.content}
            onClick={onLineClick ? () => onLineClick(i) : line.onClick}
          />
          {interleave?.has(i + 1) && (
            <div data-testid={`log-interleave-${i + 1}`}>{interleave.get(i + 1)}</div>
          )}
        </span>
      ))}
      {lines.length === 0 && (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Waiting for output…
        </div>
      )}
    </div>
  );
}

export default LogScroller;
