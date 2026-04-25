import { createMiddleware } from "hono/factory";
import { randomUUID } from "crypto";

/**
 * HTTP access log with per-request correlation ID.
 *
 * Stores the generated `requestId` on the Hono context under key `"requestId"`
 * so route handlers and the global error handler can thread it back into error
 * responses and logs. Format intentionally minimal (single line per request)
 * — Flockctl is a local daemon and there is no log shipper to consume JSON.
 *
 * Suppresses noisy paths (WebSocket upgrades, health checks) to keep the
 * terminal readable when the UI is polling.
 */
const SILENT_PATHS = new Set(["/health"]);

function shouldLog(path: string): boolean {
  if (SILENT_PATHS.has(path)) return false;
  if (path.startsWith("/ws/")) return false;
  return true;
}

export const requestLogger = createMiddleware<{
  Variables: { requestId: string };
}>(async (c, next) => {
  const id = randomUUID();
  c.set("requestId", id);

  if (!shouldLog(c.req.path)) {
    await next();
    return;
  }

  const start = Date.now();
  await next();
  const ms = Date.now() - start;
   
  console.log(
    `[${id.slice(0, 8)}] ${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`,
  );
});
