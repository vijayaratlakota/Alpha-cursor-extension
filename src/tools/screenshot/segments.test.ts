// Property test for Tool 4 (Full Page Screenshot, Req 9.2/9.3) segmentation math.
//
// Exercises the pure helper `computeSegments` (with `composedHeightPx` and
// `effectiveDpr`) from ./segments against fast-check-generated page/viewport/dpr
// triples covering: pages taller than the viewport (multi-segment), exact
// viewport multiples (zero remainder), arbitrary remainders, and the
// single-segment case (totalHeight <= viewportHeight).
//
// Property 10 asserts the segments' destination rectangles TILE [0, totalHeight]
// with no gaps and no overlap, the source heights SUM to totalHeight, and the
// composed device-pixel height equals totalHeight * effectiveDpr.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  computeSegments,
  composedHeightPx,
  effectiveDpr,
  type ScreenshotSegment,
} from "./segments";

// Reasonable CSS-pixel ranges for page height, viewport height, and dpr. The
// implementation uses exact arithmetic, so integer inputs keep tolerances tight
// while still spanning multi-segment, exact-multiple, and remainder shapes.
const totalHeightArb = fc.integer({ min: 1, max: 50_000 });
const viewportHeightArb = fc.integer({ min: 1, max: 4_000 });
const dprArb = fc.constantFrom(1, 1.25, 1.5, 2, 2.5, 3);

// Feature: alpha-cursor-extension, Property 10: Screenshot segmentation fully covers the page
describe("computeSegments (Property 10)", () => {
  // Validates: Requirements 9.2, 9.3
  it("tiles [0, totalHeight] with no gaps or overlap and sums source heights to totalHeight", () => {
    fc.assert(
      fc.property(
        totalHeightArb,
        viewportHeightArb,
        dprArb,
        (totalHeight, viewportHeight, dpr) => {
          const segments = computeSegments(totalHeight, viewportHeight, dpr);

          // Positive inputs always yield at least one segment.
          expect(segments.length).toBeGreaterThanOrEqual(1);

          // Sort a copy by destY to reason about coverage independent of order.
          const sorted = [...segments].sort((a, b) => a.destY - b.destY);

          // First destination rectangle starts at the top of the page.
          const first = sorted[0]!;
          expect(first.destY).toBe(0);

          // Adjacent rectangles meet exactly: no gap, no overlap.
          for (let i = 0; i < sorted.length - 1; i++) {
            const cur = sorted[i]!;
            const next = sorted[i + 1]!;
            expect(cur.destY + cur.sourceHeight).toBe(next.destY);
          }

          // Last rectangle ends exactly at totalHeight.
          const last = sorted[sorted.length - 1]!;
          expect(last.destY + last.sourceHeight).toBe(totalHeight);

          // Sum of source heights covers the whole page.
          const sourceSum = segments.reduce(
            (acc, s) => acc + s.sourceHeight,
            0,
          );
          expect(sourceSum).toBe(totalHeight);

          // Composed device-pixel height equals totalHeight * effectiveDpr.
          expect(composedHeightPx(totalHeight, dpr)).toBe(
            totalHeight * effectiveDpr(dpr),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 9.2 — single-segment case is well-defined.
  it("returns a single segment covering [0, totalHeight] when the page fits in the viewport", () => {
    fc.assert(
      fc.property(
        totalHeightArb,
        viewportHeightArb,
        dprArb,
        (totalHeight, viewportHeight, dpr) => {
          // Constrain to the fits-in-viewport case (totalHeight <= viewportHeight).
          fc.pre(totalHeight <= viewportHeight);

          const segments = computeSegments(totalHeight, viewportHeight, dpr);
          expect(segments).toHaveLength(1);
          const only = segments[0]!;
          expect(only.index).toBe(0);
          expect(only.scrollY).toBe(0);
          expect(only.sourceY).toBe(0);
          expect(only.destY).toBe(0);
          expect(only.sourceHeight).toBe(totalHeight);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 9.2 — degenerate inputs capture nothing.
  it("returns [] for zero/negative/non-finite totalHeight or viewportHeight", () => {
    const badArb = fc.constantFrom(
      0,
      -1,
      -1000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    );
    fc.assert(
      fc.property(
        fc.oneof(badArb, totalHeightArb),
        fc.oneof(badArb, viewportHeightArb),
        dprArb,
        (totalHeight, viewportHeight, dpr) => {
          const totalOk = Number.isFinite(totalHeight) && totalHeight > 0;
          const viewportOk =
            Number.isFinite(viewportHeight) && viewportHeight > 0;
          const segments: ScreenshotSegment[] = computeSegments(
            totalHeight,
            viewportHeight,
            dpr,
          );
          if (!totalOk || !viewportOk) {
            expect(segments).toEqual([]);
          } else {
            expect(segments.length).toBeGreaterThanOrEqual(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
