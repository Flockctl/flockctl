import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NotificationsTab } from "@/components/settings/notifications-tab";
import enLocale from "@/locales/en.json";
import ruLocale from "@/locales/ru.json";

const t = enLocale.notifications;

const STORAGE_KEY = "flockctl.notifications.v1";

// --- localStorage harness ----------------------------------------------------
//
// Mirrors the per-test stub used by `notification-prefs.test.ts` so test order
// can't poison this suite via a shared mutable storage object.

let store: Record<string, string>;
const mockStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
  clear: () => {
    store = {};
  },
  key: () => null,
  length: 0,
};

// --- window.Notification harness --------------------------------------------
//
// JSDOM ships no Notification API. Each test installs the constructor it
// needs, plus toggles `isSecureContext`. The same shape lives in
// `notification-permission.test.ts` — kept in sync intentionally.

type BrowserPerm = "granted" | "denied" | "default";

function installNotification(opts: {
  permission: BrowserPerm;
  requestPermission?: () => Promise<BrowserPerm>;
}): void {
  const fake = function NotificationCtor() {} as unknown as {
    permission: BrowserPerm;
    requestPermission: () => Promise<BrowserPerm>;
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
  Reflect.deleteProperty(window, "Notification");
}

function setSecureContext(secure: boolean): void {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    writable: true,
    value: secure,
  });
}

beforeEach(() => {
  store = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
  setSecureContext(true);
  // Pretend the user just clicked, so requestPermission doesn't dev-warn.
  globalThis.__lastUserGestureAt = Date.now();
});

afterEach(() => {
  uninstallNotification();
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "permissions");
  globalThis.__lastUserGestureAt = undefined;
});

// ----------------------------------------------------------------------------

describe("NotificationsTab — banners", () => {
  it("renders the insecure-context banner when window.isSecureContext is false", () => {
    installNotification({ permission: "default" });
    setSecureContext(false);
    render(<NotificationsTab />);
    const banner = screen.getByTestId("notifications-banner-insecure-context");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent(t.banner.insecure_context);
    // Toggle and category fieldset must NOT be in the tree.
    expect(screen.queryByTestId("notifications-master-toggle")).toBeNull();
    expect(screen.queryByTestId("notifications-cat-approval")).toBeNull();
  });

  it("renders the unsupported banner when Notification is missing from window", () => {
    uninstallNotification();
    render(<NotificationsTab />);
    const banner = screen.getByTestId("notifications-banner-unsupported");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent(t.banner.unsupported);
    expect(screen.queryByTestId("notifications-master-toggle")).toBeNull();
  });

  it("renders the denied recovery banner when permission is 'denied'", () => {
    installNotification({ permission: "denied" });
    render(<NotificationsTab />);
    const banner = screen.getByTestId("notifications-banner-denied");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent(t.banner.denied_recovery);
    // The master toggle is still visible — but flipping it on with permission
    // already denied is a no-op (covered by a separate test below).
    expect(screen.getByTestId("notifications-master-toggle")).toBeInTheDocument();
  });
});

describe("NotificationsTab — permission status row", () => {
  it("shows the granted label and aria-live=polite when permission is granted", () => {
    installNotification({ permission: "granted" });
    render(<NotificationsTab />);
    const row = screen.getByTestId("notifications-permission-status");
    expect(row).toHaveAttribute("aria-live", "polite");
    expect(row).toHaveAttribute("data-permission", "granted");
    expect(row).toHaveTextContent(t.permission.granted);
  });

  it("shows the denied label when permission is denied", () => {
    installNotification({ permission: "denied" });
    render(<NotificationsTab />);
    const row = screen.getByTestId("notifications-permission-status");
    expect(row).toHaveAttribute("data-permission", "denied");
    expect(row).toHaveTextContent(t.permission.denied);
  });

  it("shows the default label when permission has not been requested yet", () => {
    installNotification({ permission: "default" });
    render(<NotificationsTab />);
    const row = screen.getByTestId("notifications-permission-status");
    expect(row).toHaveAttribute("data-permission", "default");
    expect(row).toHaveTextContent(t.permission.default);
  });
});

describe("NotificationsTab — master toggle and category fieldset", () => {
  it("hides the category fieldset while master is OFF", () => {
    installNotification({ permission: "granted" });
    render(<NotificationsTab />);
    expect(screen.queryByTestId("notifications-cat-approval")).toBeNull();
    expect(screen.queryByTestId("notifications-cat-question")).toBeNull();
  });

  it("hides the category fieldset when master is ON but permission is not granted", () => {
    // Manually pre-flip prefs so the fieldset would be unhidden if permission
    // were the only gate. With "default" permission it must stay hidden.
    store[STORAGE_KEY] = JSON.stringify({ enabled: true });
    installNotification({ permission: "default" });
    render(<NotificationsTab />);
    expect(screen.getByTestId("notifications-master-toggle")).toBeInTheDocument();
    expect(screen.queryByTestId("notifications-cat-approval")).toBeNull();
  });

  it("renders all five category checkboxes when master is ON and permission is granted", () => {
    store[STORAGE_KEY] = JSON.stringify({ enabled: true });
    installNotification({ permission: "granted" });
    render(<NotificationsTab />);
    for (const id of [
      "notifications-cat-approval",
      "notifications-cat-question",
      "notifications-cat-done",
      "notifications-cat-failed",
      "notifications-cat-blocked",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it("calls Notification.requestPermission when master is flipped from default → on", async () => {
    const requestSpy = vi.fn(async () => "granted" as const);
    installNotification({ permission: "default", requestPermission: requestSpy });
    const user = userEvent.setup();
    render(<NotificationsTab />);

    await user.click(screen.getByTestId("notifications-master-toggle"));

    expect(requestSpy).toHaveBeenCalledTimes(1);
    // After grant, master is ON in storage AND fieldset is visible.
    await waitFor(() => {
      expect(screen.getByTestId("notifications-cat-approval")).toBeInTheDocument();
    });
    expect(JSON.parse(store[STORAGE_KEY]!)).toMatchObject({ enabled: true });
  });

  it("does NOT flip prefs.enabled if the permission prompt resolves with 'denied'", async () => {
    const requestSpy = vi.fn(async () => "denied" as const);
    installNotification({ permission: "default", requestPermission: requestSpy });
    const user = userEvent.setup();
    render(<NotificationsTab />);

    await user.click(screen.getByTestId("notifications-master-toggle"));

    expect(requestSpy).toHaveBeenCalledTimes(1);
    // Storage stays empty (or `enabled: false`); category fieldset never opens;
    // and the row flips to "denied" + the recovery banner appears.
    await waitFor(() => {
      expect(screen.getByTestId("notifications-banner-denied")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("notifications-cat-approval")).toBeNull();
    const raw = store[STORAGE_KEY];
    if (raw) {
      expect(JSON.parse(raw).enabled).toBe(false);
    }
  });

  it("does NOT re-prompt when permission is already granted", async () => {
    const requestSpy = vi.fn(async () => "granted" as const);
    installNotification({ permission: "granted", requestPermission: requestSpy });
    const user = userEvent.setup();
    render(<NotificationsTab />);

    await user.click(screen.getByTestId("notifications-master-toggle"));

    // Already granted means the click handler short-circuits the prompt path
    // entirely and just persists `enabled: true`.
    expect(requestSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId("notifications-cat-approval")).toBeInTheDocument();
    });
  });

  it("persists category toggles to storage and round-trips through the hook", async () => {
    store[STORAGE_KEY] = JSON.stringify({ enabled: true });
    installNotification({ permission: "granted" });
    const user = userEvent.setup();
    render(<NotificationsTab />);

    // onTaskDone defaults to false; toggling it ON should write through.
    await user.click(screen.getByTestId("notifications-cat-done"));

    await waitFor(() => {
      expect(JSON.parse(store[STORAGE_KEY]!)).toMatchObject({
        enabled: true,
        onTaskDone: true,
      });
    });
  });
});

describe("NotificationsTab — accessibility", () => {
  it("associates the master checkbox with its <label> via htmlFor", () => {
    installNotification({ permission: "granted" });
    render(<NotificationsTab />);
    const labelText = screen.getByText(t.master, { selector: "label" });
    expect(labelText).toHaveAttribute("for", "notifications-master");
    expect(screen.getByTestId("notifications-master-toggle")).toHaveAttribute(
      "id",
      "notifications-master",
    );
  });

});

describe("locale parity", () => {
  it("ru.json exposes the same notification keys as en.json", () => {
    const ru = ruLocale as { notifications: typeof enLocale.notifications };
    expect(Object.keys(ru.notifications).sort()).toEqual(
      Object.keys(enLocale.notifications).sort(),
    );
    expect(Object.keys(ru.notifications.cat).sort()).toEqual(
      Object.keys(enLocale.notifications.cat).sort(),
    );
    expect(Object.keys(ru.notifications.permission).sort()).toEqual(
      Object.keys(enLocale.notifications.permission).sort(),
    );
    expect(Object.keys(ru.notifications.banner).sort()).toEqual(
      Object.keys(enLocale.notifications.banner).sort(),
    );
  });
});
