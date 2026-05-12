import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { createNodeWebSocket } from "@hono/node-ws";
import { hostname } from "os";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, extname, join, normalize, sep } from "path";
import { fileURLToPath } from "url";
import { AppError } from "./lib/errors.js";
import { normalizeTimestampsDeep } from "./lib/normalize-timestamps.js";
import { getPackageVersion } from "./lib/package-version.js";
import { wsManager } from "./services/ws-manager.js";
import {
  hasRemoteAuth,
  getCorsAllowedOrigins,
} from "./config/index.js";
import { DEFAULT_DAEMON_PORT } from "./config/defaults.js";
import { remoteAuth, verifyWsToken } from "./middleware/remote-auth.js";
import { requestLogger } from "./middleware/request-logger.js";

// Import routes
import { taskRoutes } from "./routes/tasks/index.js";
import { projectRoutes } from "./routes/projects.js";
import { chatRoutes } from "./routes/chats/index.js";
import { planningRoutes } from "./routes/planning.js";
import { wsRoutes } from "./routes/ws.js";
import { templateRoutes } from "./routes/templates.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { skillRoutes } from "./routes/skills.js";
import { usageRoutes } from "./routes/usage.js";
import { mcpRoutes } from "./routes/mcp.js";
import { secretRoutes } from "./routes/secrets.js";
import { metaRoutes } from "./routes/meta.js";
import { aiKeyRoutes } from "./routes/ai-keys.js";
import { metricsRoutes } from "./routes/metrics.js";
import { fsRoutes } from "./routes/fs.js";
import { attentionRoutes } from "./routes/attention.js";
import { incidentRoutes } from "./routes/incidents.js";
import { missionRoutes } from "./routes/missions.js";
import { wakeupRoutes } from "./routes/wakeups.js";
import { worktreeRoutes } from "./routes/worktrees.js";

const app = new Hono();

const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

// gzip JSON / text bodies for clients that advertise `Accept-Encoding: gzip`.
// Hono's built-in middleware streams via the global `CompressionStream` (Node
// 18+), so the only runtime cost on a small body is a header inspection. The
// middleware skips compression entirely when the client doesn't ask for it
// and when the response is already encoded — see `hono/compress` source.
//
// Why early in the chain: it has to run before route handlers so the response
// stream it wraps is the one returning to the client. Placing it ahead of
// CORS / auth costs nothing because both of those preserve the body intact;
// the savings on a 50 k-entry `/fs/index` payload (~5-10× reduction thanks to
// shared path prefixes) outweigh the per-request overhead on every route.
app.use("/*", compress());

// Defense-in-depth body size cap.
//
// Without this, any authenticated (or localhost-bypass) caller could POST
// multi-gigabyte JSON to e.g. /missions/.../decide or /chats/:id/attachments,
// forcing Node to buffer the whole body in RAM before route-level zod schemas
// even get a chance to reject it. The cap is set above MAX_ATTACHMENT_BYTES
// (30 MB) so legitimate image/PDF uploads continue to work; the headroom is
// reserved for the multipart wrapper overhead.
//
// Routes that need a tighter cap (e.g. /secrets, /missions) layer their own
// schema-level `.max(...)` on top — see `src/routes/secrets.ts` and the zod
// validators in mission routes.
app.use(
  "/*",
  bodyLimit({
    maxSize: 50 * 1024 * 1024, // 50 MiB
    onError: (c) =>
      c.json({ error: "request body too large", maxSize: 50 * 1024 * 1024 }, 413),
  }),
);

// Middleware — dynamic CORS:
//   - Local-only mode (no remote-access token): allow only loopback origins
//     (127.0.0.1 / localhost / ::1) on the bundled UI port and a small set
//     of common Vite dev ports. Previously we returned `*` here on the
//     reasoning that the daemon was loopback-bound anyway, but that left
//     the door open to drive-by attacks: any tab the user opens (or DNS
//     rebinding payload) could fetch arbitrary endpoints because the
//     browser would honour the wildcard. Restricting to localhost origins
//     defangs that without breaking the legitimate same-origin UI.
//   - Remote-access mode + whitelist configured: restrict to whitelist.
//   - Remote-access mode + empty whitelist: refuse to set Allow-Origin.
//     The previous behaviour fell back to `*` here, which silently negated
//     the security model — a remote-token deployment that forgot to set
//     `corsOrigins` was wide-open to any browser tab on the internet.
//     Now we return null from the origin callback, which omits the
//     `Access-Control-Allow-Origin` header entirely; same-origin requests
//     still pass (browsers don't enforce CORS for them) but cross-origin
//     XHR/fetch is rejected by the browser. A one-shot warning fires the
//     first time we hit this state so the operator sees the misconfig in
//     the daemon log.
const LOCALHOST_CORS_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
// Common Vite/UI dev-server ports plus the bundled daemon port. Adding a few
// well-known dev ports avoids breaking `npm run dev` workflows where the UI
// is served from a different port than the daemon. Operators who run a UI
// on a non-default port can opt into remote-access mode and use `corsOrigins`.
const LOCALHOST_CORS_PORTS = [
  DEFAULT_DAEMON_PORT,  // 52077 — bundled UI served by the daemon itself
  5173, 5174, 5175, 4173, // Vite default + previews
  3000,                  // Next.js / generic dev
];
const LOCALHOST_CORS_ORIGINS = LOCALHOST_CORS_HOSTS.flatMap((host) =>
  LOCALHOST_CORS_PORTS.flatMap((port) => [
    `http://${host}:${port}`,
    `https://${host}:${port}`,
  ]),
);
let warnedEmptyCorsWhitelist = false;
app.use("/*", (c, next) => {
  if (!hasRemoteAuth()) {
    return cors({ origin: LOCALHOST_CORS_ORIGINS, credentials: false })(c, next);
  }
  const allowed = getCorsAllowedOrigins();
  if (!allowed || allowed.length === 0) {
    if (!warnedEmptyCorsWhitelist) {
      warnedEmptyCorsWhitelist = true;
      console.warn(
        "[cors] remote-access token is configured but `corsOrigins` is empty — " +
        "rejecting all cross-origin requests. Set rc.corsOrigins to a whitelist " +
        "(e.g. [\"https://your-ui.example.com\"]) if you intend to serve a browser UI.",
      );
    }
    return cors({ origin: () => null, credentials: false })(c, next);
  }
  return cors({ origin: allowed, credentials: false })(c, next);
});

// Ensure JSON responses have charset=UTF-8
app.use("/*", async (c, next) => {
  await next();
  const ct = c.res.headers.get("content-type");
  if (ct && ct.startsWith("application/json") && !ct.includes("charset")) {
    c.res.headers.set("content-type", "application/json; charset=UTF-8");
  }
});

// Normalise leaked SQLite timestamps in every JSON response.
//
// Why a global middleware instead of fixing each route: ~40 routes return DB
// rows that include columns with `default(datetime('now'))` defaults. Those
// columns are stored as bare `"YYYY-MM-DD HH:MM:SS"` (UTC, but with no `Z`
// marker), which JS clients parse as **local time** — the "everything is 3
// hours off in Moscow" symptom users see in the UI. Doing this at the route
// level would mean adding `.toISOString()` calls in dozens of places and
// remembering to repeat the pattern on every new endpoint forever.
//
// Instead we walk the outgoing JSON once at the response chokepoint and
// rewrite any string that looks like a leaked timestamp into proper ISO-Z
// (`"2026-04-27T17:04:51.000Z"`). The pattern is anchor-strict
// (`^YYYY-MM-DD[ T]HH:MM:SS(.ms)?$`), so non-timestamp strings are not
// touched. ISO values that already carry `Z` or a numeric offset pass through
// unchanged, making the transformation idempotent.
//
// Skipped:
//   - Non-JSON content types (HTML/JS/CSS bundles for the UI, SSE streams,
//     binary downloads). The check on `content-type` keeps the cost zero
//     for those paths.
//   - Streamed JSON (`Transfer-Encoding: chunked` without a JSON body we can
//     parse in one shot). Hono's `c.json()` always materialises before send,
//     so this is fine for the routes we care about.
//
// Why placed before `compress()` runs (compress sits ABOVE this in the chain
// so it wraps the rewritten body): rewrite first, compress the result.
app.use("/*", async (c, next) => {
  await next();
  const ct = c.res.headers.get("content-type");
  if (!ct || !ct.startsWith("application/json")) return;
  // Already-encoded body (e.g. some upstream middleware compressed early) —
  // bail out to avoid double-decoding garbage.
  if (c.res.headers.get("content-encoding")) return;
  let parsed: unknown;
  try {
    // `Response.json()` consumes the body, so we must rebuild a Response
    // afterwards regardless of whether anything changed.
    parsed = await c.res.clone().json();
  } catch {
    // Not actually JSON despite the header (e.g. an empty 204) — leave alone.
    return;
  }
  const normalised = normalizeTimestampsDeep(parsed);
  if (normalised === parsed) return; // Hot path: no leaked timestamps found.
  const headers = new Headers(c.res.headers);
  headers.delete("content-length"); // length will change; let Hono re-set it
  c.res = new Response(JSON.stringify(normalised), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
});

// Request logging + correlation ID (attached before auth so every request
// including rejected ones gets an id recorded).
app.use("/*", requestLogger);

// Remote access auth (no-op if token not configured, localhost bypassed)
app.use("/*", remoteAuth);

// Bundled UI — served only if dist/ui exists next to the compiled server.js.
// Mirrors the dev-mode Accept-header gating in ui/vite.config.ts: browser
// navigation (Accept: text/html) gets the SPA; API clients fall through to
// the routes below so they can return JSON 404s.
const uiDist = join(dirname(fileURLToPath(import.meta.url)), "ui");
const UI_MIME: Record<string, string> = {
  ".html": "text/html; charset=UTF-8",
  ".js": "application/javascript; charset=UTF-8",
  ".mjs": "application/javascript; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=UTF-8",
  ".txt": "text/plain; charset=UTF-8",
};

/* v8 ignore start — the UI-asset middleware branches (existsSync(uiDist)
   false path, mime fallback, missing index.html) depend on whether the
   frontend has been built into `ui/dist` and on which specific asset is
   requested. Tests run against the server without issuing asset requests,
   so the individual branches inside this block aren't reliably coverable
   from the Node test harness — they're exercised by Playwright E2E and
   served directly from disk. */
if (existsSync(uiDist)) {
  app.use("/*", async (c, next) => {
    if (c.req.method !== "GET") return next();
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    const hasExt = /\.[a-zA-Z0-9]+$/.test(urlPath);

    if (hasExt) {
      // Asset request — serve the file if present, otherwise let routes handle it.
      // Use a true separator-boundary check so `uiDist="/app/ui"` doesn't accept
      // `/app/ui-evil/...` (which would startsWith the prefix). Same idiom we
      // use in `safePath` and `services/fs-operations.ts`.
      const resolved = normalize(join(uiDist, urlPath));
      if (
        (resolved === uiDist || resolved.startsWith(uiDist + sep)) &&
        existsSync(resolved) &&
        statSync(resolved).isFile()
      ) {
        const body = readFileSync(resolved);
        const mime = UI_MIME[extname(resolved).toLowerCase()] ?? "application/octet-stream";
        return new Response(new Uint8Array(body), {
          headers: { "content-type": mime },
        });
      }
      return next();
    }

    // Browser navigation → serve the SPA shell. API clients (Accept: */*,
    // application/json) fall through so /tasks/missing returns JSON 404.
    const accept = c.req.header("Accept") ?? "";
    if (!accept.includes("text/html")) return next();
    const indexPath = join(uiDist, "index.html");
    if (!existsSync(indexPath)) return next();
    // Disable HTML caching — `index.html` references content-hashed
    // bundles (`/assets/index-<hash>.js`), so caching the html itself
    // pins the browser to a stale hash that no longer exists on disk
    // after a rebuild. The hashed assets are cacheable indefinitely;
    // the SPA shell must always fetch fresh.
    return c.html(readFileSync(indexPath, "utf-8"), 200, {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
  });
}
/* v8 ignore stop */

// Health check — must be reachable without auth for connection probes
app.get("/health", (c) =>
  c.json({
    status: "ok",
    version: getPackageVersion(),
    hostname: hostname(),
  }),
);

// API routes (no auth — local tool)
app.route("/attention", attentionRoutes);
app.route("/tasks", taskRoutes);
app.route("/projects", projectRoutes);
app.route("/chats", chatRoutes);
app.route("/projects", planningRoutes);  // /projects/:pid/milestones/...
app.route("/templates", templateRoutes);
app.route("/schedules", scheduleRoutes);
app.route("/workspaces", workspaceRoutes);
app.route("/skills", skillRoutes);
app.route("/mcp", mcpRoutes);
app.route("/secrets", secretRoutes);
app.route("/usage", usageRoutes);
app.route("/metrics", metricsRoutes);
app.route("/keys", aiKeyRoutes);
app.route("/meta", metaRoutes);
app.route("/fs", fsRoutes);
app.route("/incidents", incidentRoutes);
app.route("/missions", missionRoutes);
app.route("/wakeups", wakeupRoutes);
app.route("/worktrees", worktreeRoutes);
app.route("/ws", wsRoutes);

// WebSocket endpoint for live task logs
app.get(
  "/ws/ui/tasks/:taskId/logs",
  upgradeWebSocket((c) => {
    const auth = verifyWsToken(c);
    /* v8 ignore start — exercised only with remote auth + non-localhost client */
    if (!auth.ok) {
      return {
        onOpen(_event, ws) {
          ws.close(1008, auth.reason);
        },
      };
    }
    /* v8 ignore stop */
    const taskIdParam = c.req.param("taskId");
    /* v8 ignore next — Hono always supplies the named route param when the route matches; the falsy-param branch is statically unreachable */
    const taskId = taskIdParam ? parseInt(taskIdParam, 10) : NaN;
    return {
      onOpen(_event, ws) {
        const raw = ws.raw as import("ws").WebSocket;
        if (Number.isFinite(taskId)) {
          wsManager.addTaskClient(taskId, raw);
        }
      },
      onClose(_event, ws) {
        const raw = ws.raw as import("ws").WebSocket;
        wsManager.removeClient(raw);
      },
    };
  }),
);

// WebSocket endpoint for live chat events (permission_request, etc.)
app.get(
  "/ws/ui/chats/:chatId/events",
  upgradeWebSocket((c) => {
    const auth = verifyWsToken(c);
    /* v8 ignore start — exercised only with remote auth + non-localhost client */
    if (!auth.ok) {
      return {
        onOpen(_event, ws) {
          ws.close(1008, auth.reason);
        },
      };
    }
    /* v8 ignore stop */
    const chatIdParam = c.req.param("chatId");
    /* v8 ignore next — Hono always supplies the named route param when the route matches; the falsy-param branch is statically unreachable */
    const chatId = chatIdParam ? parseInt(chatIdParam, 10) : NaN;
    return {
      onOpen(_event, ws) {
        const raw = ws.raw as import("ws").WebSocket;
        if (Number.isFinite(chatId)) {
          wsManager.addChatClient(chatId, raw);
        }
      },
      onClose(_event, ws) {
        const raw = ws.raw as import("ws").WebSocket;
        wsManager.removeClient(raw);
      },
    };
  }),
);

// Global chat events stream — carries session_started / session_ended /
// permission_request / permission_resolved for every chat. Used by the chat
// list to render live "running" and "pending approval" indicators without
// needing to subscribe to each chat individually.
app.get(
  "/ws/ui/chats/events",
  upgradeWebSocket((c) => {
    const auth = verifyWsToken(c);
    /* v8 ignore start — exercised only with remote auth + non-localhost client */
    if (!auth.ok) {
      return {
        onOpen(_event, ws) {
          ws.close(1008, auth.reason);
        },
      };
    }
    /* v8 ignore stop */
    return {
      onOpen(_event, ws) {
        const raw = ws.raw as import("ws").WebSocket;
        wsManager.addGlobalChatClient(raw);
      },
      onClose(_event, ws) {
        const raw = ws.raw as import("ws").WebSocket;
        wsManager.removeClient(raw);
      },
    };
  }),
);

// Error handler — enriches responses + logs with the per-request correlation
// ID set by `requestLogger`. Server-side errors (>= 500) dump the full stack
// so the terminal running the daemon has enough context to diagnose without
// needing to reproduce.
app.onError((err, c) => {
  /* v8 ignore next — `requestId` is always set by the request-logger middleware that runs before any handler, so `?? "unknown"` is unreachable in normal app flow */
  const requestId = (c.get("requestId" as never) as string | undefined) ?? "unknown";
  if (err instanceof AppError) {
    /* v8 ignore next 4 — 5xx AppError branch is exercised only by unexpected runtime failures (DB corruption, FS ENOSPC, …); the route-layer throws only 4xx AppError subclasses (ValidationError/NotFoundError/…). Covered indirectly by the non-AppError path below. */
    if (err.statusCode >= 500) {

      console.error(`[${requestId.slice(0, 8)}] AppError (${err.statusCode}):`, err.stack);
    }
    return c.json(
      { error: err.message, details: err.details, requestId },
      err.statusCode as any,
    );
  }

  console.error(`[${requestId.slice(0, 8)}] Unhandled error:`, err);
  return c.json({ error: "Internal server error", requestId }, 500);
});

// 404 handler
app.notFound((c) => c.json({ error: "Not found" }, 404));

export { app, injectWebSocket };

export function startServer(port: number, host: string = "127.0.0.1") {
  import("@hono/node-server").then(({ serve }) => {
    const server = serve({ fetch: app.fetch, port, hostname: host });
    injectWebSocket(server);
    const displayHost = host === "0.0.0.0" || host === "::" ? host : `http://${host}`;
    if (displayHost.startsWith("http")) {
      console.log(`Flockctl running at ${displayHost}:${port}`);
    } else {
      console.log(`Flockctl running on ${displayHost}:${port}`);
    }
  });
}
