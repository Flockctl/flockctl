import { Hono } from "hono";
import { cors } from "hono/cors";
import { createNodeWebSocket } from "@hono/node-ws";
import { hostname } from "os";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, extname, join, normalize } from "path";
import { fileURLToPath } from "url";
import { AppError } from "./lib/errors.js";
import { getPackageVersion } from "./lib/package-version.js";
import { wsManager } from "./services/ws-manager.js";
import {
  hasRemoteAuth,
  getCorsAllowedOrigins,
} from "./config/index.js";
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

const app = new Hono();

const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

// Middleware — dynamic CORS: allow all in local-only mode; restrict to a
// whitelist once a remote access token is configured.
app.use("/*", (c, next) => {
  if (!hasRemoteAuth()) return cors()(c, next);
  const allowed = getCorsAllowedOrigins();
  return cors({
    origin: allowed && allowed.length > 0 ? allowed : "*",
    credentials: false,
  })(c, next);
});

// Ensure JSON responses have charset=UTF-8
app.use("/*", async (c, next) => {
  await next();
  const ct = c.res.headers.get("content-type");
  if (ct && ct.startsWith("application/json") && !ct.includes("charset")) {
    c.res.headers.set("content-type", "application/json; charset=UTF-8");
  }
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
      // Asset request — serve the file if present, otherwise let routes handle it
      const resolved = normalize(join(uiDist, urlPath));
      if (
        resolved.startsWith(uiDist) &&
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
    return c.html(readFileSync(indexPath, "utf-8"));
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
