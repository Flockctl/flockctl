import { describe, it, expect } from "vitest";
import { evaluateBindSecurity } from "../lib/security-gate.js";

describe("evaluateBindSecurity", () => {
  const port = 52077;

  it("starts silently on loopback without a token", () => {
    const d = evaluateBindSecurity({
      host: "127.0.0.1",
      port,
      hasToken: false,
      allowInsecurePublic: false,
    });
    expect(d.action).toBe("start");
    if (d.action === "start") {
      expect(d.warning).toBeUndefined();
      expect(d.info).toBeUndefined();
    }
  });

  it("starts silently on loopback even with a token", () => {
    const d = evaluateBindSecurity({
      host: "127.0.0.1",
      port,
      hasToken: true,
      allowInsecurePublic: false,
    });
    expect(d.action).toBe("start");
  });

  it("treats ::1 and localhost as loopback", () => {
    for (const host of ["::1", "localhost"]) {
      const d = evaluateBindSecurity({
        host,
        port,
        hasToken: false,
        allowInsecurePublic: false,
      });
      expect(d.action).toBe("start");
    }
  });

  it("refuses non-loopback with no token and no opt-in", () => {
    const d = evaluateBindSecurity({
      host: "0.0.0.0",
      port,
      hasToken: false,
      allowInsecurePublic: false,
    });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") {
      expect(d.error).toMatch(/Refusing to bind/);
      expect(d.error).toMatch(/flockctl token generate/);
      expect(d.error).toMatch(/--allow-insecure-public/);
    }
  });

  it("starts with info log when non-loopback + token configured", () => {
    const d = evaluateBindSecurity({
      host: "0.0.0.0",
      port,
      hasToken: true,
      allowInsecurePublic: false,
    });
    expect(d.action).toBe("start");
    if (d.action === "start") {
      expect(d.info).toMatch(/Remote access enabled/);
      expect(d.info).toMatch(/token auth active/);
      expect(d.warning).toBeUndefined();
    }
  });

  it("starts with warning when --allow-insecure-public is set", () => {
    const d = evaluateBindSecurity({
      host: "0.0.0.0",
      port,
      hasToken: false,
      allowInsecurePublic: true,
    });
    expect(d.action).toBe("start");
    if (d.action === "start") {
      expect(d.warning).toMatch(/SECURITY WARNING/);
      expect(d.warning).toMatch(/WITHOUT authentication/);
    }
  });

  it("prefers token-auth path when both token and insecure flag are set", () => {
    const d = evaluateBindSecurity({
      host: "0.0.0.0",
      port,
      hasToken: true,
      allowInsecurePublic: true,
    });
    expect(d.action).toBe("start");
    if (d.action === "start") {
      expect(d.info).toBeDefined();
      expect(d.warning).toBeUndefined();
    }
  });

  it("treats an explicit public IP as non-loopback", () => {
    const d = evaluateBindSecurity({
      host: "192.168.1.10",
      port,
      hasToken: false,
      allowInsecurePublic: false,
    });
    expect(d.action).toBe("refuse");
  });
});
