import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerConnection } from "@/lib/types";

const ctx: {
  connectionStatus: "connected" | "checking" | "error";
  activeServer: ServerConnection;
  testConnection: ReturnType<typeof vi.fn>;
} = {
  connectionStatus: "connected",
  activeServer: { id: "local", name: "Local", is_local: true },
  testConnection: vi.fn(),
};

vi.mock("@/contexts/server-context", () => ({
  useServerContext: () => ctx,
}));

import { ConnectionBanner } from "@/components/connection-banner";

beforeEach(() => {
  ctx.connectionStatus = "connected";
  ctx.activeServer = { id: "local", name: "Local", is_local: true };
  ctx.testConnection.mockReset();
});

describe("ConnectionBanner", () => {
  it("renders nothing when connected", () => {
    const { container } = render(<ConnectionBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a spinner + server name while checking", () => {
    ctx.connectionStatus = "checking";
    ctx.activeServer = { id: "local", name: "my-server", is_local: true };
    render(<ConnectionBanner />);
    expect(screen.getByText(/Connecting to my-server/)).toBeTruthy();
  });

  it("renders an error banner with retry when disconnected", async () => {
    const user = userEvent.setup();
    ctx.connectionStatus = "error";
    ctx.activeServer = {
      id: "r",
      name: "remote-1",
      is_local: false,
      ssh: { host: "alice@prod.example" },
    };
    render(<ConnectionBanner />);
    expect(screen.getByText(/Cannot reach/)).toBeTruthy();
    expect(screen.getByText("remote-1")).toBeTruthy();
    expect(screen.getByText("(alice@prod.example)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(ctx.testConnection).toHaveBeenCalled();
  });
});
