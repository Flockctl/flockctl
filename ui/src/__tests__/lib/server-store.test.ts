import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  LOCAL_SERVER,
  LOCAL_SERVER_ID,
  cacheToken,
  clearCachedToken,
  getCachedToken,
  clearTokenCache,
  setServerMap,
  getServerUrl,
  getActiveServerId,
  setActiveServerId,
} from "@/lib/server-store";

describe("token cache", () => {
  beforeEach(() => clearTokenCache());

  it("caches then retrieves a token", () => {
    cacheToken("s1", "abc");
    expect(getCachedToken("s1")).toBe("abc");
  });

  it("clears individual token", () => {
    cacheToken("s1", "abc");
    clearCachedToken("s1");
    expect(getCachedToken("s1")).toBeUndefined();
  });

  it("clears all tokens", () => {
    cacheToken("s1", "abc");
    cacheToken("s2", "def");
    clearTokenCache();
    expect(getCachedToken("s1")).toBeUndefined();
    expect(getCachedToken("s2")).toBeUndefined();
  });

  it("returns undefined for unknown id", () => {
    expect(getCachedToken("never-cached")).toBeUndefined();
  });
});

describe("server URL map", () => {
  it("sets then retrieves a URL", () => {
    setServerMap([{ id: "a", url: "http://x" }]);
    expect(getServerUrl("a")).toBe("http://x");
  });

  it("replaces the prior map on each set", () => {
    setServerMap([{ id: "a", url: "http://x" }]);
    setServerMap([{ id: "b", url: "http://y" }]);
    expect(getServerUrl("a")).toBeUndefined();
    expect(getServerUrl("b")).toBe("http://y");
  });
});

describe("active server id (localStorage-backed)", () => {
  let store: Record<string, string> = {};
  const mockStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
    key: () => null,
    length: 0,
  };

  beforeEach(() => {
    store = {};
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    // leave jsdom's localStorage in place for other tests
  });

  it("defaults to LOCAL_SERVER_ID when nothing is stored", () => {
    expect(getActiveServerId()).toBe(LOCAL_SERVER_ID);
  });

  it("persists and retrieves an id via localStorage", () => {
    setActiveServerId("remote-1");
    expect(getActiveServerId()).toBe("remote-1");
  });

  it("returns LOCAL_SERVER_ID if localStorage.getItem throws", () => {
    mockStorage.getItem = () => { throw new Error("storage unavailable"); };
    try {
      expect(getActiveServerId()).toBe(LOCAL_SERVER_ID);
    } finally {
      mockStorage.getItem = (k: string) => (k in store ? store[k] : null);
    }
  });

  it("swallows setItem errors quietly", () => {
    mockStorage.setItem = () => { throw new Error("no room"); };
    try {
      expect(() => setActiveServerId("x")).not.toThrow();
    } finally {
      mockStorage.setItem = (k: string, v: string) => { store[k] = v; };
    }
  });
});

describe("LOCAL_SERVER constant", () => {
  it("exposes expected shape", () => {
    expect(LOCAL_SERVER.id).toBe(LOCAL_SERVER_ID);
    expect(LOCAL_SERVER.is_local).toBe(true);
    expect(LOCAL_SERVER.has_token).toBe(false);
  });
});
