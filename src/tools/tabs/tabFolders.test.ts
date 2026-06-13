// Property test for Tool 3 (Restore Saved Tabs, Req 8) URL partitioning.
//
// Exercises the pure helpers `partitionOpenableUrls` / `isOpenableUrl` from
// ./tabFolders against fast-check-generated inputs that deliberately mix:
//   * valid http/https URLs (fc.webUrl)
//   * arbitrary/malformed strings (fc.string)
//   * empty / whitespace-only strings
//   * valid-but-non-openable schemes (javascript:, data:, about:, chrome:, file:, blob:)
//
// Property 9 asserts the partition is COMPLETE (covers every input), DISJOINT
// (each input lands in exactly one bucket), CLASSIFIES CORRECTLY (openable iff
// http/https-parseable), and is ORDER-PRESERVING within each bucket.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  isOpenableUrl,
  partitionOpenableUrls,
} from "./tabFolders";

// Concrete non-web-scheme strings: each parses via `new URL(...)` but its
// protocol is NOT http/https, so it must always be classified as invalid.
const NON_WEB_SCHEME_URLS = [
  "javascript:alert(1)",
  "data:text/plain,hello",
  "about:blank",
  "about:config",
  "chrome://settings",
  "chrome://extensions",
  "file:///etc/hosts",
  "file:///C:/Windows/system32",
  "blob:https://example.com/550e8400-e29b",
  "ftp://example.com/file.txt",
  "mailto:someone@example.com",
  "tel:+15551234567",
];

const nonWebSchemeArb = fc.constantFrom(...NON_WEB_SCHEME_URLS);

// Empty / whitespace-only strings — always invalid (Req 8.4 no-openable case).
const blankArb = fc.constantFrom("", "   ", "\t", "\n", "  \t  ");

// A single mixed entry: a real http/https URL, an arbitrary string, a blank, or
// a known non-web-scheme URL. fc.webUrl() yields valid http/https URLs.
const mixedUrlArb = fc.oneof(
  fc.webUrl(),
  fc.string(),
  blankArb,
  nonWebSchemeArb,
);

const urlsArb = fc.array(mixedUrlArb, { maxLength: 40 });

// Feature: alpha-cursor-extension, Property 9: URL partition is complete and disjoint
describe("partitionOpenableUrls (Property 9)", () => {
  // Validates: Requirements 8.3, 8.4, 8.5
  it("partitions any mix of URLs completely, disjointly, correctly, and in order", () => {
    fc.assert(
      fc.property(urlsArb, (urls) => {
        const { openable, invalid } = partitionOpenableUrls(urls);

        // COMPLETE: every input lands in some bucket — total count is preserved.
        expect(openable.length + invalid.length).toBe(urls.length);

        // CORRECT classification: openable iff http/https-parseable.
        for (const url of openable) {
          expect(isOpenableUrl(url)).toBe(true);
        }
        for (const url of invalid) {
          expect(isOpenableUrl(url)).toBe(false);
        }

        // ORDER-PRESERVING + DISJOINT (by construction): rebuilding the input
        // by walking each entry through the same predicate must reproduce both
        // buckets exactly, in input order. This simultaneously proves no
        // element was dropped, duplicated, or placed in the wrong bucket.
        const expectedOpenable: string[] = [];
        const expectedInvalid: string[] = [];
        for (const url of urls) {
          if (isOpenableUrl(url)) {
            expectedOpenable.push(url);
          } else {
            expectedInvalid.push(url);
          }
        }
        expect(openable).toEqual(expectedOpenable);
        expect(invalid).toEqual(expectedInvalid);
      }),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 8.3, 8.4 — known classifications are stable.
  it("always classifies generated http/https as openable and non-web schemes/blanks as invalid", () => {
    fc.assert(
      fc.property(
        fc.webUrl(),
        nonWebSchemeArb,
        blankArb,
        (webUrl, nonWeb, blank) => {
          const { openable, invalid } = partitionOpenableUrls([
            webUrl,
            nonWeb,
            blank,
          ]);
          expect(openable).toContain(webUrl);
          expect(invalid).toContain(nonWeb);
          expect(invalid).toContain(blank);
        },
      ),
      { numRuns: 100 },
    );
  });
});
