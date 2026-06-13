// Pure helpers for Tool 2 (Save All Tabs, Req 7) and Tool 3 (Restore Saved
// Tabs, Req 8). This module is intentionally PURE — it has no `chrome.*`,
// storage, or DOM dependencies — so the background save/restore handlers
// (tasks 12.3 / 12.5) can compose it and the property tests (task 12.2,
// Property 9) can exercise it deterministically.
//
// Design references:
// - "Tool 2 — Save All Tabs (Req 7) & Tool 3 — Restore Saved Tabs (Req 8)":
//   "Pure helpers (property-tested): `validateFolderName`,
//   `partitionOpenableUrls(urls)` → `{ openable, invalid }`."
// - "Property 9: URL partition is complete and disjoint" (Req 8.3, 8.4, 8.5).
//
// SCOPE NOTE: name-collision handling (Req 7.4, returning `TAB_NAME_EXISTS`
// when a name already exists) lives in the background save handler (task 12.3)
// because it needs the list of existing folder names. `validateFolderName`
// here only validates the *shape* of a single proposed name (non-empty after
// trimming, within a max length); it does not know about other folders.

// ---------------------------------------------------------------------------
// Folder name validation (Req 7.4 — shape validation only)
// ---------------------------------------------------------------------------

/**
 * Maximum number of characters allowed in a `Tab_Folder` name (after trimming).
 * Chosen as a generous but bounded limit so names stay usable in the restore
 * list UI and never bloat `chrome.storage.local`.
 */
export const MAX_FOLDER_NAME_LENGTH = 100;

/** Reason codes explaining why a folder name was rejected. */
export const FolderNameError = {
  /** The name was empty or contained only whitespace. */
  EMPTY: "EMPTY",
  /** The trimmed name exceeded {@link MAX_FOLDER_NAME_LENGTH}. */
  TOO_LONG: "TOO_LONG",
} as const;

/** Union of folder-name rejection reason codes. */
export type FolderNameError =
  (typeof FolderNameError)[keyof typeof FolderNameError];

/**
 * Result of validating a proposed `Tab_Folder` name. On success `valid` is
 * `true` and `name` carries the trimmed, save-ready value. On failure `valid`
 * is `false` and `reason` explains why.
 */
export type FolderNameValidation =
  | { valid: true; name: string }
  | { valid: false; reason: FolderNameError };

/**
 * Validate a proposed `Tab_Folder` name (Req 7.4 — shape only; collision with
 * existing names is handled by the background save handler).
 *
 * Rules:
 * - The name is trimmed of leading/trailing whitespace.
 * - An empty or whitespace-only name is rejected (`EMPTY`).
 * - A trimmed name longer than {@link MAX_FOLDER_NAME_LENGTH} is rejected
 *   (`TOO_LONG`).
 *
 * Pure and deterministic: the same input always yields the same result.
 */
export function validateFolderName(name: string): FolderNameValidation {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: FolderNameError.EMPTY };
  }
  if (trimmed.length > MAX_FOLDER_NAME_LENGTH) {
    return { valid: false, reason: FolderNameError.TOO_LONG };
  }
  return { valid: true, name: trimmed };
}

// ---------------------------------------------------------------------------
// Openable-URL partitioning (Req 8.3, 8.4, 8.5 — Property 9)
// ---------------------------------------------------------------------------

/**
 * Result of partitioning stored URLs into those a tab can actually be opened to
 * versus those that cannot. The two arrays are DISJOINT and together COVER the
 * entire input (Property 9), and order within each array matches input order.
 */
export interface UrlPartition {
  /** URLs safe to open as a browser tab (http/https). */
  openable: string[];
  /** Malformed, empty, or non-openable-scheme URLs. */
  invalid: string[];
}

/**
 * Schemes that a saved tab may be reopened to. Restricted to web schemes:
 * `javascript:`, `data:`, `blob:`, `about:`, `chrome:`, `file:` and friends are
 * treated as non-openable (either unsafe, internal, or unrestorable) so they
 * land in `invalid` and are counted as failures (Req 8.4, 8.5).
 */
const OPENABLE_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Decide whether a single stored URL string is openable as a browser tab.
 *
 * A URL is openable iff it parses via the `URL` constructor AND its protocol is
 * one of {@link OPENABLE_SCHEMES} (`http:` / `https:`). Everything else —
 * empty/whitespace strings, malformed URLs the constructor rejects, and valid
 * URLs with non-web schemes (`javascript:`, `data:`, `about:`, `chrome:`,
 * `file:`, …) — is not openable.
 *
 * Pure and total: never throws (parse failures are caught and reported as
 * not-openable).
 */
export function isOpenableUrl(url: string): boolean {
  if (typeof url !== "string" || url.trim().length === 0) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return OPENABLE_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Partition a list of stored URLs into `openable` and `invalid` sets (Req 8.3,
 * 8.4, 8.5; Property 9).
 *
 * Guarantees (verified by Property 9):
 * - **Complete:** `openable.length + invalid.length === urls.length` — every
 *   input URL lands in exactly one bucket.
 * - **Disjoint:** no URL appears in both buckets (each element is classified
 *   once, in order, into a single array).
 * - **Order-preserving:** relative input order is kept within each bucket.
 *
 * The restore handler (task 12.5) opens `openable` and reports
 * `invalid.length` as the count of URLs that failed to open (Req 8.5); when
 * `openable` is empty it shows the "no tabs could be opened" notification and
 * opens nothing (Req 8.4).
 */
export function partitionOpenableUrls(urls: string[]): UrlPartition {
  const openable: string[] = [];
  const invalid: string[] = [];
  for (const url of urls) {
    if (isOpenableUrl(url)) {
      openable.push(url);
    } else {
      invalid.push(url);
    }
  }
  return { openable, invalid };
}
