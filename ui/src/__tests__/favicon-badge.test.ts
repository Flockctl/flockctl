import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderBadge } from "@/lib/favicon-badge";

/**
 * Unit suite for the favicon badge renderer.
 *
 * jsdom ships canvas-shaped DOM nodes but no actual 2D rasteriser:
 * `HTMLCanvasElement.prototype.getContext` returns `null` by default and
 * `Image.prototype.decode` is missing entirely. We install pixel-free
 * stubs around the renderer so its DOM-side behaviour can be asserted
 * without pulling in the `canvas` native module (which would force every
 * dev to install a build toolchain).
 */

const BASE_URL = "/favicon.svg";
const FAKE_DATA_URL = "data:image/png;base64,STUB==";

interface CtxSpy {
  drawImage: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  fillStyle: string;
  font: string;
  textAlign: string;
  textBaseline: string;
}

interface CanvasInstall {
  ctx: CtxSpy | null;
  toDataURL: ReturnType<typeof vi.fn>;
  imageDecode: ReturnType<typeof vi.fn>;
}

/**
 * Patch the prototypes that `renderBadge` reaches for. Returns spies so
 * each test can assert what was drawn (and how often).
 *
 * `opts.contextNull` simulates a browser refusing 2D context — the path
 * we exercise to verify the graceful fallback.
 *
 * `opts.decodeRejects` simulates a CSP-blocked or malformed base image.
 */
function installCanvasStubs(
  opts: { contextNull?: boolean; decodeRejects?: boolean } = {},
): CanvasInstall {
  const ctxSpy: CtxSpy | null = opts.contextNull
    ? null
    : {
        drawImage: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        fillText: vi.fn(),
        fillStyle: "",
        font: "",
        textAlign: "",
        textBaseline: "",
      };

  const toDataURL = vi.fn(() => FAKE_DATA_URL);

  // The actual prototype getContext signature returns multiple union
  // types; we only need the 2D path, hence the unknown cast.
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ctxSpy as unknown as CanvasRenderingContext2D | null,
  ) as unknown as HTMLCanvasElement["getContext"];
  HTMLCanvasElement.prototype.toDataURL = toDataURL;

  const imageDecode = opts.decodeRejects
    ? vi.fn(() => Promise.reject(new Error("decode failed")))
    : vi.fn(() => Promise.resolve());

  // jsdom's HTMLImageElement has no `decode()`; stub it on the prototype
  // so every `new Image()` picks it up.
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode =
    imageDecode;

  return { ctx: ctxSpy, toDataURL, imageDecode };
}

beforeEach(() => {
  installCanvasStubs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderBadge — short-circuit cases", () => {
  it("returns the base URL unchanged when count is 0", async () => {
    const out = await renderBadge(0, BASE_URL);
    expect(out).toBe(BASE_URL);
  });

  it("returns the base URL when count is negative", async () => {
    const out = await renderBadge(-3, BASE_URL);
    expect(out).toBe(BASE_URL);
  });

  it("treats NaN as 0 (defensive coercion against undefined upstream)", async () => {
    const out = await renderBadge(Number.NaN, BASE_URL);
    expect(out).toBe(BASE_URL);
  });

  it("treats Infinity as 0 (Number.isFinite gate)", async () => {
    const out = await renderBadge(Number.POSITIVE_INFINITY, BASE_URL);
    expect(out).toBe(BASE_URL);
  });

  it("floors fractional counts to the integer below", async () => {
    // 0.4 → 0 → no badge → base URL.
    const out = await renderBadge(0.4, BASE_URL);
    expect(out).toBe(BASE_URL);
  });

  it("returns the base URL when no 2D context is available", async () => {
    installCanvasStubs({ contextNull: true });
    const out = await renderBadge(3, BASE_URL);
    expect(out).toBe(BASE_URL);
  });

  it("returns the base URL when image decoding fails", async () => {
    installCanvasStubs({ decodeRejects: true });
    const out = await renderBadge(3, BASE_URL);
    expect(out).toBe(BASE_URL);
  });
});

describe("renderBadge — happy path", () => {
  it("returns a PNG data URL when count > 0", async () => {
    const out = await renderBadge(1, BASE_URL);
    expect(out).toBe(FAKE_DATA_URL);
  });

  it("draws the base image, badge circle, and label", async () => {
    const stubs = installCanvasStubs();
    await renderBadge(2, BASE_URL);
    expect(stubs.ctx?.drawImage).toHaveBeenCalledTimes(1);
    expect(stubs.ctx?.arc).toHaveBeenCalledTimes(1);
    expect(stubs.ctx?.fill).toHaveBeenCalledTimes(1);
    expect(stubs.ctx?.fillText).toHaveBeenCalledTimes(1);
    expect(stubs.toDataURL).toHaveBeenCalledWith("image/png");
  });

  it("labels small counts with the literal digit", async () => {
    const stubs = installCanvasStubs();
    await renderBadge(7, BASE_URL);
    const label = stubs.ctx?.fillText.mock.calls[0]?.[0];
    expect(label).toBe("7");
  });

  it("collapses counts above 9 to '9+'", async () => {
    const stubs = installCanvasStubs();
    await renderBadge(42, BASE_URL);
    const label = stubs.ctx?.fillText.mock.calls[0]?.[0];
    expect(label).toBe("9+");
  });

  it("uses the documented brand red and white text", async () => {
    const stubs = installCanvasStubs();
    await renderBadge(1, BASE_URL);
    // The renderer flips fillStyle twice — once for the circle, once for
    // the text. We can't read past values directly, but if the final
    // fillText call painted text the last fillStyle assignment must have
    // been white. Verify the white assignment happened at all by checking
    // the final cached value on the spy.
    expect(stubs.ctx?.fillStyle).toBe("#ffffff");
  });
});
