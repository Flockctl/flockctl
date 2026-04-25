import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  LOCAL_SERVER,
  LOCAL_SERVER_ID,
  setServerMap,
  getServerTunnelPort,
  getActiveServerId,
  setActiveServerId,
} from "@/lib/server-store";

describe("server tunnel-port map", () => {
  it("sets then retrieves a tunnel port", () => {
    setServerMap([{ id: "a", tunnelPort: 48123 }]);
    expect(getServerTunnelPort("a")).toBe(48123);
  });

  it("replaces the prior map on each set", () => {
    setServerMap([{ id: "a", tunnelPort: 48123 }]);
    setServerMap([{ id: "b", tunnelPort: 48200 }]);
    expect(getServerTunnelPort("a")).toBeUndefined();
    expect(getServerTunnelPort("b")).toBe(48200);
  });

  it("skips entries whose tunnelPort is null or undefined", () => {
    setServerMap([
      { id: "a", tunnelPort: null },
      { id: "b", tunnelPort: undefined },
      { id: "c", tunnelPort: 48300 },
    ]);
    expect(getServerTunnelPort("a")).toBeUndefined();
    expect(getServerTunnelPort("b")).toBeUndefined();
    expect(getServerTunnelPort("c")).toBe(48300);
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
    expect(LOCAL_SERVER.name).toBe("Local");
  });
});
