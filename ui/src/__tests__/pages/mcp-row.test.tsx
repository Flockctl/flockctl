import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { McpRow } from "@/pages/skills-mcp-components/McpRow";
import type { McpServer } from "@/lib/types";

/**
 * Contract tests for {@link McpRow} (slice 25-01 T02).
 *
 * The row is purely presentational, so the tests drive the prop
 * surface directly:
 *   - happy path: name + level pill + transport pill + URL mono
 *   - status pill: connected → success
 *   - status pill: connecting → warning + LiveDot pulse halo
 *   - status pill: failed → danger
 *   - status omitted → no status pill, no live dot
 *   - selected row paints the selected background + sets aria-current
 *   - click → onSelect(server) (real <button> + keyboard activation)
 *   - edge cases: missing args, transport override, level → tone map
 */

function makeServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    name: "github",
    level: "project",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    },
    ...overrides,
  };
}

describe("McpRow / happy path", () => {
  it("renders name, level pill, transport pill, and url mono", () => {
    render(<McpRow server={makeServer()} />);

    expect(screen.getByTestId("mcp-row-name")).toHaveTextContent("github");
    expect(screen.getByTestId("mcp-row-level-pill")).toHaveTextContent(
      "project",
    );
    // Transport defaults to "stdio".
    expect(screen.getByTestId("mcp-row-transport-pill")).toHaveTextContent(
      "stdio",
    );
    // URL is command + space-joined args, mono-spaced.
    const url = screen.getByTestId("mcp-row-url");
    expect(url).toHaveTextContent(
      "npx -y @modelcontextprotocol/server-github",
    );
    expect(url.className).toContain("font-mono");
    expect(url.tagName).toBe("CODE");
  });

  it("uses the prototype root classes (px-3 py-2, hover, divider)", () => {
    render(<McpRow server={makeServer()} />);
    const row = screen.getByTestId("mcp-row");
    for (const cls of [
      "px-3",
      "py-2",
      "flex",
      "items-center",
      "gap-3",
      "cursor-pointer",
      "hover:bg-zinc-50",
      "dark:hover:bg-zinc-800/40",
      "border-b",
    ]) {
      expect(row.className).toContain(cls);
    }
  });
});

describe("McpRow / connection status", () => {
  it("connected → emerald success StatusPill, no live dot", () => {
    render(<McpRow server={makeServer()} status="connected" />);
    const pill = screen.getByTestId("mcp-row-status-pill");
    expect(pill).toHaveTextContent(/connected/i);
    expect(pill.getAttribute("data-tone")).toBe("success");
    expect(screen.queryByTestId("mcp-row-connecting-dot")).toBeNull();
    expect(screen.getByTestId("mcp-row")).toHaveAttribute(
      "data-status",
      "connected",
    );
  });

  it("connecting → amber warning pill with a pulsing LiveDot", () => {
    render(<McpRow server={makeServer()} status="connecting" />);
    const pill = screen.getByTestId("mcp-row-status-pill");
    expect(pill).toHaveTextContent(/connecting/i);
    expect(pill.getAttribute("data-tone")).toBe("warning");

    const dot = screen.getByTestId("mcp-row-connecting-dot");
    expect(dot).toHaveAttribute("data-state", "live");
    expect(dot).toHaveAttribute("data-pulse", "true");
    // LiveDot renders an animated halo when state=live + pulse=true.
    const halo = dot.querySelector('[data-testid="live-dot-halo"]');
    expect(halo).not.toBeNull();
    expect(halo?.className).toContain("animate-ping");
  });

  it("failed → red danger StatusPill", () => {
    render(<McpRow server={makeServer()} status="failed" />);
    const pill = screen.getByTestId("mcp-row-status-pill");
    expect(pill).toHaveTextContent(/failed/i);
    expect(pill.getAttribute("data-tone")).toBe("danger");
    expect(screen.queryByTestId("mcp-row-connecting-dot")).toBeNull();
  });

  it("status omitted → no status pill or live dot", () => {
    render(<McpRow server={makeServer()} />);
    expect(screen.queryByTestId("mcp-row-status-pill")).toBeNull();
    expect(screen.queryByTestId("mcp-row-connecting-dot")).toBeNull();
    expect(screen.getByTestId("mcp-row")).toHaveAttribute(
      "data-status",
      "unknown",
    );
  });
});

describe("McpRow / selection", () => {
  it("selected=true paints the selected background and sets aria-current", () => {
    render(<McpRow server={makeServer()} selected />);
    const row = screen.getByTestId("mcp-row");
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row).toHaveAttribute("data-selected", "true");
    expect(row.className).toContain("bg-zinc-100");
  });

  it("selected=false omits aria-current", () => {
    render(<McpRow server={makeServer()} />);
    const row = screen.getByTestId("mcp-row");
    expect(row).not.toHaveAttribute("aria-current");
    expect(row).toHaveAttribute("data-selected", "false");
  });
});

describe("McpRow / interaction", () => {
  it("clicking the row fires onSelect with the full server object", async () => {
    const onSelect = vi.fn();
    const server = makeServer({ name: "notion" });
    render(<McpRow server={server} onSelect={onSelect} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("mcp-row"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(server);
  });

  it("renders as a real <button> so keyboard activation works", async () => {
    const onSelect = vi.fn();
    render(<McpRow server={makeServer()} onSelect={onSelect} />);
    const row = screen.getByTestId("mcp-row");
    expect(row.tagName).toBe("BUTTON");
    expect(row).toHaveAttribute("type", "button");
    row.focus();
    const user = userEvent.setup();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("clicking with no onSelect does not throw", async () => {
    render(<McpRow server={makeServer()} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("mcp-row"));
    // No assertion needed — absence of error is the assertion.
  });
});

describe("McpRow / edge cases", () => {
  it("missing args renders only the command", () => {
    render(
      <McpRow
        server={makeServer({
          config: { command: "/usr/local/bin/mcp-foo" },
        })}
      />,
    );
    expect(screen.getByTestId("mcp-row-url")).toHaveTextContent(
      "/usr/local/bin/mcp-foo",
    );
  });

  it("empty args array renders only the command (no trailing space)", () => {
    render(
      <McpRow
        server={makeServer({
          config: { command: "node", args: [] },
        })}
      />,
    );
    expect(screen.getByTestId("mcp-row-url").textContent).toBe("node");
  });

  it("transport prop overrides the default 'stdio'", () => {
    render(<McpRow server={makeServer()} transport="http" />);
    expect(screen.getByTestId("mcp-row-transport-pill")).toHaveTextContent(
      "http",
    );
  });

  it("level=global renders an info-tone level pill", () => {
    render(<McpRow server={makeServer({ level: "global" })} />);
    const pill = screen.getByTestId("mcp-row-level-pill");
    expect(pill).toHaveTextContent("global");
    expect(pill.getAttribute("data-tone")).toBe("info");
  });

  it("level=workspace renders a success-tone level pill", () => {
    render(<McpRow server={makeServer({ level: "workspace" })} />);
    const pill = screen.getByTestId("mcp-row-level-pill");
    expect(pill).toHaveTextContent("workspace");
    expect(pill.getAttribute("data-tone")).toBe("success");
  });

  it("level=project renders a neutral-tone level pill", () => {
    render(<McpRow server={makeServer({ level: "project" })} />);
    const pill = screen.getByTestId("mcp-row-level-pill");
    expect(pill).toHaveTextContent("project");
    expect(pill.getAttribute("data-tone")).toBe("neutral");
  });

  it("data-server-name attribute exposes the server name for query selectors", () => {
    render(<McpRow server={makeServer({ name: "filesystem" })} />);
    expect(screen.getByTestId("mcp-row")).toHaveAttribute(
      "data-server-name",
      "filesystem",
    );
  });
});
