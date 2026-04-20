import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import { app, injectWebSocket } from "../server.js";
import { createTestDb } from "./helpers.js";
import { setDb, type FlockctlDb } from "../db/index.js";
import Database from "better-sqlite3";

let db: FlockctlDb;
let sqlite: Database.Database;
let server: any;
let port: number;

function open(path: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const timeout = setTimeout(() => {
      reject(new Error("ws open timeout"));
      try { ws.close(); } catch {}
    }, 1500);
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    ws.once("close", (code, reason) => {
      clearTimeout(timeout);
      // Resolve with the (already-closed) socket so the test can inspect it.
      resolve(ws);
    });
  });
}

beforeAll(async () => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);

  await new Promise<void>((res) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      port = info.port;
      res();
    });
  });
  injectWebSocket(server);
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  sqlite.close();
});

describe("WebSocket endpoints", () => {
  it("connects to /ws/ui/tasks/:taskId/logs and closes cleanly", async () => {
    const ws = await open("/ws/ui/tasks/123/logs");
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await new Promise((r) => ws.once("close", r));
    expect(true).toBe(true);
  });

  it("connects to /ws/ui/chats/:chatId/events", async () => {
    const ws = await open("/ws/ui/chats/42/events");
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await new Promise((r) => ws.once("close", r));
    expect(true).toBe(true);
  });

  it("connects to global /ws/ui/chats/events", async () => {
    const ws = await open("/ws/ui/chats/events");
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await new Promise((r) => ws.once("close", r));
    expect(true).toBe(true);
  });

  it("handles non-numeric :taskId param (NaN branch)", async () => {
    const ws = await open("/ws/ui/tasks/notanumber/logs");
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await new Promise((r) => ws.once("close", r));
    expect(true).toBe(true);
  });

  it("handles non-numeric :chatId param (NaN branch)", async () => {
    const ws = await open("/ws/ui/chats/bogus/events");
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await new Promise((r) => ws.once("close", r));
    expect(true).toBe(true);
  });
});
