// Tool 7 — Search Selected Text (Req 12): pure URL-building helper + default
// search-site list.
//
// This module is 100% pure (no Chrome APIs, no DOM): it is the property-tested
// core of the "Search in" tool. The menu wiring, empty-selection notification,
// and new-tab opening live in the content/background layer (task 16.3); the
// editable site list surfaces on the Options page (task 25.1).
//
// `buildSearchUrl(template, selection)` takes a site URL template containing a
// `{q}` placeholder (matching `SearchSite.urlTemplate` from
// `src/shared/settings.ts`) and the user's current selection, and returns a
// concrete search URL with the selection substituted in URL-encoded form
// (Req 12.2, 12.3).
//
// Correctness (Property 14 — "Search URL encodes and round-trips the
// selection"): the selection is encoded with `encodeURIComponent`, so decoding
// the query value with `decodeURIComponent` recovers the original selection
// exactly — including spaces, `&`, `=`, `?`, `#`, and Unicode. All occurrences
// of `{q}` in the template are replaced so multi-placeholder templates round-
// trip the same encoded value.

import type { SearchSite } from "../../shared/settings";

/** The placeholder token replaced by the URL-encoded selection in a template. */
export const QUERY_PLACEHOLDER = "{q}";

/**
 * Build a concrete search URL from a site `template` and the user's
 * `selection`.
 *
 * The selection is URL-encoded with `encodeURIComponent` and substituted for
 * every occurrence of the `{q}` placeholder in the template (Req 12.2, 12.3).
 * Encoding with `encodeURIComponent` guarantees the round-trip invariant of
 * Property 14: `decodeURIComponent(encoded) === selection` for any string,
 * which is why decoding the query parameter of the produced URL yields the
 * original selection back.
 *
 * Pure: no Chrome/DOM access, deterministic for given inputs.
 *
 * @param template A URL containing one or more `{q}` placeholders, e.g.
 *   `https://www.google.com/search?q={q}`.
 * @param selection The raw selected text (may contain spaces, `&`, `=`, `?`,
 *   `#`, Unicode, etc.).
 * @returns The template with every `{q}` replaced by the encoded selection.
 */
export function buildSearchUrl(template: string, selection: string): string {
  const encoded = encodeURIComponent(selection);
  // Replace ALL occurrences of the literal placeholder. `split`/`join` is used
  // instead of `String.prototype.replaceAll` to avoid any chance of `$`
  // substitution patterns in `encoded` being interpreted (as they would be by
  // the replacement-string form of `replace`/`replaceAll`).
  return template.split(QUERY_PLACEHOLDER).join(encoded);
}

/**
 * Default "Search in" sites seeded on first run and shown in the sub-menu when
 * no user configuration exists (Req 12.1). Users can add, remove, and reorder
 * these on the Options page (Req 12.6, task 25.1). `order` is contiguous and
 * zero-based so the list renders YouTube → Reddit → Quora → Google.
 */
export const DEFAULT_SEARCH_SITES: readonly SearchSite[] = [
  {
    id: "youtube",
    label: "YouTube",
    urlTemplate: "https://www.youtube.com/results?search_query={q}",
    order: 0,
  },
  {
    id: "reddit",
    label: "Reddit",
    urlTemplate: "https://www.reddit.com/search/?q={q}",
    order: 1,
  },
  {
    id: "quora",
    label: "Quora",
    urlTemplate: "https://www.quora.com/search?q={q}",
    order: 2,
  },
  {
    id: "google",
    label: "Google",
    urlTemplate: "https://www.google.com/search?q={q}",
    order: 3,
  },
];
