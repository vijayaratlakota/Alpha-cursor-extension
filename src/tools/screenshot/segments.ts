// Tool 4 — Full Page Screenshot: pure segmentation math (task 13.1).
//
// `computeSegments(totalHeight, viewportHeight, devicePixelRatio)` is the pure
// core of the full-page screenshot feature (Req 9.2, 9.3). It decides how to
// drive the page's auto-scroll and how to stitch the captured viewport images
// back into a single, gap-free image of the whole page.
//
// ---------------------------------------------------------------------------
// Why this is non-trivial: the final-segment overlap
// ---------------------------------------------------------------------------
// `chrome.tabs.captureVisibleTab` ALWAYS returns a full-viewport image — there
// is no way to ask it for a partial strip. To cover a page taller than the
// viewport we scroll in viewport-sized steps and capture each step. The catch
// is the bottom of the page: the browser cannot scroll past
// `maxScroll = totalHeight - viewportHeight`, so the LAST capture's viewport
// overlaps the previous one. If we naïvely drew every captured viewport at
// `destY = scrollY` the overlapping band would be painted twice and the
// composed image would be taller than the page (a duplicated strip).
//
// CHOSEN APPROACH — trim the final segment's *source* region, not its scroll:
//   * For every fully-fitting step we copy the entire viewport
//     (`sourceY = 0`, `sourceHeight = viewportHeight`) to `destY = scrollY`.
//   * For the trailing remainder we still scroll to `maxScroll` (the deepest
//     the browser allows) but copy ONLY the bottom `remainder` pixels of that
//     captured viewport. We compute the in-image offset
//     `sourceY = viewportHeight - remainder` so the copied band begins exactly
//     where the last full segment ended, and place it at
//     `destY = numFullSegments * viewportHeight`.
//
// This yields destination rectangles that tile `[0, totalHeight]` perfectly:
// each segment's `destY + sourceHeight` equals the next segment's `destY`, and
// the last segment ends exactly at `totalHeight`. No gaps, no overlap, no
// duplicated strip — which is precisely Property 10.
//
// ---------------------------------------------------------------------------
// Device pixel ratio / Full HD (Req 9.3)
// ---------------------------------------------------------------------------
// `captureVisibleTab` produces images at the page's `devicePixelRatio`, so a
// 1280×800 CSS viewport on a 2× display yields a 2560×1600 image. The composed
// canvas must therefore be sized in DEVICE pixels (`css * dpr`) for the capture
// to be drawn 1:1 without resampling. Each segment carries both CSS-pixel
// geometry (used to drive scrolling and reason about coverage) and the
// device-pixel geometry (used by the stitcher's `ctx.drawImage`). Sizing the
// canvas in device pixels is what lets the output meet the Full HD (1920px) /
// 2K (2560px) width thresholds WHERE THE PAGE WIDTH PERMITS — see
// {@link meetsFullHdWidth} / {@link composedWidthPx}, which the stitcher
// (task 13.3) uses with the page's CSS width.

/** Full HD width threshold in device pixels (Req 9.3). */
export const FULL_HD_WIDTH = 1920;

/** 2K / QHD width threshold in device pixels (Req 9.3, "where the page width permits"). */
export const QHD_WIDTH = 2560;

/**
 * One scroll-and-capture step plus the geometry needed to stitch its captured
 * viewport image into the composed full-page image.
 *
 * CSS-pixel fields (`scrollY`, `sourceY`, `sourceHeight`, `destY`) describe the
 * step in page coordinates. The `device*` fields are the same rectangle scaled
 * by the effective device pixel ratio and are what the stitcher passes to
 * `CanvasRenderingContext2D.drawImage` (the captured image is in device px).
 */
export interface ScreenshotSegment {
  /** Zero-based order of this segment (0 is the top of the page). */
  index: number;
  /** Page scroll offset (CSS px) to set before calling `captureVisibleTab`. */
  scrollY: number;
  /** Y offset (CSS px) WITHIN the captured viewport image to start copying from. */
  sourceY: number;
  /** Height (CSS px) of the region to copy out of the captured viewport image. */
  sourceHeight: number;
  /** Y offset (CSS px) in the composed full-page image where this region is drawn. */
  destY: number;
  /** {@link sourceY} scaled to device pixels (captured image is at `dpr`). */
  deviceSourceY: number;
  /** {@link sourceHeight} scaled to device pixels. */
  deviceSourceHeight: number;
  /** {@link destY} scaled to device pixels (composed canvas is sized in device px). */
  deviceDestY: number;
}

/**
 * Normalize a device pixel ratio: any non-finite or non-positive value falls
 * back to `1` (Req 9.3 edge case — `dpr` defaults to 1 if `<= 0`).
 */
export function effectiveDpr(devicePixelRatio: number): number {
  return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
}

/** True when `value` is a finite, strictly-positive number. */
function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Compute the scroll/stitch plan for a full-page screenshot.
 *
 * The returned segments' destination rectangles tile the page height
 * `[0, totalHeight]` with no gaps and no overlap (Property 10): every segment
 * is `viewportHeight` tall except the last, which is trimmed at its SOURCE so
 * the composed image is exactly `totalHeight` tall (see the module header for
 * the final-overlap rationale).
 *
 * Edge cases:
 *   * `totalHeight <= viewportHeight` (both positive) → a single segment
 *     covering `[0, totalHeight]` (one `captureVisibleTab` is enough).
 *   * Any zero/negative/non-finite `totalHeight` or `viewportHeight` → `[]`
 *     (nothing can be captured safely).
 *   * `devicePixelRatio <= 0` or non-finite → treated as `1`.
 *
 * @param totalHeight Full scrollable page height in CSS px.
 * @param viewportHeight Visible viewport height in CSS px.
 * @param devicePixelRatio Page device pixel ratio (e.g. `window.devicePixelRatio`).
 * @returns Ordered segments from the top of the page to the bottom.
 */
export function computeSegments(
  totalHeight: number,
  viewportHeight: number,
  devicePixelRatio: number,
): ScreenshotSegment[] {
  // Guard zero/negative/non-finite inputs: there is nothing safe to capture.
  if (!isPositiveFinite(totalHeight) || !isPositiveFinite(viewportHeight)) {
    return [];
  }

  const dpr = effectiveDpr(devicePixelRatio);

  const make = (
    index: number,
    scrollY: number,
    sourceY: number,
    sourceHeight: number,
    destY: number,
  ): ScreenshotSegment => ({
    index,
    scrollY,
    sourceY,
    sourceHeight,
    destY,
    deviceSourceY: sourceY * dpr,
    deviceSourceHeight: sourceHeight * dpr,
    deviceDestY: destY * dpr,
  });

  // Single-capture case: the whole page fits within one viewport. Capture at
  // the top and copy only the [0, totalHeight] band (the captured viewport may
  // be taller than the page content).
  if (totalHeight <= viewportHeight) {
    return [make(0, 0, 0, totalHeight, 0)];
  }

  const segments: ScreenshotSegment[] = [];

  // Number of full viewport-tall steps that fit before the trailing remainder.
  const numFull = Math.floor(totalHeight / viewportHeight);
  for (let k = 0; k < numFull; k++) {
    const top = k * viewportHeight;
    // Each full step scrolls to its own top and copies the entire viewport.
    segments.push(make(k, top, 0, viewportHeight, top));
  }

  // Trailing remainder: the band [numFull*viewportHeight, totalHeight] that the
  // full steps did not cover. When totalHeight is an exact multiple of the
  // viewport, remainder is 0 and the full steps already cover everything.
  const coveredTop = numFull * viewportHeight;
  const remainder = totalHeight - coveredTop;
  if (remainder > 0) {
    // Deepest scroll the browser allows; its captured viewport overlaps the
    // previous full step, so we copy only the bottom `remainder` pixels.
    const maxScroll = totalHeight - viewportHeight;
    const sourceY = viewportHeight - remainder; // = coveredTop - maxScroll
    segments.push(make(numFull, maxScroll, sourceY, remainder, coveredTop));
  }

  return segments;
}

/**
 * Height of the composed full-page image in DEVICE pixels: `totalHeight * dpr`.
 * Equals the sum of every segment's `deviceSourceHeight`. The stitcher sizes
 * the destination canvas to this height.
 */
export function composedHeightPx(
  totalHeight: number,
  devicePixelRatio: number,
): number {
  if (!isPositiveFinite(totalHeight)) {
    return 0;
  }
  return totalHeight * effectiveDpr(devicePixelRatio);
}

/**
 * Width of the composed full-page image in DEVICE pixels for a given page CSS
 * width: `pageWidthCss * dpr`. The stitcher sizes the destination canvas width
 * to this value so the output meets the Full HD / 2K thresholds where the page
 * is wide enough (Req 9.3).
 */
export function composedWidthPx(
  pageWidthCss: number,
  devicePixelRatio: number,
): number {
  if (!isPositiveFinite(pageWidthCss)) {
    return 0;
  }
  return pageWidthCss * effectiveDpr(devicePixelRatio);
}

/**
 * Whether the composed output meets the Full HD width threshold (1920 device
 * px) for a page of the given CSS width at the given dpr — i.e. whether "the
 * page width permits" Full HD output (Req 9.3). Use {@link QHD_WIDTH} for the
 * 2K check.
 */
export function meetsFullHdWidth(
  pageWidthCss: number,
  devicePixelRatio: number,
): boolean {
  return composedWidthPx(pageWidthCss, devicePixelRatio) >= FULL_HD_WIDTH;
}
