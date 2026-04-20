import { describe, it, expect } from "vitest";
import { app } from "../../server.js";

describe("GET /ws/status", () => {
  it("returns client count", async () => {
    const res = await app.request("/ws/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.clients).toBe("number");
    expect(body.clients).toBeGreaterThanOrEqual(0);
  });
});
