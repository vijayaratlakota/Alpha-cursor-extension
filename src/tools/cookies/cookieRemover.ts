/**
 * Alpha Cursor — Cookie Consent Popup Removal, content-script wiring (task 15.4).
 *
 * This module is the *impure* counterpart to {@link ./consent}: it owns the
 * live-DOM side of Tool 6 (Req 11). It scans the page on load (and on DOM
 * ready) for consent banners, watches for late-injected popups with a
 * {@link MutationObserver} (Req 11.4), removes only the elements the bundled
 * ruleset matches (Req 11.5), and gives the page its scrolling back when a
 * removed popup had locked it (Req 11.3).
 *
 * Everything is gated on the global Toggle (Req 11.6 / Req 1.6): removal only
 * runs while {@link getCachedEnabled} is `true`, and the module subscribes via
 * {@link onEnabledChanged} so that flipping the Toggle OFF disconnects the
 * observer and stops removing popups (and flipping it back ON re-arms both).
 *
 * Tool 6 is *automatic* — it is not a middle-click Options_Panel option — so
 * this module deliberately does NOT register in the tools catalog. The
 * content-script orchestrator (`src/content/index.ts`) calls
 * {@link initCookieRemoval} on load; {@link teardownCookieRemoval} disconnects
 * everything for teardown/tests.
 *
 * Matching decisions are delegated wholesale to the PURE
 * {@link matchesConsentRule}; this file only uses it to decide *what* to
 * `.remove()`, so it can never touch a non-consent element (Req 11.5). When
 * nothing matches, it does nothing — a successful no-op (Req 11.2).
 */

import {
  DEFAULT_CONSENT_RULESET,
  captureScrollState,
  matchesConsentRule,
  restoreScrollState,
  type ConsentRuleset,
  type ScrollState,
} from "./consent";
import {
  getCachedEnabled,
  onEnabledChanged,
  getCachedFeatureFlags,
  onFeatureFlagsChanged,
} from "../../shared/settings";

/** DOM `Node.ELEMENT_NODE` constant, inlined so we need no live `Node` ref. */
const ELEMENT_NODE = 1;

/**
 * The "unlocked" scroll state we re-apply after removing a scroll-locking
 * popup. Empty inline values clear any `overflow: hidden` / `position: fixed`
 * the popup set on `<body>`/`<html>`, letting the page scroll again (Req 11.3).
 * Routed through {@link restoreScrollState} (the design's restore helper) so the
 * write path stays in one place.
 */
const UNLOCKED_SCROLL_STATE: ScrollState = {
  bodyOverflow: "",
  htmlOverflow: "",
  bodyPosition: "",
};

// ---------------------------------------------------------------------------
// Module state (start/stop lifecycle)
// ---------------------------------------------------------------------------

/** The active observer while removal is armed, else `null`. */
let observer: MutationObserver | null = null;
/** `true` while removal is armed (Toggle ON and started). */
let active = false;
/** Disposer for the {@link onEnabledChanged} subscription, else `null`. */
let unsubscribeEnabled: (() => void) | null = null;
/** Disposer for the feature-flags subscription, else `null`. */
let unsubscribeFlags: (() => void) | null = null;
/** Disposer for a pending DOMContentLoaded listener, else `null`. */
let detachDomReady: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

/** Escape a value for safe use inside a double-quoted CSS attribute selector. */
function escapeForSelector(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * Build the focused list of CSS selectors used to *gather candidates* before
 * the conservative {@link matchesConsentRule} makes the final call. Mirrors the
 * ruleset's four signal kinds so we never scan the whole DOM blindly:
 *   - vendor selectors verbatim,
 *   - `[id="…"]` for each known CMP id,
 *   - `[id*="…"]` / `[class*="…"]` for each consent keyword fragment,
 *   - `[name]` for each consent data-/aria-attribute.
 * Each selector is queried independently (and guarded), so one malformed entry
 * can never suppress the others.
 */
function candidateSelectors(ruleset: ConsentRuleset): string[] {
  const selectors: string[] = [];

  for (const selector of ruleset.selectors) {
    selectors.push(selector);
  }
  for (const id of ruleset.cmpIds) {
    selectors.push(`[id="${escapeForSelector(id)}"]`);
  }
  for (const keyword of ruleset.keywordPatterns) {
    if (keyword === "") continue;
    const escaped = escapeForSelector(keyword);
    selectors.push(`[id*="${escaped}"]`, `[class*="${escaped}"]`);
  }
  for (const pattern of ruleset.attributePatterns) {
    selectors.push(`[${escapeForSelector(pattern.name)}]`);
  }

  return selectors;
}

/**
 * Collect every consent element within `root` (optionally including `root`
 * itself) that {@link matchesConsentRule} confirms. Returns a de-duplicated
 * array. Selectors are only used to *narrow* the search; the ruleset predicate
 * is the sole authority on whether an element is actually removed (Req 11.5).
 */
function collectConsentElements(
  root: ParentNode & Element,
  ruleset: ConsentRuleset,
  includeSelf: boolean,
): Element[] {
  const found = new Set<Element>();

  if (includeSelf && matchesConsentRule(root, ruleset)) {
    // The element itself is a banner; removing it takes its subtree with it, so
    // there is no need to also collect descendants.
    found.add(root);
    return [...found];
  }

  for (const selector of candidateSelectors(ruleset)) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = root.querySelectorAll(selector);
    } catch {
      // Ignore malformed/unsupported selectors rather than aborting the scan.
      continue;
    }
    nodes.forEach((element) => {
      if (matchesConsentRule(element, ruleset)) {
        found.add(element);
      }
    });
  }

  return [...found];
}

// ---------------------------------------------------------------------------
// Removal + scroll restoration
// ---------------------------------------------------------------------------

/**
 * `true` when the captured scroll state shows the page is scroll-locked the way
 * consent popups do it: `overflow: hidden` on `<body>`/`<html>` or a fixed
 * `<body>` position. Used to decide whether removal should restore scrolling
 * (Req 11.3) — we only restore when we actually detected a lock.
 */
function isScrollLocked(state: ScrollState): boolean {
  const bodyOverflow = state.bodyOverflow.toLowerCase();
  const htmlOverflow = state.htmlOverflow.toLowerCase();
  const bodyPosition = (state.bodyPosition ?? "").toLowerCase();
  return (
    bodyOverflow.includes("hidden") ||
    htmlOverflow.includes("hidden") ||
    bodyPosition === "fixed"
  );
}

/**
 * Remove the supplied matched elements and, if their presence had locked page
 * scrolling, restore scrolling afterwards. Empty input is a no-op (Req 11.2).
 * Captures the scroll state *before* removal so the lock attribution reflects
 * the popup's effect, then clears the lock via {@link restoreScrollState}.
 */
function removeMatches(matches: Element[]): void {
  if (matches.length === 0) return;

  const before = captureScrollState(document);

  for (const element of matches) {
    try {
      element.remove();
    } catch {
      // An already-detached element is fine; keep removing the rest.
    }
  }

  if (isScrollLocked(before)) {
    restoreScrollState(UNLOCKED_SCROLL_STATE, document);
  }
}

/**
 * Full-document scan + removal (used on load and DOM ready). Conservative:
 * removes only ruleset matches, restores scroll only on a detected lock, and
 * no-ops when nothing matches.
 */
function scanAndRemove(): void {
  if (!active) return;
  const rootElement = document.documentElement;
  if (!rootElement) return;
  const matches = collectConsentElements(
    rootElement,
    DEFAULT_CONSENT_RULESET,
    false,
  );
  removeMatches(matches);
}

// ---------------------------------------------------------------------------
// MutationObserver (late-injected popups, Req 11.4)
// ---------------------------------------------------------------------------

/**
 * Observer callback: inspects newly-added element subtrees for consent banners
 * and removes any matches as they appear (Req 11.4). Only added element nodes
 * are examined, keeping the per-mutation cost proportional to what changed.
 */
function handleMutations(mutations: MutationRecord[]): void {
  if (!active) return;

  const toRemove = new Set<Element>();
  for (const mutation of mutations) {
    mutation.addedNodes.forEach((node) => {
      if (node.nodeType !== ELEMENT_NODE) return;
      const element = node as Element;
      for (const match of collectConsentElements(
        element,
        DEFAULT_CONSENT_RULESET,
        true,
      )) {
        toRemove.add(match);
      }
    });
  }

  if (toRemove.size > 0) {
    removeMatches([...toRemove]);
  }
}

/** Attach the {@link MutationObserver} to the document, if not already attached. */
function setupObserver(): void {
  if (observer) return;
  if (typeof MutationObserver !== "function") return;
  const target = document.documentElement ?? document.body;
  if (!target) return;
  observer = new MutationObserver(handleMutations);
  observer.observe(target, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Run the initial scan now and, if the DOM is still loading, again on ready. */
function scanOnLoad(): void {
  // Scan whatever exists right now (handles already-parsed pages).
  scanAndRemove();

  if (document.readyState === "loading") {
    const onReady = (): void => {
      detachDomReady = null;
      document.removeEventListener("DOMContentLoaded", onReady);
      scanAndRemove();
    };
    document.addEventListener("DOMContentLoaded", onReady);
    detachDomReady = () => {
      document.removeEventListener("DOMContentLoaded", onReady);
      detachDomReady = null;
    };
  }
}

/** Arm removal: initial scan + observer. Idempotent. */
function start(): void {
  if (active) return;
  if (typeof document === "undefined") return;
  active = true;
  scanOnLoad();
  setupObserver();
}

/**
 * Disarm removal: disconnect the observer, drop any pending DOM-ready listener,
 * and stop reacting to mutations. Idempotent. The Toggle subscription is left
 * intact so the module can re-arm when the Toggle flips back ON (Req 11.6).
 */
function stop(): void {
  active = false;
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (detachDomReady) {
    detachDomReady();
    detachDomReady = null;
  }
}

/**
 * Content-script entry point for automatic cookie-consent popup removal
 * (Req 11). Arms removal immediately when the Toggle is ON (using the
 * synchronous cache) and subscribes to Toggle changes so removal starts/stops
 * as the Toggle flips ON/OFF (Req 11.6). Safe to call once on content-script
 * load; calling again only ensures a single subscription.
 */
export function initCookieRemoval(): void {
  // Removal runs only while the global Toggle is ON AND the per-feature flag is
  // enabled (both default to ON so it works right after install).
  const shouldRun = (): boolean =>
    getCachedEnabled() && getCachedFeatureFlags().cookieRemoval;

  if (shouldRun()) {
    start();
  }

  if (!unsubscribeEnabled) {
    unsubscribeEnabled = onEnabledChanged(() => {
      if (shouldRun()) {
        start();
      } else {
        stop();
      }
    });
  }

  if (!unsubscribeFlags) {
    unsubscribeFlags = onFeatureFlagsChanged(() => {
      if (shouldRun()) {
        start();
      } else {
        stop();
      }
    });
  }
}

/**
 * Tear down cookie removal entirely: disconnect the observer, drop the pending
 * DOM-ready listener, and unsubscribe from Toggle changes. Used by the
 * orchestrator/tests to fully detach the module.
 */
export function teardownCookieRemoval(): void {
  stop();
  if (unsubscribeEnabled) {
    unsubscribeEnabled();
    unsubscribeEnabled = null;
  }
  if (unsubscribeFlags) {
    unsubscribeFlags();
    unsubscribeFlags = null;
  }
}
