/**
 * Alpha Cursor — OCR drag-selection geometry pure helper (task 19.1).
 *
 * A single PURE, side-effect-free function backing Tool 10 (OCR Text
 * Extraction). The OCR flow lets the user drag a rectangular selection over the
 * page; the drag is described by two arbitrary points — the where the drag
 * started and where it ended — in any direction (the end point may be above
 * and/or left of the start).
 *
 *  - {@link normalizeSelectionRect} converts any two drag points into a
 *    normalized axis-aligned rectangle whose `x`/`y` are the top-left corner
 *    and whose `width`/`height` are ALWAYS non-negative, regardless of drag
 *    direction (Req 15.2, Property 17). Equal points yield a zero-size rect.
 *
 * It is exported cleanly for property-based testing (Property 17 in task 19.2).
 * It never touches `chrome.*`, the DOM, or any other ambient state. The drag
 * overlay + tesseract.js wiring lives in task 19.3.
 */

/** A 2D point in CSS pixels (viewport coordinates). */
export interface Point {
  x: number;
  y: number;
}

/**
 * A normalized axis-aligned rectangle: `x`/`y` are the top-left corner and
 * `width`/`height` are non-negative extents.
 */
export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Normalize a drag described by two points into an axis-aligned rectangle that
 * bounds the same region regardless of drag direction (Property 17).
 *
 * The result is independent of which point is `start` and which is `end`:
 *
 *  - `x` = `min(start.x, end.x)` — the left-most x of the two points.
 *  - `y` = `min(start.y, end.y)` — the top-most y of the two points.
 *  - `width` = `abs(end.x - start.x)` — always non-negative.
 *  - `height` = `abs(end.y - start.y)` — always non-negative.
 *
 * Equal points (a click without a drag) produce a zero-size rect anchored at
 * that point.
 *
 * @param start The point where the drag began.
 * @param end The point where the drag ended (may be in any direction).
 * @returns A {@link SelectionRect} with non-negative `width`/`height`.
 */
export function normalizeSelectionRect(start: Point, end: Point): SelectionRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  return { x, y, width, height };
}
