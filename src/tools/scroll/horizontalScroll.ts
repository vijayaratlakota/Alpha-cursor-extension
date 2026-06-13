/**
 * Alpha Cursor — Horizontal Scroll pure helper (task 22.1).
 *
 * A single PURE, side-effect-free function backing Tool — Horizontal Scroll
 * (Req 18). It translates a mouse-wheel event's vertical/horizontal deltas into
 * a single horizontal scroll delta to apply to the targeted scrollable element
 * (Req 18.2, 18.3).
 *
 * The wheel-event listener and the active-mode toggle/indicator are wired in
 * task 22.3; this module owns ONLY the delta math so it can be property-tested
 * in isolation (Property 18 in task 22.2). It never touches `chrome.*`, the
 * DOM, or any other ambient state.
 */

/**
 * Map a mouse-wheel event's deltas into a single horizontal scroll delta.
 *
 * **Mapping rule (Property 18 — preserves magnitude and direction):**
 *
 *  - If the user is already scrolling horizontally — i.e. the horizontal
 *    intent dominates, `Math.abs(deltaX) >= Math.abs(deltaY)` — the native
 *    horizontal delta is preserved and `deltaX` is returned unchanged.
 *  - Otherwise the vertical wheel intent dominates, so it is mapped onto the
 *    horizontal axis by returning `deltaY` unchanged.
 *
 * In both branches the returned value is exactly one of the two input deltas,
 * so its magnitude (`Math.abs`) equals the chosen source delta's magnitude and
 * its sign/direction is preserved (a downward/positive `deltaY` produces a
 * positive — rightward — horizontal delta; an upward/negative `deltaY`
 * produces a negative — leftward — one).
 *
 * The tie case (`Math.abs(deltaX) === Math.abs(deltaY)`) resolves to the
 * horizontal branch and returns `deltaX`, keeping the rule deterministic.
 *
 * Non-finite inputs (`NaN`, `±Infinity`) are normalized to `0` so the function
 * always returns a finite number safe to pass to `scrollBy`/`scrollLeft`.
 *
 * @param deltaY The vertical wheel delta (e.g. `WheelEvent.deltaY`). Positive is down.
 * @param deltaX The horizontal wheel delta (e.g. `WheelEvent.deltaX`). Positive is right.
 * @returns The horizontal scroll delta to apply; equal in magnitude and
 *   direction to the dominant input delta.
 */
export function wheelToHorizontalDelta(deltaY: number, deltaX: number): number {
  const y = Number.isFinite(deltaY) ? deltaY : 0;
  const x = Number.isFinite(deltaX) ? deltaX : 0;

  // Native horizontal intent dominates (including the tie) → preserve deltaX.
  if (Math.abs(x) >= Math.abs(y)) {
    return x;
  }

  // Vertical wheel intent dominates → map it onto the horizontal axis.
  return y;
}
