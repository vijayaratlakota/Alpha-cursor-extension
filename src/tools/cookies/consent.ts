/**
 * Alpha Cursor — Cookie Consent Popup Removal, pure core (task 15.1).
 *
 * This module holds the *pure* heart of Tool 6 (Req 11): the bundled
 * consent-popup ruleset, the predicate that decides whether a given element is
 * a consent banner, and the scroll/overflow capture+restore helpers used to
 * give the page its scrolling back after a scroll-locking popup is removed.
 *
 * Everything here is DOM-data-driven but side-effect free (the predicate only
 * *reads* an element; the scroll helpers operate on plain state objects), so it
 * is fully property-testable without a real browser:
 *
 *   - Property 12 (task 15.2): removal touches only matching elements — backed
 *     by {@link matchesConsentRule}, which is conservative and must never match
 *     arbitrary non-consent elements.
 *   - Property 13 (task 15.3): scroll-state restoration round-trips — backed by
 *     {@link captureScrollState} / {@link restoreScrollState}.
 *
 * The `MutationObserver` wiring and the actual `element.remove()` /
 * `document.body.style` mutations live in the content script (task 15.4); this
 * file deliberately does NOT touch the live DOM beyond reading the element it is
 * asked about.
 */

/**
 * The bundled consent-popup ruleset (Req 11.1, 11.5). Kept as plain data —
 * arrays of selectors and keyword/attribute patterns — so it is trivially
 * inspectable and testable. {@link matchesConsentRule} interprets it.
 */
export interface ConsentRuleset {
  /**
   * Exact, high-confidence ids used by well-known Consent Management Platforms
   * (CMPs). Compared case-insensitively against `element.id`. These are strong
   * signals on their own.
   */
  readonly cmpIds: readonly string[];
  /**
   * Full CSS selectors for well-known consent containers. Evaluated with
   * `element.matches(selector)`. Use these for vendor-specific markup that is
   * not captured by a bare id.
   */
  readonly selectors: readonly string[];
  /**
   * Keyword fragments that, when present in an element's `id` or `class`,
   * indicate a consent banner (e.g. "cookie", "consent", "gdpr"). Matched
   * case-insensitively as substrings. Keep these specific enough that they do
   * not collide with ordinary page markup.
   */
  readonly keywordPatterns: readonly string[];
  /**
   * Data-/aria-attribute names (optionally with an expected value) that signal a
   * consent banner, e.g. `data-cookiebanner`. When `value` is omitted, the mere
   * presence of the attribute matches; when provided, the attribute value must
   * equal it (case-insensitively).
   */
  readonly attributePatterns: readonly ConsentAttributePattern[];
}

/** An attribute-based consent signal used within a {@link ConsentRuleset}. */
export interface ConsentAttributePattern {
  /** Attribute name, e.g. `data-cookiebanner` or `aria-label`. */
  readonly name: string;
  /**
   * Optional expected value. When omitted, presence of the attribute is enough.
   * When present, the attribute value must equal it (case-insensitive).
   */
  readonly value?: string;
}

/**
 * The default, bundled consent ruleset (Req 11.1). Conservative by design:
 * keyword patterns are specific consent vocabulary, and the CMP ids / selectors
 * target widely-deployed Consent Management Platforms.
 *
 * Sources of the well-known ids/selectors are the public, vendor-documented
 * container ids (OneTrust, Cookiebot, Quantcast/TrustArc, Osano, Cookie-Script,
 * Termly, Didomi, Usercentrics, CookieYes, Borlabs, etc.).
 */
export const DEFAULT_CONSENT_RULESET: ConsentRuleset = {
  cmpIds: [
    "onetrust-banner-sdk",
    "onetrust-consent-sdk",
    "ot-sdk-container",
    "CybotCookiebotDialog",
    "cookiebanner",
    "cookie-banner",
    "cookie-consent",
    "cookie-notice",
    "cookieConsent",
    "cookiechoiceinfo",
    "gdpr-cookie-message",
    "gdpr-consent-banner",
    "cmpbox",
    "cmpwrapper",
    "qc-cmp2-container",
    "usercentrics-root",
    "didomi-host",
    "didomi-popup",
    "osano-cm-window",
    "cookiescript_injected",
    "termly-code-snippet-support",
    "cookieyes",
    "BorlabsCookieBox",
    "truste-consent-track",
    "consent_blackbar",
    "sp_message_container",
    "hs-eu-cookie-confirmation",
  ],
  selectors: [
    "#onetrust-banner-sdk",
    "#CybotCookiebotDialog",
    ".ot-sdk-container",
    ".cookie-consent-banner",
    ".cookie-notice-container",
    ".cc-window",
    ".cc-banner",
    ".qc-cmp2-container",
    ".osano-cm-window",
    ".cmp-banner",
    "[data-testid='cookie-policy-banner']",
    "[data-testid='cookie-consent-banner']",
    "[aria-describedby='onetrust-policy-text']",
  ],
  keywordPatterns: [
    "cookie-consent",
    "cookieconsent",
    "cookie-banner",
    "cookiebanner",
    "cookie-notice",
    "cookienotice",
    "cookie-policy",
    "cookie-law",
    "cookie-bar",
    "cookiebar",
    "gdpr-consent",
    "gdpr-cookie",
    "consent-banner",
    "consent-popup",
    "consent-manager",
    "consent-dialog",
    "cmp-banner",
    "cmp-popup",
  ],
  attributePatterns: [
    { name: "data-cookiebanner" },
    { name: "data-cookie-consent" },
    { name: "data-consent-manager" },
    { name: "data-gdpr" },
    { name: "data-nosnippet-cookie" },
  ],
};

/** Lowercase a value safely; non-strings become an empty string. */
function lower(value: string | null | undefined): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/**
 * Read an element's class string in a way that is robust across HTML elements
 * (`className` is a string) and SVG elements (`className` is an
 * `SVGAnimatedString`). Falls back to the `class` attribute.
 */
function classString(element: Element): string {
  const raw = (element as { className?: unknown }).className;
  if (typeof raw === "string") return raw;
  const attr = element.getAttribute?.("class");
  return typeof attr === "string" ? attr : "";
}

/** True when `element.id` matches one of the ruleset's known CMP ids. */
function matchesCmpId(element: Element, ruleset: ConsentRuleset): boolean {
  const id = lower(element.id);
  if (id === "") return false;
  return ruleset.cmpIds.some((cmpId) => lower(cmpId) === id);
}

/** True when the element matches any full CSS selector in the ruleset. */
function matchesSelector(element: Element, ruleset: ConsentRuleset): boolean {
  if (typeof element.matches !== "function") return false;
  for (const selector of ruleset.selectors) {
    try {
      if (element.matches(selector)) return true;
    } catch {
      // Ignore malformed/unsupported selectors rather than throwing.
    }
  }
  return false;
}

/**
 * True when the element's id or class contains one of the consent keyword
 * fragments. Substring (case-insensitive) matching on the combined id+class
 * text; the fragments themselves are specific enough to avoid ordinary markup.
 */
function matchesKeyword(element: Element, ruleset: ConsentRuleset): boolean {
  const haystack = `${lower(element.id)} ${lower(classString(element))}`;
  return ruleset.keywordPatterns.some(
    (pattern) => pattern !== "" && haystack.includes(lower(pattern))
  );
}

/** True when the element carries one of the ruleset's consent attributes. */
function matchesAttribute(element: Element, ruleset: ConsentRuleset): boolean {
  if (typeof element.getAttribute !== "function") return false;
  for (const pattern of ruleset.attributePatterns) {
    if (
      typeof element.hasAttribute === "function" &&
      !element.hasAttribute(pattern.name)
    ) {
      continue;
    }
    const actual = element.getAttribute(pattern.name);
    if (actual === null) continue;
    if (pattern.value === undefined) return true;
    if (lower(actual) === lower(pattern.value)) return true;
  }
  return false;
}

/**
 * PURE predicate (Property 12). Returns `true` only when `element` matches the
 * given consent ruleset by id / selector / keyword / attribute heuristics, and
 * `false` for everything else.
 *
 * It is deliberately *conservative*: it only reports a match on strong, consent
 * specific signals (well-known CMP ids, vendor selectors, consent vocabulary in
 * the id/class, or explicit consent data-attributes). It performs no DOM
 * mutation — it only reads `element` — so the caller (task 15.4) can safely use
 * it to decide what to remove without risk of touching non-consent elements
 * (Req 11.5). An element that matches nothing is left intact (Req 11.2).
 *
 * @param element the element to classify
 * @param ruleset the consent ruleset to match against (use {@link DEFAULT_CONSENT_RULESET})
 * @returns `true` iff the element matches the ruleset
 */
export function matchesConsentRule(
  element: Element,
  ruleset: ConsentRuleset
): boolean {
  if (element === null || typeof element !== "object") return false;
  return (
    matchesCmpId(element, ruleset) ||
    matchesSelector(element, ruleset) ||
    matchesKeyword(element, ruleset) ||
    matchesAttribute(element, ruleset)
  );
}

/**
 * A captured snapshot of the page's scroll-related inline styles (Req 11.3).
 * Consent popups frequently lock scrolling by setting `overflow: hidden` (and
 * sometimes `position: fixed`) on `<html>`/`<body>`; we snapshot the *prior*
 * values before removal so we can put them back afterwards.
 *
 * These are the literal inline-style strings (which may be `""` when no inline
 * style was set), so capture→restore is an exact round-trip.
 */
export interface ScrollState {
  /** Prior inline `overflow` on `document.body`. */
  readonly bodyOverflow: string;
  /** Prior inline `overflow` on `document.documentElement` (`<html>`). */
  readonly htmlOverflow: string;
  /** Prior inline `position` on `document.body`, when present. */
  readonly bodyPosition?: string;
}

/**
 * A minimal element-style shape used by {@link captureScrollState} so it can be
 * exercised against plain objects in tests as well as real DOM elements.
 */
interface StyledElementLike {
  readonly style: {
    overflow?: string;
    position?: string;
  };
}

/** A minimal document shape: just the two elements whose scroll styles matter. */
interface ScrollDocumentLike {
  readonly body: StyledElementLike;
  readonly documentElement: StyledElementLike;
}

/**
 * Capture the current scroll/overflow inline styles from a document-like object
 * (Req 11.3). Reads `document.body` and `document.documentElement` inline
 * styles and returns a plain {@link ScrollState} snapshot — no mutation.
 *
 * Accepts any object with the right shape, so tests can pass a hand-built stub
 * and verify the capture→restore round-trip without a browser.
 *
 * @param doc the document (or document-like stub) to read from
 * @returns the captured scroll state
 */
export function captureScrollState(doc: ScrollDocumentLike): ScrollState {
  const bodyOverflow = doc.body.style.overflow ?? "";
  const htmlOverflow = doc.documentElement.style.overflow ?? "";
  const bodyPosition = doc.body.style.position;
  return bodyPosition === undefined
    ? { bodyOverflow, htmlOverflow }
    : { bodyOverflow, htmlOverflow, bodyPosition };
}

/**
 * PURE-ish restore helper (Property 13). Given a previously captured
 * {@link ScrollState}, returns the normalized set of values to re-apply so the
 * page scrolls again after a scroll-locking popup is removed (Req 11.3).
 *
 * Returning a fresh {@link ScrollState} (rather than mutating) keeps this a pure
 * round-trip: `restoreScrollState(captureScrollState(doc))` deep-equals
 * `captureScrollState(doc)`. The optional `target` lets the content script
 * (task 15.4) apply the values to a real document in one call; when supplied,
 * the same values are written to `target.body`/`documentElement` styles and
 * still returned.
 *
 * @param prev the scroll state captured before the popup locked scrolling
 * @param target optional document to apply the restored values to
 * @returns the values that were (or should be) applied
 */
export function restoreScrollState(
  prev: ScrollState,
  target?: {
    body: { style: { overflow: string; position?: string } };
    documentElement: { style: { overflow: string } };
  }
): ScrollState {
  const restored: ScrollState =
    prev.bodyPosition === undefined
      ? { bodyOverflow: prev.bodyOverflow, htmlOverflow: prev.htmlOverflow }
      : {
          bodyOverflow: prev.bodyOverflow,
          htmlOverflow: prev.htmlOverflow,
          bodyPosition: prev.bodyPosition,
        };

  if (target) {
    target.body.style.overflow = restored.bodyOverflow;
    target.documentElement.style.overflow = restored.htmlOverflow;
    if (restored.bodyPosition !== undefined) {
      target.body.style.position = restored.bodyPosition;
    }
  }

  return restored;
}
