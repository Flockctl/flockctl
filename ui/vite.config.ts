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
  "/metrics", "/secrets", "/attention", "/fs", "/incidents", "/missions",
  "/wakeups", "/worktrees",
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
  build: {
    // 940 KiB CodeEditor.lazy + 5.6 MB ts.worker are intentional outliers
    // (lazy-loaded Monaco). Bumping the warning threshold prevents noise
    // without hiding accidental bloat from new code.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Vendor splits give cross-route cache hits. Each entry below
        // becomes a single chunk shared by every page that lazy-imports it.
        //
        // Intentionally NOT splitting monaco-editor: its ESM build has many
        // internal circular imports. Pulling every `monaco-editor/**` module
        // into one named chunk breaks the wrapper-IIFE evaluation order and
        // surfaces at runtime as `n.create is not a function`. CodeEditor
        // already lazy-loads monaco; Vite's default per-import splitting is
        // correct for that case — don't override it.
        manualChunks(id) {
          // Stable + heavy: shared by Analytics + RunsTab + ProjectDetail.
          if (id.includes("node_modules/recharts/")) return "recharts"
          // React core — pinned together so a router-only route still ships
          // the same react/react-dom bundle the rest of the app uses.
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/react-router-dom/")
          )
            return "react-vendor"
          // Markdown stack — used by chat + incident + plan views.
          if (
            id.includes("node_modules/react-markdown/") ||
            id.includes("node_modules/remark-gfm/") ||
            id.includes("node_modules/rehype-highlight/")
          )
            return "markdown"
          return undefined
        },
      },
    },
  },
})
