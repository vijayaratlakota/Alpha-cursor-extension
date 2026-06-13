// Local identity & write-gating for Alpha Cursor (task 4.2).
//
// Client-side-only reinterpretation of Requirement 3: there is NO account
// system and NO server. A "User_Account" is a single *local profile* per
// browser profile, identified by a `localProfileId` (UUID v4) created on first
// run. Data isolation is provided by Chrome's per-profile storage sandbox; this
// module just mints and persists the id that every other piece of stored data
// is scoped under (`acx:{localProfileId}:{domain}:{...}` via `storage.ts`).
//
// Responsibilities:
//   - `ensureLocalProfile()` — read (or create + persist) the LocalIdentity
//     record and return its `localProfileId`. Safe to call eagerly on load from
//     every context (background / content / popup / options) (Req 3.4).
//   - Write-gating (Req 3.5) — `getActiveProfileId()`, `requireProfile()`, and
//     `withProfile()` let callers block user-data writes until a profile exists.
//   - Concurrency — the in-flight `ensureLocalProfile()` promise is memoized so
//     multiple contexts/calls racing at load never mint duplicate ids.
//
// ---------------------------------------------------------------------------
// Bootstrap-key chicken-and-egg
// ---------------------------------------------------------------------------
// Every OTHER record in the app is stored under a *profile-scoped* key
// (`scopedKey(profileId, domain, ...)`), but the identity record itself cannot
// be — we don't have a `profileId` until we've read/created it. So the
// `LocalIdentity` record is stored at a single, FIXED, NON-profile-scoped
// bootstrap key in `chrome.storage.local`. This is the one deliberate exception
// to the profile-scoping rule and is the anchor the rest of the scoping is
// built on.
//
// Design references: "Cross-Cutting: Local Identity & Storage Scoping",
// "Data Models > Local Identity", and the Error Handling row for Req 3.5.

import { getLocal, setLocal } from "./storage";
import { AppError, ErrorCode, makeError } from "./messaging";

/**
 * Fixed, NON-profile-scoped bootstrap key for the `LocalIdentity` record in
 * `chrome.storage.local`. Intentionally does NOT go through `scopedKey` because
 * the profile id it contains is what scoping itself depends on.
 */
export const IDENTITY_BOOTSTRAP_KEY = "acx::identity";

/**
 * The single local-profile identity record. Mirrors the design's Data Models
 * definition. Stored at {@link IDENTITY_BOOTSTRAP_KEY}.
 */
export interface LocalIdentity {
  /** Stable UUID v4 minted on first run; namespaces all profile-scoped keys. */
  localProfileId: string;
  /** Epoch millis when this local profile was first created. */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// In-memory cache + concurrency control
// ---------------------------------------------------------------------------

/**
 * The active profile id once known, cached for synchronous access by the
 * write-gating helpers. `null` until `ensureLocalProfile()` has resolved at
 * least once in this context.
 */
let activeProfileId: string | null = null;

/**
 * Memoized in-flight `ensureLocalProfile()` promise. Collapses concurrent calls
 * (e.g. background + content + popup all bootstrapping at load) onto a single
 * read/create so duplicate ids are never minted. Cleared on failure so a later
 * call can retry (Req 3.5: retry on next load).
 */
let ensurePromise: Promise<string> | null = null;

/** Generate a UUID v4 using the platform crypto, available in every MV3 context. */
function generateProfileId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoObj || typeof cryptoObj.randomUUID !== "function") {
    throw makeError(
      ErrorCode.IDENTITY_FAILED,
      "crypto.randomUUID is unavailable; cannot create local profile id",
      false,
    );
  }
  return cryptoObj.randomUUID();
}

/**
 * Read the existing local identity (or create and persist a new one) and return
 * its `localProfileId`. Safe — and intended — to call eagerly on load from any
 * context (Req 3.4). Concurrent calls share one in-flight operation so multiple
 * contexts cannot create duplicate ids.
 *
 * Rejects with an `AppError` (`IDENTITY_FAILED`) if the id cannot be created or
 * persisted; the memoized promise is cleared so a subsequent call can retry on
 * the next load (Req 3.5).
 */
export function ensureLocalProfile(): Promise<string> {
  // Already resolved in this context — return the cached id immediately.
  if (activeProfileId !== null) {
    return Promise.resolve(activeProfileId);
  }
  // Coalesce concurrent callers onto the single in-flight operation.
  if (ensurePromise !== null) {
    return ensurePromise;
  }

  ensurePromise = (async () => {
    try {
      const existing = await getLocal<LocalIdentity>(IDENTITY_BOOTSTRAP_KEY);
      if (existing && typeof existing.localProfileId === "string" && existing.localProfileId.trim() !== "") {
        activeProfileId = existing.localProfileId;
        return existing.localProfileId;
      }

      const identity: LocalIdentity = {
        localProfileId: generateProfileId(),
        createdAt: Date.now(),
      };
      await setLocal<LocalIdentity>(IDENTITY_BOOTSTRAP_KEY, identity);
      activeProfileId = identity.localProfileId;
      return identity.localProfileId;
    } catch (cause) {
      // Surface a single, well-classified identity error regardless of whether
      // the failure came from storage (already an AppError) or id generation.
      throw isAppError(cause)
        ? makeError(ErrorCode.IDENTITY_FAILED, cause.message, false)
        : makeError(
            ErrorCode.IDENTITY_FAILED,
            `Failed to create local profile: ${String(cause)}`,
            false,
          );
    } finally {
      // Clear the in-flight promise so a failed bootstrap can be retried on the
      // next load; on success `activeProfileId` short-circuits future calls.
      ensurePromise = null;
    }
  })();

  return ensurePromise;
}

/**
 * Synchronously return the active `localProfileId` if one has already been
 * established in this context, or `null` otherwise. Does NOT trigger creation —
 * callers that need to guarantee a profile should await `ensureLocalProfile()`
 * (or use {@link requireProfile} / {@link withProfile}).
 */
export function getActiveProfileId(): string | null {
  return activeProfileId;
}

/**
 * Write gate (Req 3.5). Returns the active `localProfileId`, ensuring one exists
 * first. Rejects with an `IDENTITY_FAILED` `AppError` when no profile can be
 * established — callers MUST block user-data writes on this rejection.
 */
export async function requireProfile(): Promise<string> {
  const profileId = await ensureLocalProfile();
  if (!profileId || profileId.trim() === "") {
    throw makeError(
      ErrorCode.IDENTITY_FAILED,
      "No local profile id available; user-data writes are blocked",
      false,
    );
  }
  return profileId;
}

/**
 * Run `fn` with a guaranteed `localProfileId`, blocking until the local profile
 * exists (Req 3.5). The canonical wrapper for any user-data write: if identity
 * cannot be established the operation never runs and the `IDENTITY_FAILED`
 * `AppError` propagates to the caller for notification.
 */
export async function withProfile<T>(
  fn: (profileId: string) => Promise<T>,
): Promise<T> {
  const profileId = await requireProfile();
  return fn(profileId);
}

/**
 * Reset the in-memory identity cache. Intended for tests and for the options
 * "clear all data" flow so a fresh profile is re-established on next ensure.
 */
export function resetIdentityCache(): void {
  activeProfileId = null;
  ensurePromise = null;
}

/** Narrow an unknown value to an `AppError`. */
function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    "recoverable" in value
  );
}
