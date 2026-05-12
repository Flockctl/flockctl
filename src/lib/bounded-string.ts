// ─── Bounded string accumulator ───
//
// Replacement for the `let s = ""; s += chunk;` pattern that streamed event
// handlers naïvely use. Two reasons that pattern is bad:
//
//   1. **Quadratic CPU.** Each `s += chunk` allocates a new string of length
//      `(old + chunk)`. Across `n` chunks of average size `c`, total work is
//      `O(n² · c)`. Streaming a 10 MB Claude turn through 200 K small
//      `text` deltas spends seconds in string concatenation alone.
//
//   2. **Unbounded memory.** A runaway provider (or a malicious one that
//      never sends `result`) can stream gigabytes into the same string,
//      pinning that much heap until the SDK iterator either yields end or
//      the daemon OOMs. The chat session never had a hard ceiling.
//
// The class below fixes both with a chunk buffer:
//   * `append(chunk)` is amortised O(1) (push into array).
//   * `toString()` joins the array once (linear in total bytes).
//   * `maxBytes` hard cap collapses the buffer to a sliding tail when
//     exceeded — head-of-stream is discarded because the tail is where
//     errors / final summaries usually live (mirrors `appendBounded` in
//     `src/services/ssh-tunnels/ssh-exec.ts:248-253` and the git push
//     stderr capture in `git-operations.ts`).
//
// Why a class rather than a free function:
//   The hot call sites are `session.on("text", chunk => …)` listeners
//   bound at chat-stream setup time. A class gives them a stable `this`
//   to call `.append` on without re-allocating a closure per chunk, and
//   keeps the `chunks: string[]` buffer encapsulated so callers can't
//   accidentally mutate it mid-flight.

/** Hard cap for chat LLM streams. 8 MiB covers any legitimate Claude turn
 *  (typical: <100 KiB), but blocks a runaway provider from OOM-ing the
 *  daemon. Sized to leave headroom for the SDK's own buffering. */
export const MAX_CHAT_STREAM_BYTES = 8 * 1024 * 1024;

export class BoundedStringAccumulator {
  private chunks: string[] = [];
  private totalLen = 0;
  private wasTruncated = false;

  constructor(private readonly maxBytes: number = MAX_CHAT_STREAM_BYTES) {}

  /** Append `chunk` to the buffer. O(1) amortised. On overflow, collapses
   *  the buffer to a single tail-bounded string and continues. */
  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.totalLen += chunk.length;
    if (this.totalLen > this.maxBytes) {
      this.wasTruncated = true;
      // Drain to a single string, keep only the tail.
      const joined = this.chunks.join("");
      const trimmed = joined.slice(-this.maxBytes);
      this.chunks.length = 0;
      this.chunks.push(trimmed);
      this.totalLen = trimmed.length;
    }
  }

  /** Materialise the buffered content as a single string. Idempotent —
   *  subsequent calls re-use the cached single-chunk result. */
  toString(): string {
    if (this.chunks.length === 0) return "";
    if (this.chunks.length === 1) return this.chunks[0]!;
    const joined = this.chunks.join("");
    this.chunks.length = 0;
    this.chunks.push(joined);
    return joined;
  }

  /** Total length of the buffered content (not counting any truncated head). */
  get length(): number {
    return this.totalLen;
  }

  /** Whether any append caused a truncation (head discard). Surfaced by
   *  some callers for observability. */
  get truncated(): boolean {
    return this.wasTruncated;
  }

  /** Drop everything and return to the empty state. Some callers reuse the
   *  same accumulator across pending → flushed transitions. */
  clear(): void {
    this.chunks.length = 0;
    this.totalLen = 0;
    this.wasTruncated = false;
  }
}

/**
 * Free-function variant of the slide-tail pattern for hot loops that
 * already operate on a plain `let s = ""` and don't benefit from the class
 * wrapper (e.g. `git push` stderr capture, `ssh-exec` outputs). Linear
 * over the new chunk size; total cost is still O(n²) over many chunks, so
 * prefer `BoundedStringAccumulator` for streamed callers.
 */
export function appendBounded(
  prev: string,
  chunk: string,
  maxBytes: number,
): string {
  const combined = prev + chunk;
  return combined.length <= maxBytes ? combined : combined.slice(-maxBytes);
}
