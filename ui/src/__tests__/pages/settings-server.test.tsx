import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerProvider } from "@/contexts/server-context";

/**
 * Unit tests for the restyled `ServerSection` (the "Server" tab body of the
 * redesigned settings page).
 *
 * Coverage:
 *   - the three required UI elements render: a Daemon URL field, a version
 *     string, and a "Restart daemon" button;
 *   - the URL field is read-only and reflects `getApiBaseUrl()`;
 *   - the version string updates from `fetchVersion()` on mount and on the
 *     refresh button click;
 *   - the restart button preserves the existing update→restart flow:
 *     calling `triggerUpdate()` then polling `fetchUpdateState()` until the
 *     install leaves `running`, surfacing the success copy from the sidebar
 *     footer ("Update installed — restart the daemon.").
 *
 * `@/lib/api` is mocked at module scope so the component drives off the
 * mock fns without any real network IO.
 */

// Mock the api barrel BEFORE importing the component under test. Vitest
// hoists `vi.mock` calls so the import order at the top of the file is fine.
vi.mock("@/lib/api", () => {
  return {
    getApiBaseUrl: vi.fn(() => "http://127.0.0.1:52077"),
    fetchVersion: vi.fn(),
    fetchUpdateState: vi.fn(),
    triggerUpdate: vi.fn(),
  };
});

import {
  fetchUpdateState,
  fetchVersion,
  getApiBaseUrl,
  triggerUpdate,
} from "@/lib/api";

import { ServerSection } from "@/pages/settings-components/ServerSection";

const fetchVersionMock = vi.mocked(fetchVersion);
const fetchUpdateStateMock = vi.mocked(fetchUpdateState);
const triggerUpdateMock = vi.mocked(triggerUpdate);
const getApiBaseUrlMock = vi.mocked(getApiBaseUrl);

function setIdleResponses() {
  fetchVersionMock.mockResolvedValue({
    current: "0.42.0",
    latest: "0.42.0",
    update_available: false,
    error: null,
    install_mode: "global",
  });
  fetchUpdateStateMock.mockResolvedValue({ status: "idle" });
  triggerUpdateMock.mockResolvedValue({
    triggered: true,
    target_version: "0.42.0",
    install_mode: "global",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getApiBaseUrlMock.mockReturnValue("http://127.0.0.1:52077");
  setIdleResponses();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * `ServerSection` mounts `<ServerConnectionsList>`, which calls
 * `useServerContext()`. Wrap every render in a `ServerProvider` (which itself
 * calls `useQueryClient`) so the component tree boots cleanly.
 */
function renderSection(ui: ReactElement = <ServerSection />) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ServerProvider>{ui}</ServerProvider>
    </QueryClientProvider>,
  );
}

describe("ServerSection — required surface area", () => {
  it("renders the Daemon URL field, version display, and restart button", async () => {
    renderSection();

    // Daemon URL input — read-only, populated from getApiBaseUrl().
    const urlInput = screen.getByTestId(
      "server-section-url",
    ) as HTMLInputElement;
    expect(urlInput.value).toBe("http://127.0.0.1:52077");
    expect(urlInput.readOnly).toBe(true);
    expect(urlInput.getAttribute("aria-readonly")).toBe("true");

    // Version display lands after fetchVersion() resolves.
    await waitFor(() => {
      expect(screen.getByTestId("server-section-version").textContent).toBe(
        "v0.42.0",
      );
    });

    // Restart button is present and idle.
    const restart = screen.getByTestId("server-section-restart");
    expect(restart.textContent).toContain("Restart daemon");
    expect((restart as HTMLButtonElement).disabled).toBe(false);
  });

  it("falls back to a placeholder URL when getApiBaseUrl throws (tunnel still coming up)", () => {
    getApiBaseUrlMock.mockImplementation(() => {
      throw new Error("no tunnel port");
    });
    renderSection();
    const urlInput = screen.getByTestId(
      "server-section-url",
    ) as HTMLInputElement;
    expect(urlInput.value).toBe("—");
    expect(urlInput.readOnly).toBe(true);
  });
});

describe("ServerSection — version refresh", () => {
  it("re-fetches version when the refresh button is clicked", async () => {
    const user = userEvent.setup();
    renderSection();
    await waitFor(() =>
      expect(fetchVersionMock).toHaveBeenCalledTimes(1),
    );

    fetchVersionMock.mockResolvedValueOnce({
      current: "0.43.0",
      latest: "0.43.0",
      update_available: false,
      error: null,
      install_mode: "global",
    });

    await user.click(screen.getByTestId("server-section-version-refresh"));

    await waitFor(() => {
      expect(screen.getByTestId("server-section-version").textContent).toBe(
        "v0.43.0",
      );
    });
    expect(fetchVersionMock).toHaveBeenCalledTimes(2);
  });

  it("renders an em-dash when the version request fails", async () => {
    fetchVersionMock.mockRejectedValueOnce(new Error("boom"));
    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId("server-section-version").textContent).toBe(
        "—",
      );
    });
  });
});

describe("ServerSection — restart flow (preserved)", () => {
  it("triggerUpdate is invoked, then state polls until !running, surfacing success copy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSection();
    await waitFor(() =>
      expect(fetchVersionMock).toHaveBeenCalledTimes(1),
    );

    // Sequence the update-state poller: first poll = still running, second
    // poll = success. The component should stop polling after the second.
    fetchUpdateStateMock.mockReset();
    fetchUpdateStateMock
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({
        status: "success",
        target_version: "0.43.0",
      });

    await user.click(screen.getByTestId("server-section-restart"));

    // triggerUpdate fires immediately on click.
    expect(triggerUpdateMock).toHaveBeenCalledTimes(1);

    // While running, the inline "Restarting daemon…" status renders and
    // the button is disabled.
    expect(
      screen.getByTestId("server-section-status-running"),
    ).toBeTruthy();
    expect(
      (screen.getByTestId("server-section-restart") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // First post-trigger poll: pollOnce() runs on the same tick.
    await waitFor(() => {
      expect(fetchUpdateStateMock).toHaveBeenCalled();
    });

    // Advance through the 3s polling interval so the second poll fires and
    // resolves to `success`.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("server-section-status-success").textContent,
      ).toBe("Update installed — restart the daemon.");
    });

    // The button is re-enabled once we leave the running state.
    expect(
      (screen.getByTestId("server-section-restart") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("surfaces an error message when triggerUpdate rejects", async () => {
    const user = userEvent.setup();
    triggerUpdateMock.mockRejectedValueOnce(new Error("network down"));
    renderSection();
    await waitFor(() =>
      expect(fetchVersionMock).toHaveBeenCalledTimes(1),
    );

    await user.click(screen.getByTestId("server-section-restart"));

    await waitFor(() => {
      expect(
        screen.getByTestId("server-section-status-error").textContent,
      ).toBe("network down");
    });
  });
});
