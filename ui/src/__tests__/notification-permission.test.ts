import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getStatus,
  requestPermission,
  subscribePermissionChange,
} from "@/lib/notification-permission";

type NotificationPermission = "granted" | "denied" | "default";

interface MutablePermissionStatus {
  onchange: ((this: unknown, ev: Event) => unknown) | null;
}

/**
 * Install a fake `Notification` constructor on `window`. JSDOM doesn't
 * ship one, so each test that needs it installs its own.
 */
function installNotification(opts: {
  permission: NotificationPermission;
  requestPermission?: () => Promise<NotificationPermission>;
}): void {
  const fake = function NotificationCtor() {} as unknown as {
    permission: NotificationPermission;
    requestPermission: () => Promise<NotificationPermission>;
  };
  fake.permission = opts.permission;
  fake.requestPermission =
    opts.requestPermission ?? (async () => opts.permission);
  Object.defineProperty(window, "Notification", {
    configurable: true,
    writable: true,
    value: fake,
  });
}

function uninstallNotification(): void {
  // `delete` works even if the prop was defined non-enumerable above.
  // `Reflect.deleteProperty` is safer across jsdom quirks.
  Reflect.deleteProperty(window, "Notification");
}

function setSecureContext(secure: boolean): void {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    writable: true,
    value: secure,
  });
}

function installPermissionsApi(
  query: (descriptor: { name: string }) => Promise<MutablePermissionStatus>,
): void {
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    writable: true,
    value: { query },
  });
}

function uninstallPermissionsApi(): void {
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "permissions");
}

beforeEach(() => {
  setSecureContext(true);
  // Pretend the user just clicked, so requestPermission doesn't warn.
  globalThis.__lastUserGestureAt = Date.now();
});

afterEach(() => {
  uninstallNotification();
  uninstallPermissionsApi();
  globalThis.__lastUserGestureAt = undefined;
});

describe("getStatus", () => {
  it("returns 'unsupported' when Notification is missing", () => {
    uninstallNotification();
    expect(getStatus()).toBe("unsupported");
  });

  it("returns 'insecure-context' when isSecureContext is false", () => {
    installNotification({ permission: "default" });
    setSecureContext(false);
    expect(getStatus()).toBe("insecure-context");
  });

  it("returns the live Notification.permission value", () => {
    installNotification({ permission: "granted" });
    expect(getStatus()).toBe("granted");
    installNotification({ permission: "denied" });
    expect(getStatus()).toBe("denied");
    installNotification({ permission: "default" });
    expect(getStatus()).toBe("default");
  });

  it("reads fresh on every call (no caching)", () => {
    installNotification({ permission: "default" });
    expect(getStatus()).toBe("default");
    // Mutate the underlying permission — getStatus must reflect the change.
    (window.Notification as unknown as { permission: NotificationPermission }).permission =
      "granted";
    expect(getStatus()).toBe("granted");
  });
});

describe("requestPermission", () => {
  it("returns current status without prompting when granted", async () => {
    const requestSpy = vi.fn(async () => "default" as const);
    installNotification({ permission: "granted", requestPermission: requestSpy });
    await expect(requestPermission()).resolves.toBe("granted");
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("returns current status without prompting when denied", async () => {
    const requestSpy = vi.fn(async () => "default" as const);
    installNotification({ permission: "denied", requestPermission: requestSpy });
    await expect(requestPermission()).resolves.toBe("denied");
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("returns 'unsupported' without prompting when Notification is missing", async () => {
    uninstallNotification();
    await expect(requestPermission()).resolves.toBe("unsupported");
  });

  it("returns 'insecure-context' without prompting when context is insecure", async () => {
    installNotification({ permission: "default" });
    setSecureContext(false);
    await expect(requestPermission()).resolves.toBe("insecure-context");
  });

  it("prompts when status is 'default' and returns the result", async () => {
    const requestSpy = vi.fn(async () => "granted" as const);
    installNotification({ permission: "default", requestPermission: requestSpy });
    await expect(requestPermission()).resolves.toBe("granted");
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("propagates a 'denied' result from the prompt", async () => {
    const requestSpy = vi.fn(async () => "denied" as const);
    installNotification({ permission: "default", requestPermission: requestSpy });
    await expect(requestPermission()).resolves.toBe("denied");
  });
});

describe("subscribePermissionChange", () => {
  it("returns a no-op when the Permissions API is missing", () => {
    uninstallPermissionsApi();
    const cb = vi.fn();
    const unsub = subscribePermissionChange(cb);
    expect(typeof unsub).toBe("function");
    expect(() => unsub()).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });

  it("returns a no-op when query rejects (older Firefox)", async () => {
    installPermissionsApi(() => Promise.reject(new Error("not supported")));
    const cb = vi.fn();
    const unsub = subscribePermissionChange(cb);
    // Let the rejected promise settle before asserting.
    await new Promise((r) => setTimeout(r, 0));
    expect(() => unsub()).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });

  it("invokes the callback with the fresh status on permission change", async () => {
    installNotification({ permission: "default" });
    const status: MutablePermissionStatus = { onchange: null };
    installPermissionsApi(() => Promise.resolve(status));

    const cb = vi.fn();
    subscribePermissionChange(cb);
    // Wait for the query promise to resolve and onchange to wire up.
    await new Promise((r) => setTimeout(r, 0));
    expect(status.onchange).toBeTypeOf("function");

    // Simulate the user revoking permission via site settings.
    (window.Notification as unknown as { permission: NotificationPermission }).permission =
      "denied";
    status.onchange?.call(status, new Event("change"));

    expect(cb).toHaveBeenCalledWith("denied");
  });

  it("clears onchange on unsubscribe", async () => {
    const status: MutablePermissionStatus = { onchange: null };
    installNotification({ permission: "default" });
    installPermissionsApi(() => Promise.resolve(status));

    const cb = vi.fn();
    const unsub = subscribePermissionChange(cb);
    await new Promise((r) => setTimeout(r, 0));
    expect(status.onchange).not.toBeNull();
    unsub();
    expect(status.onchange).toBeNull();
  });

  it("never invokes the callback if unsubscribed before query resolves", async () => {
    let resolveQuery: (s: MutablePermissionStatus) => void = () => {};
    const status: MutablePermissionStatus = { onchange: null };
    installPermissionsApi(
      () =>
        new Promise<MutablePermissionStatus>((res) => {
          resolveQuery = res;
        }),
    );

    const cb = vi.fn();
    const unsub = subscribePermissionChange(cb);
    unsub();
    resolveQuery(status);
    await new Promise((r) => setTimeout(r, 0));
    expect(status.onchange).toBeNull();
    expect(cb).not.toHaveBeenCalled();
  });
});
