// Feature: alpha-cursor-extension, Property 11: Image conversion preserves dimensions and maps mime correctly
//
// Property-based tests (fast-check + Vitest, min 100 runs) for the PURE Tool 5
// Save-Image helpers in ./format.ts. These validate, over arbitrary inputs:
//   - formatToMime maps each ImageFormat to the correct MIME type (Req 10.2/10.3).
//   - chooseEncoder routes each format through the right pipeline ("canvas" for
//     png/jpg, "jspdf" for pdf), exposes the matching mime, and gives jpg a
//     quality in [0, 1].
//   - preservesDimensions(w, h, 1) returns the source dimensions unchanged
//     (dimensions preserved at scale 1, Req 10.2/10.4) and, for arbitrary
//     scale > 0, returns rounded scaled dimensions with aspect ratio preserved
//     within rounding (Req 10.3).
//
// Validates: Requirements 10.2, 10.3, 10.4

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  chooseEncoder,
  formatToExtension,
  formatToMime,
  preservesDimensions,
  type ImageFormat,
} from "./format";

const RUNS = { numRuns: 100 } as const;

/** Generator over the full ImageFormat union. */
const formatArb: fc.Arbitrary<ImageFormat> = fc.constantFrom<ImageFormat>(
  "png",
  "jpg",
  "pdf",
);

/** Expected MIME / extension / encoder pipeline for each format. */
const EXPECTED: Record<
  ImageFormat,
  { mime: string; ext: string; via: "canvas" | "jspdf" }
> = {
  png: { mime: "image/png", ext: "png", via: "canvas" },
  jpg: { mime: "image/jpeg", ext: "jpg", via: "canvas" },
  pdf: { mime: "application/pdf", ext: "pdf", via: "jspdf" },
};

describe("Property 11: Image conversion preserves dimensions and maps mime correctly", () => {
  // --- MIME mapping (Req 10.2, 10.3) ----------------------------------------

  it("formatToMime maps every format to its correct MIME type", () => {
    fc.assert(
      fc.property(formatArb, (format) => {
        expect(formatToMime(format)).toBe(EXPECTED[format].mime);
      }),
      RUNS,
    );
  });

  it("formatToExtension maps every format to its correct extension", () => {
    fc.assert(
      fc.property(formatArb, (format) => {
        expect(formatToExtension(format)).toBe(EXPECTED[format].ext);
      }),
      RUNS,
    );
  });

  // --- Encoder selection (Req 10.2, 10.3) -----------------------------------

  it("chooseEncoder routes each format through the correct pipeline + mime", () => {
    fc.assert(
      fc.property(formatArb, (format) => {
        const descriptor = chooseEncoder(format);
        expect(descriptor.via).toBe(EXPECTED[format].via);
        expect(descriptor.mime).toBe(EXPECTED[format].mime);
        expect(descriptor.mime).toBe(formatToMime(format));
      }),
      RUNS,
    );
  });

  it("chooseEncoder gives jpg a quality in [0, 1] (and clamps overrides)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -10, max: 10, noNaN: true }),
        (rawQuality) => {
          const descriptor = chooseEncoder("jpg", rawQuality);
          expect(descriptor.quality).toBeDefined();
          expect(descriptor.quality!).toBeGreaterThanOrEqual(0);
          expect(descriptor.quality!).toBeLessThanOrEqual(1);
        },
      ),
      RUNS,
    );
  });

  it("chooseEncoder omits quality for the lossless/non-toBlob formats (png, pdf)", () => {
    fc.assert(
      fc.property(fc.constantFrom<ImageFormat>("png", "pdf"), (format) => {
        const descriptor = chooseEncoder(format);
        expect(descriptor.quality).toBeUndefined();
      }),
      RUNS,
    );
  });

  // --- Dimension preservation (Req 10.2, 10.4) ------------------------------

  it("preservesDimensions(w, h, 1) returns the source dimensions exactly", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100000 }),
        fc.nat({ max: 100000 }),
        (srcW, srcH) => {
          expect(preservesDimensions(srcW, srcH, 1)).toEqual({
            width: srcW,
            height: srcH,
          });
        },
      ),
      RUNS,
    );
  });

  it("preservesDimensions defaults to scale 1 (dimensions preserved)", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100000 }),
        fc.nat({ max: 100000 }),
        (srcW, srcH) => {
          expect(preservesDimensions(srcW, srcH)).toEqual({
            width: srcW,
            height: srcH,
          });
        },
      ),
      RUNS,
    );
  });

  // --- Scaled conversion (Req 10.3) -----------------------------------------

  it("preservesDimensions(w, h, scale) rounds w*scale / h*scale for scale > 0", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100000 }),
        fc.nat({ max: 100000 }),
        // Strictly-positive finite scale factor.
        fc.double({ min: 0.01, max: 8, noNaN: true, noDefaultInfinity: true }),
        (srcW, srcH, scale) => {
          expect(preservesDimensions(srcW, srcH, scale)).toEqual({
            width: Math.round(srcW * scale),
            height: Math.round(srcH * scale),
          });
        },
      ),
      RUNS,
    );
  });

  it("preservesDimensions keeps aspect ratio under uniform scaling (within rounding)", () => {
    fc.assert(
      fc.property(
        // Use non-zero dimensions so the source aspect ratio is well-defined.
        fc.integer({ min: 1, max: 100000 }),
        fc.integer({ min: 1, max: 100000 }),
        fc.double({ min: 0.01, max: 8, noNaN: true, noDefaultInfinity: true }),
        (srcW, srcH, scale) => {
          const out = preservesDimensions(srcW, srcH, scale);
          // Both axes scaled by the same factor; output is integral. The
          // cross-multiplied aspect ratio difference is bounded by the
          // half-pixel rounding error introduced on each independent axis.
          const sourceRatio = srcW / srcH;
          // Guard the degenerate case where rounding collapsed a tiny axis to 0.
          if (out.height === 0) {
            expect(out.width).toBeGreaterThanOrEqual(0);
            return;
          }
          const outRatio = out.width / out.height;
          // Tolerance: one whole pixel of error on the numerator relative to
          // the (rounded) denominator covers the worst-case ±0.5px on each axis.
          const tolerance = 1 / out.height + sourceRatio / out.height;
          expect(Math.abs(outRatio - sourceRatio)).toBeLessThanOrEqual(
            tolerance + 1e-9,
          );
        },
      ),
      RUNS,
    );
  });
});
