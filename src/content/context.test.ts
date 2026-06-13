// Property-based test for Options_Panel context precedence (task 10.2).
//
// Exercises the PURE `pickContext({ hasSelection, isImage, isVideo })` exported
// from ./context.ts. The precedence rule (design / Req 2.1–2.5) is fixed:
//
//   non-empty selection → "selected-text"  (wins over everything, Req 2.4)
//   else image          → "image"          (Req 2.2)
//   else video          → "video"          (Req 2.3)
//   else                → "generic-page"   (Req 2.5)
//
// We sweep every one of the 8 boolean combinations exhaustively (unit-style)
// and also property-test across fast-check-generated flag bags at min 100 runs
// to assert the precedence ordering holds regardless of the other flags.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { pickContext, type ContextFlags, type ContextType } from "./context";

/** Reference implementation of the precedence rule, independent of the SUT. */
function expectedContext(flags: ContextFlags): ContextType {
  if (flags.hasSelection) return "selected-text";
  if (flags.isImage) return "image";
  if (flags.isVideo) return "video";
  return "generic-page";
}

const boolArb = fc.boolean();
const flagsArb: fc.Arbitrary<ContextFlags> = fc.record({
  hasSelection: boolArb,
  isImage: boolArb,
  isVideo: boolArb,
});

describe("Property 1: Context resolution honors precedence", () => {
  // Feature: alpha-cursor-extension, Property 1: Context resolution honors precedence
  // Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5
  it("resolves the highest-precedence applicable context for any flag combination", () => {
    fc.assert(
      fc.property(flagsArb, (flags) => {
        const result = pickContext(flags);

        // selection wins over everything (Req 2.4)
        if (flags.hasSelection) {
          expect(result).toBe("selected-text");
          return;
        }
        // else image beats video + generic (Req 2.2)
        if (flags.isImage) {
          expect(result).toBe("image");
          return;
        }
        // else video beats generic (Req 2.3)
        if (flags.isVideo) {
          expect(result).toBe("video");
          return;
        }
        // else generic-page fallback (Req 2.5)
        expect(result).toBe("generic-page");
      }),
      { numRuns: 100 },
    );
  });

  // Feature: alpha-cursor-extension, Property 1: Context resolution honors precedence
  // Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5
  it("matches the reference precedence implementation for any flags", () => {
    fc.assert(
      fc.property(flagsArb, (flags) => {
        expect(pickContext(flags)).toBe(expectedContext(flags));
      }),
      { numRuns: 100 },
    );
  });

  // Exhaustive unit sweep over all 8 boolean combinations (edge coverage).
  const combos: ReadonlyArray<[ContextFlags, ContextType]> = [
    [{ hasSelection: false, isImage: false, isVideo: false }, "generic-page"],
    [{ hasSelection: false, isImage: false, isVideo: true }, "video"],
    [{ hasSelection: false, isImage: true, isVideo: false }, "image"],
    [{ hasSelection: false, isImage: true, isVideo: true }, "image"],
    [{ hasSelection: true, isImage: false, isVideo: false }, "selected-text"],
    [{ hasSelection: true, isImage: false, isVideo: true }, "selected-text"],
    [{ hasSelection: true, isImage: true, isVideo: false }, "selected-text"],
    [{ hasSelection: true, isImage: true, isVideo: true }, "selected-text"],
  ];

  it.each(combos)("pickContext(%o) === %s", (flags, expected) => {
    expect(pickContext(flags)).toBe(expected);
  });
});
