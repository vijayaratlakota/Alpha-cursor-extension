// Property-based + unit tests for the Notepad separator helpers (tasks 11.2, 11.3).
//
// Exercises the PURE helpers exported from ./separator.ts:
//   - Property 6 (task 11.2): `resolveSeparator(raw)` always yields a valid,
//     non-empty separator, defaulting to "," (DEFAULT_SEPARATOR) on any
//     missing / invalid / corrupted input (Req 5.5).
//   - Property 7 (task 11.3): `joinEntries(entries, separator)` inserts the
//     separator ONLY between consecutive entries — equal to entries.join(sep),
//     order preserved, exactly max(0, n-1) separators, empty array → "" (Req 5.6, 6.2).
//
// Both run with fast-check at min 100 runs ({ numRuns: 100 }), alongside a few
// explicit unit examples for edge coverage.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  DEFAULT_SEPARATOR,
  joinEntries,
  resolveSeparator,
} from "./separator";
import type { SeparatorConfig } from "../../shared/settings";

// ---------------------------------------------------------------------------
// Property 6 — Separator resolution always yields a valid separator
// ---------------------------------------------------------------------------

/** The preset kinds and their expected literal separators. */
const PRESET_EXPECTED: Record<"comma" | "dash" | "slash", string> = {
  comma: ",",
  dash: "-",
  slash: "/",
};

/** Well-formed SeparatorConfig objects across all kinds. */
const validConfigArb: fc.Arbitrary<SeparatorConfig> = fc.oneof(
  fc.constant<SeparatorConfig>({ kind: "comma" }),
  fc.constant<SeparatorConfig>({ kind: "dash" }),
  fc.constant<SeparatorConfig>({ kind: "slash" }),
  // custom with a non-empty value
  fc
    .string({ minLength: 1, maxLength: 8 })
    .map<SeparatorConfig>((custom) => ({ kind: "custom", custom })),
  // custom with an empty / missing value → should fall back to default
  fc.constant<SeparatorConfig>({ kind: "custom", custom: "" }),
  fc.constant<SeparatorConfig>({ kind: "custom" }),
);

/** Plain strings: kind names, "custom", literals, and the empty string. */
const stringArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom("comma", "dash", "slash", "custom", ""),
  fc.string(),
);

/** Malformed / corrupted values: numbers, bad objects, empty objects, etc. */
const malformedArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant({}),
  fc.record({ kind: fc.constantFrom("bogus", "COMMA", "", "comma ") }),
  fc.record({ custom: fc.string() }), // object with no/invalid kind
  fc.constant({ kind: 42 }),
  fc.constant({ kind: null }),
  fc.array(fc.string()),
);

/** Anything resolveSeparator may receive at runtime. */
const rawArb: fc.Arbitrary<unknown> = fc.oneof(
  validConfigArb,
  stringArb,
  fc.constant(null),
  fc.constant(undefined),
  malformedArb,
);

/** Reference implementation, independent of the SUT, for the expected result. */
function expectedSeparator(raw: unknown): string {
  if (raw == null) return DEFAULT_SEPARATOR;
  if (typeof raw === "string") {
    if (raw === "comma" || raw === "dash" || raw === "slash") {
      return PRESET_EXPECTED[raw];
    }
    if (raw === "custom") return DEFAULT_SEPARATOR;
    return raw.length > 0 ? raw : DEFAULT_SEPARATOR;
  }
  if (typeof raw === "object") {
    const kind = (raw as Partial<SeparatorConfig>).kind;
    if (kind === "custom") {
      const custom = (raw as Partial<SeparatorConfig>).custom;
      return typeof custom === "string" && custom.length > 0
        ? custom
        : DEFAULT_SEPARATOR;
    }
    if (kind === "comma" || kind === "dash" || kind === "slash") {
      return PRESET_EXPECTED[kind];
    }
    return DEFAULT_SEPARATOR;
  }
  return DEFAULT_SEPARATOR;
}

describe("Property 6: Separator resolution always yields a valid separator", () => {
  // Feature: alpha-cursor-extension, Property 6: Separator resolution always yields a valid separator
  // Validates: Requirements 5.5
  it("always returns a non-empty string for any raw input", () => {
    fc.assert(
      fc.property(rawArb, (raw) => {
        const result = resolveSeparator(
          raw as SeparatorConfig | string | null | undefined,
        );
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: alpha-cursor-extension, Property 6: Separator resolution always yields a valid separator
  // Validates: Requirements 5.5
  it("matches the reference resolution and defaults to ',' on missing/invalid/corrupted input", () => {
    fc.assert(
      fc.property(rawArb, (raw) => {
        expect(
          resolveSeparator(
            raw as SeparatorConfig | string | null | undefined,
          ),
        ).toBe(expectedSeparator(raw));
      }),
      { numRuns: 100 },
    );
  });

  // Feature: alpha-cursor-extension, Property 6: Separator resolution always yields a valid separator
  // Validates: Requirements 5.5
  it("maps each preset kind to its literal separator", () => {
    fc.assert(
      fc.property(fc.constantFrom("comma", "dash", "slash"), (kind) => {
        const k = kind as "comma" | "dash" | "slash";
        expect(resolveSeparator({ kind: k })).toBe(PRESET_EXPECTED[k]);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: alpha-cursor-extension, Property 6: Separator resolution always yields a valid separator
  // Validates: Requirements 5.5
  it("uses a non-empty custom value, falling back to ',' when custom is empty", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), (custom) => {
        const result = resolveSeparator({ kind: "custom", custom });
        if (custom.length > 0) {
          expect(result).toBe(custom);
        } else {
          expect(result).toBe(DEFAULT_SEPARATOR);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Explicit edge-case unit sweep.
  it("handles the documented edge cases", () => {
    expect(DEFAULT_SEPARATOR).toBe(",");
    expect(resolveSeparator(null)).toBe(",");
    expect(resolveSeparator(undefined)).toBe(",");
    expect(resolveSeparator({ kind: "comma" })).toBe(",");
    expect(resolveSeparator({ kind: "dash" })).toBe("-");
    expect(resolveSeparator({ kind: "slash" })).toBe("/");
    expect(resolveSeparator({ kind: "custom", custom: "::" })).toBe("::");
    expect(resolveSeparator({ kind: "custom", custom: "" })).toBe(",");
    expect(resolveSeparator({ kind: "custom" })).toBe(",");
    // Malformed / corrupted inputs.
    expect(resolveSeparator({} as unknown as SeparatorConfig)).toBe(",");
    expect(
      resolveSeparator({ kind: "bogus" } as unknown as SeparatorConfig),
    ).toBe(",");
    expect(resolveSeparator(42 as unknown as string)).toBe(",");
    expect(resolveSeparator("" as unknown as string)).toBe(",");
    // Plain kind-name strings and literals.
    expect(resolveSeparator("comma")).toBe(",");
    expect(resolveSeparator("dash")).toBe("-");
    expect(resolveSeparator("slash")).toBe("/");
    expect(resolveSeparator("custom")).toBe(",");
    expect(resolveSeparator(" | ")).toBe(" | ");
  });
});

// ---------------------------------------------------------------------------
// Property 7 — Join inserts the separator only between consecutive entries
// ---------------------------------------------------------------------------

/** Count non-overlapping occurrences of `needle` (non-empty) in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

describe("Property 7: Join inserts the separator only between consecutive entries", () => {
  // Feature: alpha-cursor-extension, Property 7: Join inserts the separator only between consecutive entries
  // Validates: Requirements 5.6, 6.2
  it("equals entries.join(separator) for any entries and separator", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.string(), (entries, separator) => {
        expect(joinEntries(entries, separator)).toBe(entries.join(separator));
      }),
      { numRuns: 100 },
    );
  });

  // Feature: alpha-cursor-extension, Property 7: Join inserts the separator only between consecutive entries
  // Validates: Requirements 5.6, 6.2
  it("inserts exactly max(0, n-1) separators when the separator is absent from every entry", () => {
    // Generate a non-empty separator and entries guaranteed not to contain it,
    // so occurrence counting is unambiguous.
    const sepAndEntriesArb = fc
      .string({ minLength: 1, maxLength: 3 })
      .chain((separator) => {
        const entryArb = fc
          .string({ maxLength: 12 })
          .filter((entry) => !entry.includes(separator));
        return fc.tuple(
          fc.constant(separator),
          fc.array(entryArb, { maxLength: 10 }),
        );
      });

    fc.assert(
      fc.property(sepAndEntriesArb, ([separator, entries]) => {
        const joined = joinEntries(entries, separator);
        const expectedCount = Math.max(0, entries.length - 1);
        expect(countOccurrences(joined, separator)).toBe(expectedCount);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: alpha-cursor-extension, Property 7: Join inserts the separator only between consecutive entries
  // Validates: Requirements 5.6, 6.2
  it("preserves entry order and yields '' for the empty array", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.string(), (entries, separator) => {
        const joined = joinEntries(entries, separator);
        if (entries.length === 0) {
          expect(joined).toBe("");
          return;
        }
        // Splitting back on a separator not present in any entry recovers order.
        // (Use the reference join equality, which already encodes order.)
        expect(joined).toBe(entries.join(separator));
      }),
      { numRuns: 100 },
    );
  });

  // Explicit edge-case unit sweep.
  it("handles the documented edge cases", () => {
    expect(joinEntries([], ",")).toBe("");
    expect(joinEntries(["only"], ",")).toBe("only");
    expect(joinEntries(["a", "b", "c"], ",")).toBe("a,b,c");
    expect(joinEntries(["a", "b", "c"], "-")).toBe("a-b-c");
    expect(joinEntries(["a", "b"], "")).toBe("ab");
    expect(joinEntries(["", ""], ",")).toBe(",");
  });
});
