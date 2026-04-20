import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import Database from "better-sqlite3";

let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => {
  sqlite.close();
});

describe("Schedules routes", () => {
  it("GET /schedules returns empty list", async () => {
    const res = await app.request("/schedules");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("POST /schedules creates a cron schedule", async () => {
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheduleType: "cron",
        cronExpression: "0 */6 * * *",
        timezone: "UTC",
      }),
    });
    expect(res.status).toBe(201);
    const sched = await res.json();
    expect(sched.scheduleType).toBe("cron");
    expect(sched.status).toBe("active");
  });

  it("GET /schedules/:id returns schedule", async () => {
    const res = await app.request("/schedules/1");
    expect(res.status).toBe(200);
    const sched = await res.json();
    expect(sched.cronExpression).toBe("0 */6 * * *");
  });

  it("POST /schedules/:id/pause pauses active schedule", async () => {
    const res = await app.request("/schedules/1/pause", { method: "POST" });
    expect(res.status).toBe(200);
    const sched = await res.json();
    expect(sched.status).toBe("paused");
  });

  it("POST /schedules/:id/resume resumes paused schedule", async () => {
    const res = await app.request("/schedules/1/resume", { method: "POST" });
    expect(res.status).toBe(200);
    const sched = await res.json();
    expect(sched.status).toBe("active");
  });

  it("DELETE /schedules/:id deletes schedule", async () => {
    const delRes = await app.request("/schedules/1", { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const getRes = await app.request("/schedules/1");
    expect(getRes.status).toBe(404);
  });

  it("POST /schedules requires scheduleType", async () => {
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });
});
