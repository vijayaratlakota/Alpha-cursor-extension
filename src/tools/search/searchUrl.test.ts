// Property-based + unit tests for the Search URL builder (task 16.2).
//
// Exercises the PURE `buildSearchUrl(template, selection)` exported from
// ./searchUrl.ts:
//   - Property 14 (task 16.2): the selection is URL-encoded into the `{q}`
//     placeholder so that decoding the produced URL's `q` parameter recovers the
//     original selection exactly — including spaces, `&`, `=`, `?`, `#`, `%`,
//     and Unicode (Req 12.2, 12.3). Every `{q}` occurrence is replaced.
//
// Runs with fast-check at min 100 runs ({ numRuns: 100 }) plus explicit unit
// examples for the tricky characters.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { QUERY_PLACEHOLDER, buildSearchUrl } from "./searchUrl";

/** A query template with a single `{q}` placeholder. */
const SINGLE_TEMPLATE = "https://example.com/s?q={q}";

/**
 * Arbitrary selections that include the "interesting" characters the encoder
 * must round-trip, mixed in with arbitrary unicode strings.
 */
const selectionArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.fullUnicodeString(),
  // Strings biased toward URL-significant characters.
  fc
    .array(fc.constantFrom("a", " ", "&", "=", "?", "#", "%", "/", "+", "é", "𝟙"))
    .map((parts) => parts.join("")),
);

describe("Property 14: Search URL encodes and round-trips the selection", () => {
  // Feature: alpha-cursor-extension, Property 14: Search URL encodes and round-trips the selection
  // Validates: Requirements 12.2, 12.3
  it("round-trips the selection via the URL's q parameter for any input", () => {
    fc.assert(
      fc.property(selectionArb, (selection) => {
        const url = buildSearchUrl(SINGLE_TEMPLATE, selection);
        const q = new URL(url).searchParams.get("q");
        // URLSearchParams already percent-decodes the value.
        expect(q).toBe(selection);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: alpha-cursor-extension, Property 14: Search URL encodes and round-trips the selection
  // Validates: Requirements 12.2, 12.3
  it("encodes the selection so decodeURIComponent recovers it exactly", () => {
    fc.assert(
      fc.property(selectionArb, (selection) => {
        const url = buildSearchUrl(SINGLE_TEMPLATE, selection);
        const prefix = "https://example.com/s?q=";
        expect(url.startsWith(prefix)).toBe(true);
        const encoded = url.slice(prefix.length);
        expect(decodeURIComponent(encoded)).toBe(selection);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: alpha-cursor-extension, Property 14: Search URL encodes and round-trips the selection
  // Validates: Requirements 12.2, 12.3
  it("replaces every {q} occurrence with the same encoded selection", () => {
    // Build templates with 1..4 placeholders and verify all are substituted.
    const multiTemplateArb = fc
      .integer({ min: 1, max: 4 })
      .map((count) => ({
        count,
        template: `https://example.com/${Array.from(
          { length: count },
          () => QUERY_PLACEHOLDER,
        ).join("/")}`,
      }));

    fc.assert(
      fc.property(multiTemplateArb, selectionArb, ({ count, template }, selection) => {
        const url = buildSearchUrl(template, selection);
        // No placeholder remains.
        expect(url.includes(QUERY_PLACEHOLDER)).toBe(false);
        // The encoded selection appears exactly `count` times.
        const encoded = encodeURIComponent(selection);
        const segments = url.slice("https://example.com/".length).split("/");
        expect(segments).toHaveLength(count);
        for (const segment of segments) {
          expect(segment).toBe(encoded);
          expect(decodeURIComponent(segment)).toBe(selection);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Explicit edge-case unit sweep over the URL-significant characters.
  it("handles the documented tricky characters", () => {
    const cases = [
      "hello world",
      "a & b",
      "x=y",
      "what?",
      "section#1",
      "100%",
      "café ☕ 𝟙",
      "",
      "a+b/c",
    ];
    for (const selection of cases) {
      const url = buildSearchUrl(SINGLE_TEMPLATE, selection);
      expect(new URL(url).searchParams.get("q")).toBe(selection);
    }
  });
});
