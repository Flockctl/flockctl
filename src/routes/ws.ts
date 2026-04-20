import { Hono } from "hono";
import { wsManager } from "../services/ws-manager.js";

export const wsRoutes = new Hono();

// WebSocket upgrade handled by @hono/node-server
// This route provides a simple fallback for HTTP polling
wsRoutes.get("/status", (c) => {
  return c.json({ clients: wsManager.clientCount });
});
