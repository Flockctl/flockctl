/**
 * Favicon badge renderer.
 *
 * Composes a base icon image with a small red counter circle and bakes the
 * result into a PNG data URL that can be assigned to `<link rel="icon">`.
 *
 * Why canvas → PNG instead of mutating the SVG favicon: older browsers
 * (including a few production-current Safari builds) don't reliably
 * re-render an SVG favicon after its `href` changes. Re-rasterising into a
 * data URL forces the browser to drop its cached glyph and pick up the new
 * pixels every time. Cost is a few ms of canvas work per swap, which the
 * caller already debounces.
 *
 * 32×32 is a deliberate compromise:
 *   - Browsers downscale to 16×16 cleanly when the OS asks for a small
 *     glyph; rendering at the source resolution avoids ugly fractional
 *     scaling.
 *   - High-DPI displays often pick a 32×32 favicon over the 16×16
 *     alternative, so we get a sharp result without shipping multiple
 *     sizes.
 */

const SIZE = 32;

/**
 * Render a favicon with a red counter badge in the top-right quadrant.
 *
 * Returns the original `baseImageUrl` when there is nothing to badge
 * (`count <= 0`, NaN, or no canvas 2D context — typical in headless test
 * environments). The "no badge" path is intentionally cheap so callers can
 * invoke this on every count change without branching.
 *
 * `count > 9` collapses to "9+" because more than two glyphs at 11px
 * become illegible at the favicon's eventual on-screen size (16×16 in most
 * tabs).
 */
export async function renderBadge(
  count: number,
  baseImageUrl: string,
): Promise<string> {
  // Coerce defensively: callers may hand us `data?.total` straight from
  // React Query, which can briefly be `undefined` cast to NaN.
  const safe = Math.max(
    0,
    Math.floor(Number.isFinite(count) ? count : 0),
  );
  if (safe === 0) return baseImageUrl;

  if (typeof document === "undefined") return baseImageUrl;

  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return baseImageUrl;

  // 1. Draw the base icon. We let the browser decode asynchronously via
  //    `img.decode()` so the canvas draw never paints a half-loaded image.
  //    If decoding throws (broken URL, CSP-blocked, etc.) we surface the
  //    base URL unchanged — better to render an unbadged favicon than to
  //    explode the caller's tab.
  let img: HTMLImageElement;
  try {
    img = new Image();
    img.src = baseImageUrl;
    await img.decode();
  } catch {
    return baseImageUrl;
  }
  try {
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
  } catch {
    // `drawImage` can throw `SecurityError` if the source is a tainted
    // cross-origin image. The original favicon is shipped same-origin so
    // this is unlikely in practice, but the fallback keeps us safe.
    return baseImageUrl;
  }

  // 2. Draw the red badge circle. rose-600 (#e11d48) was chosen for
  //    contrast against both light and dark base icons — see the visual
  //    baselines in `e2e/__screenshots__/notifications.spec.ts/`.
  const cx = SIZE - 9;
  const cy = 9;
  const r = 8;
  ctx.fillStyle = "#e11d48";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.fill();

  // 3. Draw the count. Two-digit "9+" is the cap; anything higher would
  //    overflow the circle at 11px.
  const label = safe > 9 ? "9+" : String(safe);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 11px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // The +0.5 nudge optically centres the label inside the circle —
  // ascender/descender metrics on the system font leave the visual centre
  // a hair below the geometric one.
  ctx.fillText(label, cx, cy + 0.5);

  return canvas.toDataURL("image/png");
}
