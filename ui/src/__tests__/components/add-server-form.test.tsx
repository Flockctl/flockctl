/**
 * AddServerForm — SSH-only Add Server dialog body.
 *
 * Contract under test:
 *   • Field order (muscle memory + a11y): Name → Host → User → Port →
 *     Identity file → Remote port.
 *   • Remote port lives inside a <details>/"Advanced" disclosure so only
 *     power users see it by default.
 *   • Submit is disabled until both Name and Host pass validation.
 *   • Client-side host regex matches the server's: `/^[A-Za-z0-9_.\-@:]+$/`.
 *   • Submit payload shape:
 *       { name, ssh: { host, user?, port?, identityFile?, remotePort? } }
 *     with every *optional* key OMITTED when its input is blank.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddServerForm, SSH_HOST_REGEX } from "@/components/server-connections";

describe("AddServerForm — field layout", () => {
  it("renders Name, Host, User, Port, Identity file labels in order", () => {
    const { container } = render(<AddServerForm onSubmit={vi.fn()} />);
    // Read the <label for="server-*"> elements directly so help text and
    // the "Advanced" summary don't sneak into the order.
    const labels = Array.from(container.querySelectorAll("label[for]"));
    const texts = labels
      .map((l) => (l.textContent ?? "").replace(/\s*\*\s*$/, "").trim())
      .filter((t) => t.length > 0);
    // First five visible labels must be in the mandated order. Remote port
    // is inside the collapsed <details> and so not part of the visual tab
    // order — see the dedicated "Advanced disclosure" test below.
    expect(texts.slice(0, 5)).toEqual(["Name", "Host", "User", "Port", "Identity file"]);
  });

  it("marks Name and Host as required", () => {
    render(<AddServerForm onSubmit={vi.fn()} />);
    const nameInput = screen.getByLabelText(/^Name/) as HTMLInputElement;
    const hostInput = screen.getByLabelText(/^Host/) as HTMLInputElement;
    expect(nameInput.required).toBe(true);
    expect(hostInput.required).toBe(true);
  });

  it("sets default placeholders that communicate the defaults (22, 52077)", async () => {
    const user = userEvent.setup();
    render(<AddServerForm onSubmit={vi.fn()} />);

    const portInput = screen.getByLabelText("Port") as HTMLInputElement;
    expect(portInput.placeholder).toBe("22");

    // Remote port lives inside a collapsed <details> — the DOM node exists
    // in JSDOM but is hidden visually. Assert on the disclosure state, not
    // on queryByLabelText (JSDOM doesn't honour `open` for visibility).
    const summary = screen.getByText("Advanced");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);

    await user.click(summary);
    expect(details.open).toBe(true);
    const remoteInput = screen.getByLabelText("Remote port") as HTMLInputElement;
    expect(remoteInput.placeholder).toBe("52077");
  });
});

describe("AddServerForm — host regex parity with the server", () => {
  it("exports a regex that matches the server's SSH_HOST_REGEX", () => {
    // Must be byte-for-byte the same pattern as
    // `src/routes/meta.ts::SSH_HOST_REGEX`. Drift breaks the UX contract
    // (client rejects strings the server would have accepted, or vice versa).
    expect(SSH_HOST_REGEX.source).toBe("^[A-Za-z0-9_.\\-@:]+$");
  });

  it.each([
    "host.example.com",
    "user@host.example.com",
    "10.0.0.5",
    "alias",
    "host:22",
    "HOST_1.example",
    "weird-name_42",
  ])("accepts valid host %s", (h) => {
    expect(SSH_HOST_REGEX.test(h)).toBe(true);
  });

  it.each([
    "host with spaces",
    "host;rm -rf",
    "host|pipe",
    "host$var",
    "host`cmd`",
    "(paren)",
    "back\\slash",
    "",
  ])("rejects invalid host %s", (h) => {
    expect(SSH_HOST_REGEX.test(h)).toBe(false);
  });
});

describe("AddServerForm — submit gating", () => {
  it("disables submit until Name and Host are both valid", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<AddServerForm onSubmit={onSubmit} />);

    const submit = screen.getByRole("button", { name: /add server/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/^Name/), "Production");
    expect(submit).toBeDisabled(); // host still empty

    await user.type(screen.getByLabelText(/^Host/), "host.example.com");
    expect(submit).not.toBeDisabled();
  });

  it("keeps submit disabled when Host contains invalid characters", async () => {
    const user = userEvent.setup();
    render(<AddServerForm onSubmit={vi.fn()} />);
    await user.type(screen.getByLabelText(/^Name/), "Bad");
    await user.type(screen.getByLabelText(/^Host/), "bad host!");
    expect(screen.getByRole("button", { name: /add server/i })).toBeDisabled();
    // Inline error message surfaces for the user.
    expect(screen.getByText(/invalid characters/i)).toBeInTheDocument();
  });

  it("is disabled while submitting even if fields are valid", () => {
    render(
      <AddServerForm
        onSubmit={vi.fn()}
        submitting
      />,
    );
    // Saving… label replaces the submit text while in-flight.
    const btn = screen.getByRole("button", { name: /saving/i });
    expect(btn).toBeDisabled();
  });
});

describe("AddServerForm — payload construction", () => {
  it("omits every optional ssh key when those inputs are blank", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<AddServerForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/^Name/), "Prod");
    await user.type(screen.getByLabelText(/^Host/), "prod.example.com");
    await user.click(screen.getByRole("button", { name: /add server/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]![0] as {
      name: string;
      ssh: Record<string, unknown>;
    };
    expect(payload).toEqual({
      name: "Prod",
      ssh: { host: "prod.example.com" },
    });
    // Defensive: no undefined keys made it into the payload.
    expect(Object.keys(payload.ssh)).toEqual(["host"]);
    expect("user" in payload.ssh).toBe(false);
    expect("port" in payload.ssh).toBe(false);
    expect("identityFile" in payload.ssh).toBe(false);
    expect("remotePort" in payload.ssh).toBe(false);
  });

  it("includes user, port, and identityFile when provided", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<AddServerForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/^Name/), "Staging");
    await user.type(screen.getByLabelText(/^Host/), "stg.example.com");
    await user.type(screen.getByLabelText("User"), "deploy");
    await user.type(screen.getByLabelText("Port"), "2222");
    await user.type(screen.getByLabelText("Identity file"), "~/.ssh/id_ed25519");
    await user.click(screen.getByRole("button", { name: /add server/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Staging",
      ssh: {
        host: "stg.example.com",
        user: "deploy",
        port: 2222,
        identityFile: "~/.ssh/id_ed25519",
      },
    });
  });

  it("includes remotePort when the Advanced disclosure is opened and filled", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<AddServerForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/^Name/), "Remote");
    await user.type(screen.getByLabelText(/^Host/), "r.example.com");
    await user.click(screen.getByText("Advanced"));
    await user.type(screen.getByLabelText("Remote port"), "8080");
    await user.click(screen.getByRole("button", { name: /add server/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Remote",
      ssh: { host: "r.example.com", remotePort: 8080 },
    });
  });

  it("trims whitespace from name, host, and optional string inputs", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<AddServerForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/^Name/), "  Trim  ");
    await user.type(screen.getByLabelText(/^Host/), "  host.example.com  ");
    await user.type(screen.getByLabelText("User"), "  bob  ");
    await user.type(screen.getByLabelText("Identity file"), "  /tmp/key  ");
    await user.click(screen.getByRole("button", { name: /add server/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Trim",
      ssh: {
        host: "host.example.com",
        user: "bob",
        identityFile: "/tmp/key",
      },
    });
  });
});

describe("AddServerForm — Advanced disclosure", () => {
  it("hides Remote port until Advanced is expanded", async () => {
    const user = userEvent.setup();
    render(<AddServerForm onSubmit={vi.fn()} />);

    // <details> collapsed: the contained label is not accessible via
    // getByLabelText because the form association is still present in DOM
    // but JSDOM reports the input as not visible. The queryBy* still finds
    // it, so we assert on the open/closed attribute of the <details>.
    const summary = screen.getByText("Advanced");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);

    await user.click(summary);
    expect(details.open).toBe(true);
    expect(within(details).getByLabelText("Remote port")).toBeInTheDocument();
  });
});

describe("AddServerForm — cancel + error surfacing", () => {
  it("fires onCancel when the Cancel button is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<AddServerForm onSubmit={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders a server-provided error under the form", () => {
    render(<AddServerForm onSubmit={vi.fn()} error="bootstrap exploded" />);
    expect(screen.getByText("bootstrap exploded")).toBeInTheDocument();
  });

  it("does not render a Cancel button when onCancel is omitted", () => {
    render(<AddServerForm onSubmit={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });
});
