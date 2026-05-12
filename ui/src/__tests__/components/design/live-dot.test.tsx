import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { LiveDot } from "@/components/design/LiveDot";

describe("LiveDot", () => {
  it("renders a wrapper with the default xs size and no halo for idle", () => {
    const { container, queryByTestId } = render(<LiveDot state="idle" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.dataset.state).toBe("idle");
    expect(wrapper.dataset.size).toBe("xs");
    expect(wrapper.className).toContain("relative");
    expect(wrapper.className).toContain("inline-flex");
    expect(wrapper.className).toContain("h-1.5");
    expect(wrapper.className).toContain("w-1.5");

    // No halo on idle.
    expect(queryByTestId("live-dot-halo")).toBeNull();
    const core = queryByTestId("live-dot-core")!;
    expect(core.className).toContain("bg-zinc-400");
    expect(core.className).toContain("rounded-full");
  });

  it("state='live' renders both halo and solid emerald dot", () => {
    const { queryByTestId } = render(<LiveDot state="live" />);
    const halo = queryByTestId("live-dot-halo");
    const core = queryByTestId("live-dot-core");
    expect(halo).not.toBeNull();
    expect(core).not.toBeNull();

    expect(halo!.className).toContain("absolute");
    expect(halo!.className).toContain("rounded-full");
    expect(halo!.className).toContain("bg-emerald-400");
    expect(halo!.className).toContain("opacity-60");
    expect(halo!.className).toContain("animate-ping");
    expect(halo!.getAttribute("aria-hidden")).toBe("true");

    expect(core!.className).toContain("bg-emerald-500");
    expect(core!.className).toContain("rounded-full");
  });

  it("state='error' renders red solid dot, no halo", () => {
    const { queryByTestId } = render(<LiveDot state="error" />);
    expect(queryByTestId("live-dot-halo")).toBeNull();
    const core = queryByTestId("live-dot-core")!;
    expect(core.className).toContain("bg-red-500");
    expect(core.className).not.toContain("animate-ping");
  });

  it("size='sm' applies the larger h-2 w-2 dimensions on wrapper and core", () => {
    const { container, queryByTestId } = render(
      <LiveDot state="live" size="sm" />,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.dataset.size).toBe("sm");
    expect(wrapper.className).toContain("h-2");
    expect(wrapper.className).toContain("w-2");
    expect(wrapper.className).not.toContain("h-1.5");

    const core = queryByTestId("live-dot-core")!;
    expect(core.className).toContain("h-2");
    expect(core.className).toContain("w-2");
  });

  it("pulse=false on a live state suppresses the halo", () => {
    const { queryByTestId, container } = render(
      <LiveDot state="live" pulse={false} />,
    );
    expect(queryByTestId("live-dot-halo")).toBeNull();
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.dataset.pulse).toBe("false");

    // The solid emerald dot still renders.
    const core = queryByTestId("live-dot-core")!;
    expect(core.className).toContain("bg-emerald-500");
  });

  it("pulse=true on idle/error does not paint a halo (only live ever pulses)", () => {
    const { queryByTestId: idleQuery } = render(
      <LiveDot state="idle" pulse={true} />,
    );
    expect(idleQuery("live-dot-halo")).toBeNull();

    const { queryByTestId: errorQuery } = render(
      <LiveDot state="error" pulse={true} />,
    );
    expect(errorQuery("live-dot-halo")).toBeNull();
  });

  it("default pulse derives from state (live → true, idle/error → false)", () => {
    const { container: liveC } = render(<LiveDot state="live" />);
    expect((liveC.firstElementChild as HTMLElement).dataset.pulse).toBe(
      "true",
    );

    const { container: idleC } = render(<LiveDot state="idle" />);
    expect((idleC.firstElementChild as HTMLElement).dataset.pulse).toBe(
      "false",
    );

    const { container: errC } = render(<LiveDot state="error" />);
    expect((errC.firstElementChild as HTMLElement).dataset.pulse).toBe(
      "false",
    );
  });

  it("reduced-motion: halo carries motion-reduce:animate-none so the ping disables under prefers-reduced-motion", () => {
    // jsdom does not run CSS animations, so we can't observe getAnimations()
    // here — that's what the Playwright reduced-motion tier covers. The unit
    // test instead asserts that the class wired to disable the keyframes
    // under `prefers-reduced-motion: reduce` is present on the halo, which
    // is the contract the CSS tier relies on.
    const { queryByTestId } = render(<LiveDot state="live" />);
    const halo = queryByTestId("live-dot-halo")!;
    expect(halo.className).toContain("motion-reduce:animate-none");
  });

  it("merges caller className without dropping defaults", () => {
    const { container } = render(
      <LiveDot state="idle" className="ml-2 align-middle" />,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("ml-2");
    expect(wrapper.className).toContain("align-middle");
    expect(wrapper.className).toContain("relative");
    expect(wrapper.className).toContain("inline-flex");
  });

  it("forwards extra HTML attributes (aria-label, title, role)", () => {
    const { getByLabelText } = render(
      <LiveDot
        state="live"
        aria-label="connection status"
        title="connected"
        role="status"
      />,
    );
    const el = getByLabelText("connection status");
    expect(el.getAttribute("title")).toBe("connected");
    expect(el.getAttribute("role")).toBe("status");
  });
});
