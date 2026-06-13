// Feature: alpha-cursor-extension, Property 17: Selection rectangle normalization
//
// Property-based tests (fast-check + Vitest) for the OCR drag-selection
// geometry helper backing Tool 10 (OCR Text Extraction).
//
// Validates Requirements 15.2.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { normalizeSelectionRect, type Point } from "./selectionRect";

// Integer points across a wide range, including negatives and zero, so we
// exercise drags in every direction (end above/left of start, equal points).
const pointArb: fc.Arbitrary<Point> = fc.record({
  x: fc.integer({ min: -100_000, max: 100_000 }),
  y: fc.integer({ min: -100_000, max: 100_000 }),
});

describe("normalizeSelectionRect (Property 17 — selection rectangle normalization)", () => {
  // Validates: Requirements 15.2
  it("produces a non-negative, correctly-anchored rect for any drag direction", () => {
    fc.assert(
      fc.property(pointArb, pointArb, (start, end) => {
        const rect = normalizeSelectionRect(start, end);

        // width/height are always non-negative regardless of direction.
        expect(rect.width).toBeGreaterThanOrEqual(0);
        expect(rect.height).toBeGreaterThanOrEqual(0);

        // Top-left corner is the min of the two points on each axis.
        expect(rect.x).toBe(Math.min(start.x, end.x));
        expect(rect.y).toBe(Math.min(start.y, end.y));

        // Extents equal the absolute distance between the points on each axis.
        expect(rect.width).toBe(Math.abs(end.x - start.x));
        expect(rect.height).toBe(Math.abs(end.y - start.y));
      }),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 15.2
  it("bounds the same region regardless of which point is start vs end (commutative)", () => {
    fc.assert(
      fc.property(pointArb, pointArb, (a, b) => {
        expect(normalizeSelectionRect(a, b)).toEqual(normalizeSelectionRect(b, a));
      }),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 15.2
  it("yields a zero-size rect anchored at the point for equal start/end (a click)", () => {
    fc.assert(
      fc.property(pointArb, (p) => {
        const rect = normalizeSelectionRect(p, { ...p });
        expect(rect).toEqual({ x: p.x, y: p.y, width: 0, height: 0 });
      }),
      { numRuns: 100 },
    );
  });
});
