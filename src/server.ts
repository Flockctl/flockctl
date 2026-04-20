import { Hono } from "hono";
import { cors } from "hono/cors";
import { createNodeWebSocket } from "@hono/node-ws";
import { hostname } from "os";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, extname, join, normalize } from "path";
import { fileURLToPath } from "url";
import { AppError } from "./lib/errors.js";
import { wsManager } from "./services/ws-manager.js";
import {
  hasRemoteAuth,
  getCorsAllowedOrigins,
} from "./config.js";
import { remoteAuth, verifyWsToken } from "./middleware/remote-auth.js";

// Import routes
import { taskRoutes } from "./routes/tasks.js";
import { projectRoutes } from "./routes/projects.js";
import { chatRoutes } from "./routes/chats.js";
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

// Health check — must be reachable without auth for connection probes
app.get("/health", (c) =>
  c.json({
    status: "ok",
    version: process.env.npm_package_version ?? "unknown",
    hostname: hostname(),
  }),
);

// API routes (no auth — local tool)
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

// Error handler
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: err.message, details: err.details }, err.statusCode as any);
  }
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
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
