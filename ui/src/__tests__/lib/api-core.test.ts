import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiFetch, getApiBaseUrl, getAuthHeaders } from "@/lib/api";
import {
  setActiveServerId,
  cacheToken,
  clearTokenCache,
  setServerMap,
  LOCAL_SERVER_ID,
} from "@/lib/server-store";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let lsStore: Record<string, string> = {};
const mockLs = {
  getItem: (k: string) => (k in lsStore ? lsStore[k] : null),
  setItem: (k: string, v: string) => { lsStore[k] = v; },
  removeItem: (k: string) => { delete lsStore[k]; },
  clear: () => { lsStore = {}; },
  key: () => null,
  length: 0,
};

beforeEach(() => {
  lsStore = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: mockLs,
    configurable: true,
    writable: true,
  });
  try { setActiveServerId(LOCAL_SERVER_ID); } catch {}
  clearTokenCache();
});

describe("apiFetch — response key conversion", () => {
  it("camelCase response → snake_case keys", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({ someKey: 1, nestedObj: { innerKey: "v" } }),
    );
    const res = await apiFetch<any>("/x");
    expect(res.some_key).toBe(1);
    expect(res.nested_obj.inner_key).toBe("v");
  });

  it("stringifies integer IDs (id / *_id)", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({ id: 42, userId: 7, count: 3 }),
    );
    const res = await apiFetch<any>("/x");
    expect(res.id).toBe("42");
    expect(res.user_id).toBe("7");
    expect(res.count).toBe(3);
  });

  it("parses JSON-encoded string fields", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({ listField: '["a","b"]', objField: '{"k":1}' }),
    );
    const res = await apiFetch<any>("/x");
    expect(res.list_field).toEqual(["a", "b"]);
    expect(res.obj_field).toEqual({ k: 1 });
  });

  it("leaves malformed JSON strings untouched", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({ value: "[not json" }),
    );
    const res = await apiFetch<any>("/x");
    expect(res.value).toBe("[not json");
  });

  it("rawKeys=true skips response conversion", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({ someKey: 1 }),
    );
    const res = await apiFetch<any>("/x", { rawKeys: true });
    expect(res.someKey).toBe(1);
    expect(res.some_key).toBeUndefined();
  });

  it("returns undefined for empty body", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      new Response("", { status: 200 }),
    );
    const res = await apiFetch<any>("/x");
    expect(res).toBeUndefined();
  });

  it("preserves arrays in response", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse([{ keyName: 1 }, { keyName: 2 }]),
    );
    const res = await apiFetch<any[]>("/x");
    expect(res[0].key_name).toBe(1);
    expect(res[1].key_name).toBe(2);
  });
});

describe("apiFetch — request body key conversion", () => {
  it("outgoing body snake_case → camelCase", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    (globalThis as any).fetch = fetchMock;

    await apiFetch("/x", {
      method: "POST",
      body: JSON.stringify({ some_key: 1, nested_key: { inner_key: "v" } }),
    });

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    // toCamelKeys converts all top-level keys but doesn't recurse into values
    expect(sentBody).toEqual({ someKey: 1, nestedKey: { inner_key: "v" } });
  });

  it("rawKeys=true skips outgoing conversion", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    (globalThis as any).fetch = fetchMock;

    await apiFetch("/x", {
      method: "POST",
      body: JSON.stringify({ some_key: 1 }),
      rawKeys: true,
    });

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody).toEqual({ some_key: 1 });
  });

  it("leaves non-JSON body strings as-is", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    (globalThis as any).fetch = fetchMock;

    await apiFetch("/x", {
      method: "POST",
      body: "plain-text-body",
    });

    expect(fetchMock.mock.calls[0][1].body).toBe("plain-text-body");
  });
});

describe("apiFetch — error handling", () => {
  it("throws with server-provided error field", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "bad input" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(apiFetch("/x")).rejects.toThrow("bad input");
  });

  it("falls back to detail field", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "slot taken" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(apiFetch("/x")).rejects.toThrow("slot taken");
  });

  it("falls back to `API error <status>` when body is not JSON", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      new Response("<html>oops</html>", { status: 500, statusText: "Server" }),
    );
    await expect(apiFetch("/x")).rejects.toThrow(/Server|API error 500/);
  });
});

describe("getApiBaseUrl / getAuthHeaders", () => {
  it("returns no Authorization header for local server", () => {
    setActiveServerId(LOCAL_SERVER_ID);
    expect(getAuthHeaders()).toEqual({});
  });

  it("returns Bearer token for remote server with cached token", () => {
    setServerMap([{ id: "srv-1", url: "http://remote" }]);
    cacheToken("srv-1", "T123");
    setActiveServerId("srv-1");
    try {
      expect(getApiBaseUrl()).toBe("http://remote");
      expect(getAuthHeaders()).toEqual({ Authorization: "Bearer T123" });
    } finally {
      setActiveServerId(LOCAL_SERVER_ID);
    }
  });

  it("falls back to local URL when remote server id is not in map", () => {
    setServerMap([]);
    setActiveServerId("unknown");
    try {
      expect(getApiBaseUrl()).toBe(""); // LOCAL_API_URL is empty in tests
    } finally {
      setActiveServerId(LOCAL_SERVER_ID);
    }
  });
});
