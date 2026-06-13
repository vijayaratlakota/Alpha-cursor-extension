// Feature: alpha-cursor-extension, Property 12: Consent removal touches only matching elements
// Feature: alpha-cursor-extension, Property 13: Scroll state restoration round-trips
//
// Property-based tests (fast-check + Vitest, min 100 runs) for the PURE
// cookie-consent helpers backing Tool 6 (Req 11) in ./consent.ts:
//
//   - Property 12 (task 15.2): matchesConsentRule is conservative — it matches
//     known CMP ids, consent vocabulary in id/class, and consent
//     data-attributes (Req 11.1), but NEVER matches arbitrary, benign elements
//     (Req 11.2, 11.5 — no false positives).
//   - Property 13 (task 15.3): captureScrollState / restoreScrollState form an
//     exact round-trip and the apply path writes the restored values onto a
//     target document (Req 11.3).
//
// These run in the project's default jsdom env, so real DOM elements are built
// with document.createElement.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  DEFAULT_CONSENT_RULESET,
  matchesConsentRule,
  captureScrollState,
  restoreScrollState,
  type ConsentRuleset,
  type ScrollState,
} from "./consent";

const RUNS = { numRuns: 100 } as const;

// ---------------------------------------------------------------------------
// Property 12: Consent removal touches only matching elements
// Validates: Requirements 11.1, 11.2, 11.5
// ---------------------------------------------------------------------------

/**
 * Consent vocabulary that MUST NOT appear in a "benign" id/class, per the task.
 * Any generated string containing one of these (case-insensitive) is rejected.
 */
const CONSENT_VOCAB = ["cookie", "consent", "gdpr", "cmp"] as const;

/**
 * Extra reserved tokens drawn from the ruleset that do NOT contain the four
 * vocabulary words above (e.g. vendor ids and CSS class tokens). Filtering
 * these out as well guarantees the property is flake-free: a benign string can
 * never accidentally equal a CMP id or a consent class token.
 */
const RESERVED_TOKENS: readonly string[] = [
  // cmpIds without cookie/consent/gdpr/cmp substrings
  "usercentrics-root",
  "didomi-host",
  "didomi-popup",
  "osano-cm-window",
  "termly-code-snippet-support",
  "sp_message_container",
  // selector class/id tokens without those substrings
  "ot-sdk-container",
  "cc-window",
  "cc-banner",
  "onetrust",
];

/** True when `value` is safe to treat as a non-consent (benign) id/class. */
function isBenign(value: string): boolean {
  const lower = value.toLowerCase();
  if (CONSENT_VOCAB.some((word) => lower.includes(word))) return false;
  if (RESERVED_TOKENS.some((token) => lower.includes(token))) return false;
  return true;
}

/** A handful of ordinary HTML tag names for building benign elements. */
const tagArb = fc.constantFrom(
  "div",
  "span",
  "section",
  "p",
  "a",
  "ul",
  "li",
  "header",
  "footer",
  "nav",
  "article",
  "aside",
  "button",
  "main"
);

/**
 * Benign id/class strings: arbitrary strings with the consent vocabulary (and
 * reserved tokens) filtered out. Length-capped to keep generation fast.
 */
const benignStringArb = fc
  .string({ maxLength: 24 })
  .filter((s) => isBenign(s));

describe("Property 12: Consent removal touches only matching elements", () => {
  // Validates: Requirements 11.2, 11.5
  it("never matches arbitrary benign elements (no false positives)", () => {
    fc.assert(
      fc.property(tagArb, benignStringArb, benignStringArb, (tag, id, cls) => {
        const el = document.createElement(tag);
        if (id !== "") el.id = id;
        if (cls.trim() !== "") el.setAttribute("class", cls);
        expect(matchesConsentRule(el, DEFAULT_CONSENT_RULESET)).toBe(false);
      }),
      RUNS
    );
  });

  // Validates: Requirements 11.1 — known CMP ids are always recognized.
  it("matches any element carrying a known CMP id", () => {
    const cmpIdArb = fc.constantFrom(...DEFAULT_CONSENT_RULESET.cmpIds);
    fc.assert(
      fc.property(tagArb, cmpIdArb, (tag, cmpId) => {
        const el = document.createElement(tag);
        el.id = cmpId;
        expect(matchesConsentRule(el, DEFAULT_CONSENT_RULESET)).toBe(true);
      }),
      RUNS
    );
  });

  // Validates: Requirements 11.1 — consent keyword vocabulary in id or class.
  it("matches elements whose id or class contains a consent keyword pattern", () => {
    const keywordArb = fc.constantFrom(
      ...DEFAULT_CONSENT_RULESET.keywordPatterns
    );
    const affixArb = fc.string({ maxLength: 8 });
    fc.assert(
      fc.property(
        tagArb,
        keywordArb,
        affixArb,
        affixArb,
        fc.boolean(),
        (tag, keyword, prefix, suffix, useClass) => {
          const el = document.createElement(tag);
          const token = `${prefix}${keyword}${suffix}`;
          if (useClass) {
            el.setAttribute("class", token);
          } else {
            el.id = token;
          }
          expect(matchesConsentRule(el, DEFAULT_CONSENT_RULESET)).toBe(true);
        }
      ),
      RUNS
    );
  });

  // Validates: Requirements 11.1 — consent data-attributes signal a banner.
  it("matches elements carrying a consent data-attribute", () => {
    const attrArb = fc.constantFrom(
      ...DEFAULT_CONSENT_RULESET.attributePatterns.map((p) => p.name)
    );
    fc.assert(
      fc.property(tagArb, attrArb, benignStringArb, (tag, attr, value) => {
        const el = document.createElement(tag);
        el.setAttribute(attr, value);
        expect(matchesConsentRule(el, DEFAULT_CONSENT_RULESET)).toBe(true);
      }),
      RUNS
    );
  });

  describe("explicit positive unit cases per match category", () => {
    it("matches a OneTrust banner by CMP id", () => {
      const el = document.createElement("div");
      el.id = "onetrust-banner-sdk";
      expect(matchesConsentRule(el, DEFAULT_CONSENT_RULESET)).toBe(true);
    });

    it("matches a Cookiebot dialog by CMP id", () => {
      const el = document.createElement("div");
      el.id = "CybotCookiebotDialog";
      expect(matchesConsentRule(el, DEFAULT_CONSENT_RULESET)).toBe(true);
    });

    it("matches a full vendor selector (.cc-window)", () => {
      const el = document.createElement("div");
      el.setAttribute("class", "cc-window cc-banner");
      expect(matchesConsentRule(el, DEFAULT_CONSENT_RULESET)).toBe(true);
    });

    it("matches a 'cookie-consent' keyword in class", () => {
      const el = document.createElement("div");
      el.setAttribute("class", "site cookie-consent visible");
      expect(matchesConsentRule(el, DEFAULT_CONSENT_RULESET)).toBe(true);
    });

    it("matches a 'gdpr-consent' keyword in id", () => {
      const el = document.createElement("section");
      el.id = "gdpr-consent-banner";
      expect(matchesConsentRule(el, DEFAULT_CONSENT_RULESET)).toBe(true);
    });

    it("matches a 'consent-banner' keyword in class", () => {
      const el = document.createElement("aside");
      el.setAttribute("class", "consent-banner");
      expect(matchesConsentRule(el, DEFAULT_CONSENT_RULESET)).toBe(true);
    });

    it("matches a data-cookiebanner attribute", () => {
      const el = document.createElement("div");
      el.setAttribute("data-cookiebanner", "");
      expect(matchesConsentRule(el, DEFAULT_CONSENT_RULESET)).toBe(true);
    });
  });

  describe("explicit negative unit cases", () => {
    it("does not match an ordinary content div", () => {
      const el = document.createElement("div");
      el.id = "main-content";
      el.setAttribute("class", "article body wide");
      expect(matchesConsentRule(el, DEFAULT_CONSENT_RULESET)).toBe(false);
    });

    it("does not match a nav element with benign id/class", () => {
      const el = document.createElement("nav");
      el.id = "primary-navigation";
      el.setAttribute("class", "menu top-bar");
      expect(matchesConsentRule(el, DEFAULT_CONSENT_RULESET)).toBe(false);
    });

    it("does not match an element with an unrelated data-attribute", () => {
      const el = document.createElement("div");
      el.setAttribute("data-testid", "hero-banner");
      expect(matchesConsentRule(el, DEFAULT_CONSENT_RULESET)).toBe(false);
    });
  });

  // Validates: Requirements 11.5 — the predicate purely reads (no mutation).
  it("leaves the inspected element unchanged (pure read)", () => {
    const ruleset: ConsentRuleset = DEFAULT_CONSENT_RULESET;
    const el = document.createElement("div");
    el.id = "onetrust-banner-sdk";
    el.setAttribute("class", "cookie-consent");
    const before = el.outerHTML;
    matchesConsentRule(el, ruleset);
    expect(el.outerHTML).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Property 13: Scroll state restoration round-trips
// Validates: Requirements 11.3
// ---------------------------------------------------------------------------

/** Common overflow values plus arbitrary strings, to exercise the helpers. */
const overflowArb = fc.oneof(
  fc.constantFrom("", "hidden", "auto", "scroll", "visible"),
  fc.string({ maxLength: 16 })
);

/** Optional inline body position (undefined → no position captured). */
const positionArb = fc.option(
  fc.oneof(fc.constantFrom("", "fixed", "static", "relative", "absolute"), fc.string({ maxLength: 16 })),
  { nil: undefined }
);

interface MutableDocStub {
  body: { style: { overflow: string; position?: string } };
  documentElement: { style: { overflow: string } };
}

/** Build a document-like stub with the given scroll-related inline styles. */
function makeDocStub(
  bodyOverflow: string,
  htmlOverflow: string,
  bodyPosition: string | undefined
): MutableDocStub {
  const bodyStyle: { overflow: string; position?: string } = {
    overflow: bodyOverflow,
  };
  if (bodyPosition !== undefined) bodyStyle.position = bodyPosition;
  return {
    body: { style: bodyStyle },
    documentElement: { style: { overflow: htmlOverflow } },
  };
}

describe("Property 13: Scroll state restoration round-trips", () => {
  // Validates: Requirements 11.3 — capture → restore is an exact round-trip.
  it("restoreScrollState(captureScrollState(doc)) deep-equals the capture", () => {
    fc.assert(
      fc.property(
        overflowArb,
        overflowArb,
        positionArb,
        (bodyOverflow, htmlOverflow, bodyPosition) => {
          const doc = makeDocStub(bodyOverflow, htmlOverflow, bodyPosition);
          const captured = captureScrollState(doc);
          expect(restoreScrollState(captured)).toEqual(captured);
        }
      ),
      RUNS
    );
  });

  // Validates: Requirements 11.3 — capture reflects the source styles exactly.
  it("captureScrollState reads the inline styles verbatim", () => {
    fc.assert(
      fc.property(
        overflowArb,
        overflowArb,
        positionArb,
        (bodyOverflow, htmlOverflow, bodyPosition) => {
          const doc = makeDocStub(bodyOverflow, htmlOverflow, bodyPosition);
          const captured = captureScrollState(doc);
          expect(captured.bodyOverflow).toBe(bodyOverflow);
          expect(captured.htmlOverflow).toBe(htmlOverflow);
          if (bodyPosition === undefined) {
            expect(captured.bodyPosition).toBeUndefined();
            expect("bodyPosition" in captured).toBe(false);
          } else {
            expect(captured.bodyPosition).toBe(bodyPosition);
          }
        }
      ),
      RUNS
    );
  });

  // Validates: Requirements 11.3 — the apply path writes prev onto target.
  it("restoreScrollState(prev, target) writes the values onto target and returns them", () => {
    fc.assert(
      fc.property(
        overflowArb,
        overflowArb,
        positionArb,
        (bodyOverflow, htmlOverflow, bodyPosition) => {
          const prev: ScrollState =
            bodyPosition === undefined
              ? { bodyOverflow, htmlOverflow }
              : { bodyOverflow, htmlOverflow, bodyPosition };

          // Start the target from clearly different values.
          const target = makeDocStub("INIT-BODY", "INIT-HTML", "INIT-POS");
          const returned = restoreScrollState(prev, target);

          expect(target.body.style.overflow).toBe(bodyOverflow);
          expect(target.documentElement.style.overflow).toBe(htmlOverflow);
          if (bodyPosition !== undefined) {
            expect(target.body.style.position).toBe(bodyPosition);
          } else {
            // When prev has no position, the apply path leaves it untouched.
            expect(target.body.style.position).toBe("INIT-POS");
          }
          expect(returned).toEqual(prev);
        }
      ),
      RUNS
    );
  });

  // Validates: Requirements 11.3 — capture → restore(apply) → capture is stable.
  it("capture → restore(apply) → capture yields the same state", () => {
    fc.assert(
      fc.property(
        overflowArb,
        overflowArb,
        positionArb,
        (bodyOverflow, htmlOverflow, bodyPosition) => {
          const source = makeDocStub(bodyOverflow, htmlOverflow, bodyPosition);
          const first = captureScrollState(source);

          // Apply onto a fresh target whose position slot matches the captured
          // shape, so a re-capture is directly comparable.
          const target = makeDocStub(
            "x",
            "y",
            first.bodyPosition === undefined ? undefined : "z"
          );
          restoreScrollState(first, target);
          const second = captureScrollState(target);

          expect(second).toEqual(first);
        }
      ),
      RUNS
    );
  });

  describe("explicit unit cases", () => {
    it("round-trips a scroll-locking snapshot (overflow hidden, position fixed)", () => {
      const doc = makeDocStub("hidden", "hidden", "fixed");
      const captured = captureScrollState(doc);
      expect(captured).toEqual({
        bodyOverflow: "hidden",
        htmlOverflow: "hidden",
        bodyPosition: "fixed",
      });
      expect(restoreScrollState(captured)).toEqual(captured);
    });

    it("omits bodyPosition when the source had no inline position", () => {
      const doc = makeDocStub("", "", undefined);
      const captured = captureScrollState(doc);
      expect(captured).toEqual({ bodyOverflow: "", htmlOverflow: "" });
      expect("bodyPosition" in captured).toBe(false);
    });

    it("applies restored overflow values onto a real jsdom document", () => {
      document.body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";
      const prev: ScrollState = { bodyOverflow: "auto", htmlOverflow: "" };
      const returned = restoreScrollState(prev, {
        body: document.body,
        documentElement: document.documentElement,
      });
      expect(document.body.style.overflow).toBe("auto");
      expect(document.documentElement.style.overflow).toBe("");
      expect(returned).toEqual(prev);
    });
  });
});
