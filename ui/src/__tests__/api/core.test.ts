import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiFetch, getApiBaseUrl, getAuthHeaders } from "@/lib/api";
import {
  setActiveServerId,
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
  try { setActiveServerId(LOCAL_SERVER_ID); } catch { /* ignore */ }
  setServerMap([]);
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

  // Regression: SCREAMING_SNAKE_CASE keys nested inside response objects
  // (env vars, header names, secret references, …) must NOT be mangled.
  // Before the fix, `camelToSnake("ALBS_JWT_TOKEN")` produced
  // `"_a_l_b_s__j_w_t__t_o_k_e_n"` because the regex blindly inserts an
  // underscore before every uppercase letter — surfacing in the UI as
  // garbled env var names on the MCP servers panel.
  it("preserves SCREAMING_SNAKE_CASE keys nested in response (e.g. MCP env)", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        config: {
          command: "albs-mcp",
          env: {
            ALBS_JWT_TOKEN: "${secret:ALBS_JWT_TOKEN}",
            HTTP_PROXY: "http://proxy.local:8080",
          },
        },
      }),
    );
    const res = await apiFetch<any>("/x");
    expect(res.config.env).toEqual({
      ALBS_JWT_TOKEN: "${secret:ALBS_JWT_TOKEN}",
      HTTP_PROXY: "http://proxy.local:8080",
    });
    // Specifically guard against the historical corruption shape.
    expect(res.config.env).not.toHaveProperty("_a_l_b_s__j_w_t__t_o_k_e_n");
  });

  it("preserves single-word ALL_CAPS keys (acronyms)", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({ headers: { ETAG: "abc", URL: "http://x" } }),
    );
    const res = await apiFetch<any>("/x");
    expect(res.headers).toEqual({ ETAG: "abc", URL: "http://x" });
  });

  it("still converts true camelCase keys to snake_case (mixed-case unchanged)", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({ fooBar: 1, alreadySnake_case: 2 }),
    );
    const res = await apiFetch<any>("/x");
    expect(res.foo_bar).toBe(1);
    // mixed camel + snake still gets normalised
    expect(res.already_snake_case).toBe(2);
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

    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
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

    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sentBody).toEqual({ some_key: 1 });
  });

  it("leaves non-JSON body strings as-is", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    (globalThis as any).fetch = fetchMock;

    await apiFetch("/x", {
      method: "POST",
      body: "plain-text-body",
    });

    expect(fetchMock.mock.calls[0]![1].body).toBe("plain-text-body");
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
  it("returns the local base URL for the local server", () => {
    setActiveServerId(LOCAL_SERVER_ID);
    // Production fallback is `http://127.0.0.1:52077`, but the vitest config
    // pins VITE_API_URL to "" so assertions in other suites can compare
    // against plain request paths.
    expect(getApiBaseUrl()).toBe("");
  });

  it("returns no Authorization header for local server", () => {
    setActiveServerId(LOCAL_SERVER_ID);
    expect(getAuthHeaders()).toEqual({});
  });

  it("returns http://127.0.0.1:<tunnelPort> for a registered remote server", () => {
    setServerMap([{ id: "srv-1", tunnelPort: 48123 }]);
    setActiveServerId("srv-1");
    try {
      expect(getApiBaseUrl()).toBe("http://127.0.0.1:48123");
    } finally {
      setActiveServerId(LOCAL_SERVER_ID);
    }
  });

  it("returns no Authorization header even for remote servers (tunnel is transparent)", () => {
    setServerMap([{ id: "srv-1", tunnelPort: 48123 }]);
    setActiveServerId("srv-1");
    try {
      expect(getAuthHeaders()).toEqual({});
    } finally {
      setActiveServerId(LOCAL_SERVER_ID);
    }
  });

  it("throws when the active remote server has no tunnel port registered", () => {
    // Negative-path contract: the caller must not invoke getApiBaseUrl()
    // before the tunnel is ready. A throw here signals the bug directly
    // instead of silently falling back to the local URL.
    setServerMap([]);
    setActiveServerId("not-yet-tunnelled");
    try {
      expect(() => getApiBaseUrl()).toThrow(/no tunnel port/);
    } finally {
      setActiveServerId(LOCAL_SERVER_ID);
    }
  });
});
