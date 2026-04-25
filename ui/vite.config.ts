import path from "path"
import type { IncomingMessage } from "node:http"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const API_TARGET = process.env.VITE_API_TARGET ?? "http://localhost:52077"
const WS_TARGET = API_TARGET.replace(/^http/, "ws")

/** Skip proxy for browser navigation (Accept: text/html) so Vite serves the SPA */
function bypassForHtml(req: IncomingMessage) {
  if (req.headers.accept?.includes("text/html")) {
    return "/index.html"
  }
}

const apiRoutes = [
  "/tasks", "/projects", "/chats", "/templates", "/schedules",
  "/workspaces", "/keys", "/skills", "/mcp", "/health", "/usage", "/meta",
  "/metrics", "/secrets", "/attention", "/fs", "/incidents",
]

const proxy: Record<string, object> = {}
for (const route of apiRoutes) {
  proxy[route] = { target: API_TARGET, bypass: bypassForHtml, timeout: 600_000, proxyTimeout: 600_000 }
}
proxy["/ws"] = { target: WS_TARGET, ws: true }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: { proxy },
})
