// Feature: alpha-cursor-extension, Property 18: Wheel-to-horizontal mapping
//
// Property-based tests (fast-check + Vitest) for the Horizontal Scroll delta
// helper backing Tool — Horizontal Scroll.
//
// Validates Requirements 18.2, 18.3.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { wheelToHorizontalDelta } from "./horizontalScroll";

// Finite deltas spanning negatives, zeros, and (via the shared pool) ties.
const finiteDeltaArb: fc.Arbitrary<number> = fc.double({
  min: -100_000,
  max: 100_000,
  noNaN: true,
  noDefaultInfinity: true,
});

// Non-finite values that must be normalized to 0.
const nonFiniteArb: fc.Arbitrary<number> = fc.constantFrom(
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
);

/** sign helper that treats -0 and +0 alike (both magnitude 0). */
function sign(n: number): number {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

describe("wheelToHorizontalDelta (Property 18 — wheel-to-horizontal mapping)", () => {
  // Validates: Requirements 18.2, 18.3
  it("returns one of the inputs per the dominance rule, preserving magnitude and sign", () => {
    fc.assert(
      fc.property(finiteDeltaArb, finiteDeltaArb, (deltaY, deltaX) => {
        const result = wheelToHorizontalDelta(deltaY, deltaX);

        // The chosen source is deltaX when horizontal intent dominates (incl. ties).
        const chosen = Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY;

        // Result is exactly one of the two inputs (the dominant source).
        expect(result).toBe(chosen);

        // Magnitude equals the dominant source magnitude.
        expect(Math.abs(result)).toBe(Math.abs(chosen));

        // Direction/sign is preserved from the chosen source.
        expect(sign(result)).toBe(sign(chosen));
      }),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 18.2, 18.3
  it("explicitly resolves ties (|deltaX| === |deltaY|) to deltaX", () => {
    fc.assert(
      fc.property(finiteDeltaArb, fc.boolean(), (mag, flipSign) => {
        const deltaX = mag;
        const deltaY = flipSign ? -mag : mag; // same magnitude as deltaX
        expect(wheelToHorizontalDelta(deltaY, deltaX)).toBe(deltaX);
      }),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 18.2, 18.3
  it("treats non-finite inputs (NaN/±Infinity) as 0", () => {
    fc.assert(
      fc.property(
        fc.oneof(finiteDeltaArb, nonFiniteArb),
        fc.oneof(finiteDeltaArb, nonFiniteArb),
        (deltaY, deltaX) => {
          const result = wheelToHorizontalDelta(deltaY, deltaX);

          // Always finite.
          expect(Number.isFinite(result)).toBe(true);

          // Compute against the normalized inputs.
          const ny = Number.isFinite(deltaY) ? deltaY : 0;
          const nx = Number.isFinite(deltaX) ? deltaX : 0;
          const expected = Math.abs(nx) >= Math.abs(ny) ? nx : ny;
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 18.2, 18.3
  it("returns 0 when both inputs are non-finite", () => {
    fc.assert(
      fc.property(nonFiniteArb, nonFiniteArb, (deltaY, deltaX) => {
        expect(wheelToHorizontalDelta(deltaY, deltaX)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
