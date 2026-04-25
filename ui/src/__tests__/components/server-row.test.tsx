import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerRow, type ServerRowStatus } from "@/components/server-connections";
import type { ServerConnection } from "@/lib/types";
import { errorCodeMessage } from "@/lib/types/common";

// --- helpers ---------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body ?? {}), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A controllable fetch mock: the returned promise doesn't settle until the
 * caller invokes `resolve()` or `reject()`. This lets a test observe the
 * optimistic state while the request is in-flight, then drive it to success
 * or failure on its own schedule.
 */
function makeDeferredFetch() {
  let resolve!: (r: Response) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const mock = vi.fn(() => promise);
  return { mock, resolve, reject };
}

function makeServer(overrides: Partial<ServerConnection> = {}): ServerConnection {
  return {
    id: "srv-1",
    name: "prod",
    is_local: false,
    ssh: { host: "alice@prod.example", port: 22 },
    tunnelStatus: "ready",
    ...overrides,
  };
}

function renderRow(server: ServerConnection, onChanged?: () => void) {
  return render(
    <table>
      <tbody>
        <ServerRow server={server} onChanged={onChanged} />
      </tbody>
    </table>,
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole("button", { name: "Row actions" });
  await user.click(trigger);
  return screen.getByRole("menu", { name: "Server actions" });
}

beforeEach(() => {
  (globalThis as any).fetch = vi.fn();
});

// --- rendering --------------------------------------------------------------

describe("<ServerRow> — rendering", () => {
  it("renders status dot, name, ssh.host summary, and kebab trigger", () => {
    renderRow(makeServer());
    expect(screen.getByText("prod")).toBeInTheDocument();
    expect(screen.getByText("alice@prod.example")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Row actions" })).toBeInTheDocument();
    expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "ready");
  });

  it("colours the dot by tunnelStatus", () => {
    const cases: Array<ServerConnection["tunnelStatus"]> = [
      "ready",
      "starting",
      "error",
      "stopped",
    ];
    for (const status of cases) {
      const { unmount } = renderRow(makeServer({ tunnelStatus: status }));
      expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", status!);
      unmount();
    }
  });

  it("falls back to stopped when tunnelStatus is undefined", () => {
    renderRow(makeServer({ tunnelStatus: undefined }));
    expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "stopped");
  });

  it("renders '—' when ssh is missing (synthetic local-like entry)", () => {
    renderRow(makeServer({ ssh: undefined }));
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("appends non-default SSH port to the host summary", () => {
    renderRow(makeServer({ ssh: { host: "bob@prod.example", port: 2200 } }));
    expect(screen.getByText("bob@prod.example:2200")).toBeInTheDocument();
  });
});

// --- tooltip on status icon -------------------------------------------------

describe("<ServerRow> — error tooltip", () => {
  it("shows errorCodeMessage(errorCode) as the dot's title when status==='error'", () => {
    renderRow(makeServer({ tunnelStatus: "error", errorCode: "auth_failed" }));
    const dot = screen.getByTestId("status-dot");
    expect(dot).toHaveAttribute("title", errorCodeMessage("auth_failed"));
  });

  it("falls back to the 'unknown' message when errorCode is missing but status==='error'", () => {
    renderRow(makeServer({ tunnelStatus: "error", errorCode: undefined }));
    const dot = screen.getByTestId("status-dot");
    expect(dot).toHaveAttribute("title", errorCodeMessage(undefined));
  });

  it("does NOT set a title when status !== 'error'", () => {
    renderRow(makeServer({ tunnelStatus: "ready", errorCode: "auth_failed" }));
    const dot = screen.getByTestId("status-dot");
    expect(dot).not.toHaveAttribute("title");
  });
});

// --- menu item enablement ---------------------------------------------------

describe("<ServerRow> — kebab menu enablement rules", () => {
  async function getItems(status: ServerRowStatus) {
    const user = userEvent.setup();
    renderRow(makeServer({ tunnelStatus: status }));
    const menu = await openMenu(user);
    return {
      reconnect: within(menu).getByRole("menuitem", { name: "Reconnect" }),
      stop: within(menu).getByRole("menuitem", { name: "Stop" }),
      start: within(menu).getByRole("menuitem", { name: "Start" }),
      remove: within(menu).getByRole("menuitem", { name: "Remove" }),
    };
  }

  it("status=ready → Reconnect+Stop enabled; Start disabled; Remove enabled", async () => {
    const { reconnect, stop, start, remove } = await getItems("ready");
    expect(reconnect).not.toBeDisabled();
    expect(stop).not.toBeDisabled();
    expect(start).toBeDisabled();
    expect(remove).not.toBeDisabled();
  });

  it("status=stopped → Reconnect+Start enabled; Stop disabled; Remove enabled", async () => {
    const { reconnect, stop, start, remove } = await getItems("stopped");
    expect(reconnect).not.toBeDisabled();
    expect(stop).toBeDisabled();
    expect(start).not.toBeDisabled();
    expect(remove).not.toBeDisabled();
  });

  it("status=error → Reconnect enabled; Stop+Start disabled; Remove enabled", async () => {
    const { reconnect, stop, start, remove } = await getItems("error");
    expect(reconnect).not.toBeDisabled();
    expect(stop).toBeDisabled();
    expect(start).toBeDisabled();
    expect(remove).not.toBeDisabled();
  });

  it("status=starting → Reconnect+Stop+Start disabled; Remove always enabled", async () => {
    const { reconnect, stop, start, remove } = await getItems("starting");
    expect(reconnect).toBeDisabled();
    expect(stop).toBeDisabled();
    expect(start).toBeDisabled();
    expect(remove).not.toBeDisabled();
  });
});

// --- reconnect action -------------------------------------------------------

describe("<ServerRow> — Reconnect", () => {
  it("POSTs /tunnel/restart, flips status to 'starting' optimistically, and calls onChanged on success", async () => {
    const deferred = makeDeferredFetch();
    (globalThis as any).fetch = deferred.mock;
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderRow(makeServer({ tunnelStatus: "ready" }), onChanged);

    const menu = await openMenu(user);
    const reconnect = within(menu).getByRole("menuitem", { name: "Reconnect" });
    await user.click(reconnect);

    // Optimistic flip is visible while the fetch is in-flight.
    expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "starting");

    // Resolve the fetch — onChanged fires and the override clears.
    deferred.resolve(jsonResponse({ status: "starting" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    expect(deferred.mock).toHaveBeenCalledTimes(1);
    const [url, init] = deferred.mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/meta/remote-servers/srv-1/tunnel/restart");
    expect(init.method).toBe("POST");
  });

  it("rolls back the optimistic 'starting' status when the restart fetch fails", async () => {
    const deferred = makeDeferredFetch();
    (globalThis as any).fetch = deferred.mock;
    const user = userEvent.setup();
    renderRow(makeServer({ tunnelStatus: "ready" }));

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Reconnect" }));

    // Optimistic flip while in-flight…
    expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "starting");

    // Reject the fetch — the catch handler rolls back to the prop's value.
    deferred.resolve(jsonResponse({ detail: "boom" }, 500));
    await waitFor(() =>
      expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "ready"),
    );
  });
});

// --- remove action ----------------------------------------------------------

describe("<ServerRow> — Remove", () => {
  it("DELETE /meta/remote-servers/:id, optimistically hides the row, calls onChanged on success", async () => {
    const deferred = makeDeferredFetch();
    (globalThis as any).fetch = deferred.mock;
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderRow(makeServer(), onChanged);

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Remove" }));

    // The row disappears immediately — before the DELETE resolves.
    expect(screen.queryByTestId("server-row-srv-1")).not.toBeInTheDocument();

    deferred.resolve(jsonResponse(null));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    const [url, init] = deferred.mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/meta/remote-servers/srv-1");
    expect(url).not.toContain("/tunnel/");
    expect(init.method).toBe("DELETE");
  });

  it("rolls back (re-renders the row) when DELETE rejects", async () => {
    const deferred = makeDeferredFetch();
    (globalThis as any).fetch = deferred.mock;
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderRow(makeServer(), onChanged);

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Remove" }));

    // Hidden first…
    expect(screen.queryByTestId("server-row-srv-1")).not.toBeInTheDocument();

    // Drive the DELETE to failure.
    deferred.resolve(jsonResponse({ detail: "nope" }, 500));

    // …then the row is restored once the error is observed.
    await waitFor(() =>
      expect(screen.getByTestId("server-row-srv-1")).toBeInTheDocument(),
    );
    expect(onChanged).not.toHaveBeenCalled();
  });
});

// --- Start / Stop wiring ----------------------------------------------------

describe("<ServerRow> — Start/Stop", () => {
  it("Start posts to /tunnel/start and flips status optimistically to 'starting'", async () => {
    const deferred = makeDeferredFetch();
    (globalThis as any).fetch = deferred.mock;
    const user = userEvent.setup();
    renderRow(makeServer({ tunnelStatus: "stopped" }));

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Start" }));

    expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "starting");

    deferred.resolve(jsonResponse({ status: "starting" }));
    await waitFor(() => expect(deferred.mock).toHaveBeenCalledTimes(1));
    const [url, init] = deferred.mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/meta/remote-servers/srv-1/tunnel/start");
    expect(init.method).toBe("POST");
  });

  it("Stop posts to /tunnel/stop", async () => {
    const deferred = makeDeferredFetch();
    (globalThis as any).fetch = deferred.mock;
    const user = userEvent.setup();
    renderRow(makeServer({ tunnelStatus: "ready" }));

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Stop" }));

    deferred.resolve(jsonResponse({ status: "stopped" }));
    await waitFor(() => expect(deferred.mock).toHaveBeenCalledTimes(1));
    const [url, init] = deferred.mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/meta/remote-servers/srv-1/tunnel/stop");
    expect(init.method).toBe("POST");
  });
});

// --- perf guard -------------------------------------------------------------

describe("<ServerRow> — perf", () => {
  it("list_of_20_servers_all_ready_renders_under_100ms", () => {
    const servers: ServerConnection[] = Array.from({ length: 20 }, (_, i) =>
      makeServer({
        id: `srv-${i}`,
        name: `server-${i}`,
        ssh: { host: `host-${i}.example`, port: 22 },
        tunnelStatus: "ready",
      }),
    );

    const start = performance.now();
    const { container } = render(
      <table>
        <tbody>
          {servers.map((s) => (
            <ServerRow key={s.id} server={s} />
          ))}
        </tbody>
      </table>,
    );
    const elapsed = performance.now() - start;

    // Soft guard against accidental N² work. CI is noisier than local so the
    // budget is generous; the point is to catch the pathological case where
    // a shared state update makes every row re-render every other row.
    expect(elapsed).toBeLessThan(100);
    // And sanity-check that all 20 rows actually rendered.
    expect(container.querySelectorAll("[data-testid^='server-row-']").length).toBe(20);
  });
});

// --- prop sync --------------------------------------------------------------

describe("<ServerRow> — prop reconciliation", () => {
  it("drops the optimistic override when the parent delivers a new tunnelStatus", async () => {
    const deferred = makeDeferredFetch();
    (globalThis as any).fetch = deferred.mock;
    const user = userEvent.setup();

    const server = makeServer({ tunnelStatus: "ready" });
    const { rerender } = render(
      <table>
        <tbody>
          <ServerRow server={server} />
        </tbody>
      </table>,
    );

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Reconnect" }));
    expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "starting");

    // Simulate the next poll returning a different authoritative status —
    // the override should yield to it.
    await act(async () => {
      rerender(
        <table>
          <tbody>
            <ServerRow server={{ ...server, tunnelStatus: "error", errorCode: "auth_failed" }} />
          </tbody>
        </table>,
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "error"),
    );

    // Clean up the still-pending fetch so it doesn't leak into the next test.
    deferred.resolve(jsonResponse({}));
  });

  it("clears the override on successful fetch completion (prop unchanged)", async () => {
    const deferred = makeDeferredFetch();
    (globalThis as any).fetch = deferred.mock;
    const user = userEvent.setup();

    renderRow(makeServer({ tunnelStatus: "ready" }));

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Reconnect" }));
    expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "starting");

    deferred.resolve(jsonResponse({ status: "starting" }));
    // After success the override clears and the dot falls back to the prop.
    await waitFor(() =>
      expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "ready"),
    );
  });
});

