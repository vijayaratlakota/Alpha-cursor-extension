// Feature: alpha-cursor-extension, Property 16: Color formatting is paste-ready and round-trips
//
// Property-based tests (fast-check + Vitest, min 100 runs) for the PURE Tool 9
// Color Picker helpers in ./color.ts. These validate, over arbitrary integer
// RGB triples in 0–255:
//   - rgbToHex produces a paste-ready lowercase `#rrggbb` token (Req 14.7).
//   - hexToRgb is an exact inverse of rgbToHex (round-trip { r, g, b }).
//   - formatColor on an { r, g, b } object equals rgbToHex(r, g, b).
//   - formatColor on the produced hex string round-trips to the same token.
//
// Validates: Requirements 14.7

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { formatColor, hexToRgb, rgbToHex, type Rgb } from "./color";

const RUNS = { numRuns: 100 } as const;

/** A 0–255 channel generator. */
const channelArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 255 });

/** An { r, g, b } triple with each channel in 0–255. */
const rgbArb: fc.Arbitrary<Rgb> = fc.record({
  r: channelArb,
  g: channelArb,
  b: channelArb,
});

/** Paste-ready token shape: a leading `#` plus six lowercase hex digits. */
const PASTE_READY = /^#[0-9a-f]{6}$/;

describe("Property 16: Color formatting is paste-ready and round-trips", () => {
  it("rgbToHex produces a paste-ready lowercase #rrggbb token", () => {
    fc.assert(
      fc.property(channelArb, channelArb, channelArb, (r, g, b) => {
        expect(rgbToHex(r, g, b)).toMatch(PASTE_READY);
      }),
      RUNS,
    );
  });

  it("hexToRgb(rgbToHex(r, g, b)) === { r, g, b } (exact round-trip)", () => {
    fc.assert(
      fc.property(channelArb, channelArb, channelArb, (r, g, b) => {
        expect(hexToRgb(rgbToHex(r, g, b))).toEqual({ r, g, b });
      }),
      RUNS,
    );
  });

  it("formatColor({ r, g, b }) === rgbToHex(r, g, b)", () => {
    fc.assert(
      fc.property(rgbArb, ({ r, g, b }) => {
        expect(formatColor({ r, g, b })).toBe(rgbToHex(r, g, b));
      }),
      RUNS,
    );
  });

  it("formatColor on the produced hex string round-trips to the same token", () => {
    fc.assert(
      fc.property(channelArb, channelArb, channelArb, (r, g, b) => {
        const hex = rgbToHex(r, g, b);
        // Feeding the paste-ready token back through formatColor is idempotent.
        expect(formatColor(hex)).toBe(hex);
        // And it still matches the paste-ready shape after the round-trip.
        expect(formatColor(hex)).toMatch(PASTE_READY);
      }),
      RUNS,
    );
  });
});
