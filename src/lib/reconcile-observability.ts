// Shared observability helper for `setImmediate(() => reconcile())` fire-and-
// forget paths in routes (skills, mcp, projects, secrets).
//
// Audit-round-3 finding: every queueReconcile catch block logged the
// failure but had no out-of-process surface — operators only saw it if
// they happened to be tailing the daemon log. Now we ALSO broadcast a
// `reconcile_failed` WS envelope so the UI can show a toast / banner,
// and keep the existing console.error for forensics.
//
// The envelope is intentionally narrow:
//   { type: "reconcile_failed", scope: string, target?: string|number, error: string }
// The UI's dispatcher can branch on `scope` to render a context-aware
// message ("Workspace skills reconcile failed", "Global MCP reconcile
// failed", etc.) without having to learn every individual call site.

import { wsManager } from "../services/ws-manager.js";

export interface ReconcileFailureContext {
  /** Coarse scope tag — e.g. "skills:global", "mcp:workspace", "projects". */
  scope: string;
  /** Optional target id — workspaceId / projectId — for UI deep-link. */
  target?: string | number;
}

/**
 * Run a reconcile callback and uniformly handle thrown / rejected
 * errors. Use inside `setImmediate(() => ...)` to keep the fire-and-
 * forget reconcile off the HTTP critical path while still ensuring
 * failures don't disappear silently.
 *
 * Returns a Promise that resolves either way — never throws — so a
 * sync caller can `void` it safely.
 */
export async function runReconcileWithObservability(
  ctx: ReconcileFailureContext,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const label = ctx.target !== undefined ? `${ctx.scope}:${ctx.target}` : ctx.scope;
    console.error(`[reconcile:${label}] failed:`, err);
    try {
      wsManager.broadcastAll({
        type: "reconcile_failed",
        scope: ctx.scope,
        ...(ctx.target !== undefined ? { target: ctx.target } : {}),
        error: message.slice(0, 500),
      });
    } catch {
      // Broadcasting must never crash the reconcile path — the ws
      // manager can throw if we're racing a shutdown. Swallow.
    }
  }
}
