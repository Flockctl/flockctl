/**
 * Common boilerplate for queueing post-mutation reconcile work onto the next
 * tick. Routes that mutate `.flockctl/skills/`, `.flockctl/mcp/`, or
 * `.flockctl/secrets/` need to re-render `~/.claude/` cascade state, but they
 * MUST do it after the HTTP response — both to keep request latency tight and
 * to avoid blocking on FS work that can fail without affecting the route's
 * success.
 *
 * The repeated `setImmediate(() => { try { … } catch (err) { console.error(label, err) } })`
 * shape appears 12+ times across `routes/skills.ts`, `routes/mcp.ts`,
 * `routes/projects.ts`, `routes/workspaces.ts`, `routes/secrets.ts`, and
 * `services/task-executor/executor.ts`. This helper centralises the label
 * formatting + try/catch so the call sites read as a single line.
 */
export function deferReconcile(label: string, fn: () => void): void {
  setImmediate(() => {
    try {
      fn();
    } catch (err) {
      console.error(`[${label}] reconcile failed:`, err);
    }
  });
}
