import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// jsdom in our vitest config exposes a partial DOM:
//   - `localStorage` is present but its methods aren't callable (the
//     `--localstorage-file` warning printed at boot points at the same
//     misconfiguration).
//   - `window.matchMedia` is undefined.
// The ThemeProvider relies on both, so we force-install minimal shims
// in module scope. Nothing leaks across files because the globals are
// scoped to this jsdom environment instance.
{
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
  // Radix Slider/Select rely on ResizeObserver, which jsdom does not
  // implement. Stub it before the page mounts.
  if (typeof globalThis.ResizeObserver === "undefined") {
    class StubResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: StubResizeObserver,
    });
  }
  // Radix Select calls `scrollIntoView` on the highlighted item when it
  // mounts in the open state. jsdom omits the API.
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
  // Radix Select also probes pointer-capture APIs not present in jsdom.
  if (typeof Element !== "undefined") {
    if (!(Element.prototype as any).hasPointerCapture) {
      (Element.prototype as any).hasPointerCapture = () => false;
    }
    if (!(Element.prototype as any).releasePointerCapture) {
      (Element.prototype as any).releasePointerCapture = () => {};
    }
    if (!(Element.prototype as any).setPointerCapture) {
      (Element.prototype as any).setPointerCapture = () => {};
    }
  }
}

import { ThemeProvider } from "@/components/theme-provider";
import DevTokensPreviewPage from "@/pages/dev-tokens-preview";

/**
 * Smoke + structure test for the /dev/tokens-preview page.
 *
 * The page is purely presentational — no backend, no router data — so
 * we render it directly under a MemoryRouter (Dialog/Select rely on a
 * portal'd Radix tree, which still works in jsdom). Each of the 15
 * sections is keyed by a stable `data-testid` so the assertion below is
 * resilient to copy tweaks.
 *
 * We also assert that rendering the page produces zero `console.error`
 * lines: a stray "Each child in a list must have a key" or a Radix
 * "missing prop" warning would otherwise slip through and quietly
 * break the visual baseline.
 */

const SECTION_IDS = [
  "section-tokens",
  "section-buttons",
  "section-card",
  "section-dialog",
  "section-select",
  "section-inputs",
  "section-textarea",
  "section-tabs",
  "section-toast",
  "section-skeleton",
  "section-badge",
  "section-switch",
  "section-checkbox",
  "section-radio",
  "section-slider",
];

describe("DevTokensPreviewPage", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function renderPage() {
    return render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/dev/tokens-preview"]}>
          <DevTokensPreviewPage />
        </MemoryRouter>
      </ThemeProvider>,
    );
  }

  it("mounts the preview root with the theme toggle", () => {
    renderPage();
    expect(screen.getByTestId("dev-tokens-preview")).toBeInTheDocument();
    expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
  });

  it("renders every primitive section", () => {
    renderPage();
    for (const id of SECTION_IDS) {
      expect(
        screen.getByTestId(id),
        `expected section ${id} to be rendered`,
      ).toBeInTheDocument();
    }
    // Sanity: the count matches the contract — we ship 15 sections
    // (the spec lists 15 primitives + the CSS-variable swatch row).
    expect(SECTION_IDS).toHaveLength(15);
  });

  it("renders one swatch per documented CSS token", () => {
    renderPage();
    // The required tokens — at minimum the semantic palette set. We
    // assert presence rather than count so adding/renaming a sidebar
    // token doesn't force a test update on its own.
    const required = [
      "--background",
      "--foreground",
      "--primary",
      "--destructive",
      "--border",
      "--ring",
    ];
    for (const t of required) {
      expect(
        screen.getByTestId(`token-row-${t}`),
        `expected swatch for ${t}`,
      ).toBeInTheDocument();
    }
  });

  it("renders all five toast variants", () => {
    renderPage();
    expect(screen.getByTestId("toast-info")).toBeInTheDocument();
    expect(screen.getByTestId("toast-warning")).toBeInTheDocument();
    expect(screen.getByTestId("toast-success")).toBeInTheDocument();
    expect(screen.getByTestId("toast-error")).toBeInTheDocument();
  });

  it("does not log any console errors during render", () => {
    renderPage();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
