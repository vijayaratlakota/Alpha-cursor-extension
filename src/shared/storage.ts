// Storage layer for Alpha Cursor (task 4.1).
//
// This module is the ONLY code that talks to `chrome.storage.*` and IndexedDB.
// It encapsulates the design's three-tier storage placement:
//   - `chrome.storage.sync`  -> small settings (Toggle, separator, search sites)
//   - `chrome.storage.local` -> structured metadata (identity, notepad index,
//                               tab folders, operation checkpoints)
//   - IndexedDB (`acx-blobs`) -> large binary blobs (screenshots, OCR crops,
//                               notepad overflow text/history)
//
// All keys are profile-scoped: `acx:{localProfileId}:{domain}:{...}` so that a
// single browser profile's data is naturally namespaced and can be cleared in
// bulk (Property 19 + Property 20).
//
// Dependency direction: `identity.ts` imports `storage.ts`, NOT the other way
// around. To avoid a circular dependency this module never imports identity;
// every scoped operation takes `profileId` as an explicit parameter. The pure
// key-building / scoping helpers are exported separately so tasks 4.3 / 4.4 can
// property-test them without touching `chrome.*` or IndexedDB.
//
// Error model: every `chrome.*` / IndexedDB failure is converted into an
// `AppError` (STORAGE_FAILED, or QUOTA_EXCEEDED when the error indicates a quota
// limit) via `makeError`. Async helpers reject with an `AppError`.
//
// Design references: "Data Models", "Storage Placement Summary", "Error
// Handling", and Properties 19 & 20.

import { AppError, ErrorCode, makeError } from "./messaging";

// ---------------------------------------------------------------------------
// Key namespacing (pure — property-tested by tasks 4.3 / 4.4)
// ---------------------------------------------------------------------------

/** Root namespace prefix for every key the extension writes. */
export const KEY_NAMESPACE = "acx";

/** Separator between key segments. Chosen to be URL/JSON-safe and stable. */
export const KEY_SEPARATOR = ":";

/**
 * Known storage "domains" (the third key segment). Callers should prefer these
 * constants over raw strings so key shapes stay consistent across the codebase.
 * `scopedKey` still accepts any string to remain forward-compatible.
 */
export const StorageDomain = {
  SETTINGS: "settings",
  IDENTITY: "identity",
  NOTEPAD: "notepad",
  TAB_FOLDERS: "tabfolders",
  CHECKPOINT: "checkpoint",
  BLOBS: "blobs",
} as const;

/** Union of the well-known domain string literals. */
export type StorageDomain =
  (typeof StorageDomain)[keyof typeof StorageDomain];

/**
 * Build a fully-qualified, profile-scoped storage key:
 * `acx:{profileId}:{domain}:{...parts}`.
 *
 * Pure and deterministic — the foundation of Property 19 (reads are scoped to
 * the active profile). Empty/whitespace `profileId` is rejected because an
 * unscoped key would leak across profiles.
 */
export function scopedKey(
  profileId: string,
  domain: string,
  ...parts: string[]
): string {
  if (!profileId || profileId.trim() === "") {
    throw makeError(
      ErrorCode.STORAGE_FAILED,
      "scopedKey requires a non-empty profileId",
      false,
    );
  }
  return [KEY_NAMESPACE, profileId, domain, ...parts].join(KEY_SEPARATOR);
}

/**
 * The prefix shared by every key belonging to a profile: `acx:{profileId}:`.
 * Used to enumerate and clear all of a profile's data (Property 20).
 */
export function profilePrefix(profileId: string): string {
  if (!profileId || profileId.trim() === "") {
    throw makeError(
      ErrorCode.STORAGE_FAILED,
      "profilePrefix requires a non-empty profileId",
      false,
    );
  }
  return `${KEY_NAMESPACE}${KEY_SEPARATOR}${profileId}${KEY_SEPARATOR}`;
}

/**
 * True when `key` belongs to `profileId` (i.e. starts with that profile's
 * prefix). Pure helper underpinning the disjointness/scoping properties.
 */
export function isProfileScopedKey(key: string, profileId: string): boolean {
  return key.startsWith(profilePrefix(profileId));
}

/**
 * Parse a scoped key back into its components, or return `null` when the key is
 * not an Alpha Cursor scoped key. The `parts` array holds any segments after
 * the domain (it may be empty).
 */
export function parseScopedKey(
  key: string,
): { profileId: string; domain: string; parts: string[] } | null {
  const segments = key.split(KEY_SEPARATOR);
  if (segments.length < 3 || segments[0] !== KEY_NAMESPACE) {
    return null;
  }
  const [, profileId, domain, ...parts] = segments;
  if (!profileId || !domain) {
    return null;
  }
  return { profileId, domain, parts };
}

/**
 * Build a profile-scoped blob reference for the IndexedDB blob store. Blob keys
 * are namespaced identically to `chrome.storage` keys
 * (`acx:{profileId}:blobs:{...parts}`) so they can be cleared per profile in
 * `clearAll` (Property 20).
 */
export function makeBlobRef(profileId: string, ...parts: string[]): string {
  return scopedKey(profileId, StorageDomain.BLOBS, ...parts);
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

/** Heuristic: does an error message indicate a storage quota limit? */
function isQuotaMessage(message: string): boolean {
  return /quota|QUOTA_BYTES|exceeded the quota/i.test(message);
}

/**
 * Normalize any thrown value / `lastError` message into an `AppError`. Quota
 * conditions map to `QUOTA_EXCEEDED`; everything else to `STORAGE_FAILED`. If
 * the value is already an `AppError`, it is passed through unchanged.
 */
function toStorageError(cause: unknown, context: string): AppError {
  if (isAppError(cause)) {
    return cause;
  }
  const raw =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : cause == null
          ? ""
          : String(cause);
  const message = raw ? `${context}: ${raw}` : context;
  const code = isQuotaMessage(raw)
    ? ErrorCode.QUOTA_EXCEEDED
    : ErrorCode.STORAGE_FAILED;
  return makeError(code, message, true);
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

// ---------------------------------------------------------------------------
// chrome.storage wrappers (sync + local)
// ---------------------------------------------------------------------------

/**
 * Run a `chrome.storage` operation and convert `chrome.runtime.lastError` or a
 * thrown/rejected value into an `AppError`. Works with the callback form so we
 * reliably observe `lastError` across Chrome versions.
 */
function runStorageOp<T>(
  context: string,
  op: (done: (result: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = (error: unknown) => reject(toStorageError(error, context));
    try {
      op((result) => {
        const lastError = chrome.runtime?.lastError;
        if (lastError) {
          fail(lastError.message ?? "chrome.runtime.lastError");
          return;
        }
        resolve(result);
      }, fail);
    } catch (error) {
      fail(error);
    }
  });
}

function area(kind: "sync" | "local"): chrome.storage.StorageArea {
  return kind === "sync" ? chrome.storage.sync : chrome.storage.local;
}

/**
 * Get a single typed value from a storage area. Resolves to `undefined` when the
 * key is absent. Rejects with an `AppError` on failure.
 */
function getFromArea<T>(
  kind: "sync" | "local",
  key: string,
): Promise<T | undefined> {
  return runStorageOp<T | undefined>(`storage.${kind}.get(${key})`, (done, fail) => {
    area(kind).get(key, (items) => {
      if (chrome.runtime?.lastError) {
        fail(chrome.runtime.lastError.message);
        return;
      }
      done((items as Record<string, T>)[key]);
    });
  });
}

/** Set a single typed value into a storage area. Rejects with an `AppError`. */
function setInArea<T>(
  kind: "sync" | "local",
  key: string,
  value: T,
): Promise<void> {
  return runStorageOp<void>(`storage.${kind}.set(${key})`, (done) => {
    area(kind).set({ [key]: value }, () => done(undefined));
  });
}

/** Remove one or more keys from a storage area. Rejects with an `AppError`. */
function removeFromArea(
  kind: "sync" | "local",
  keys: string | string[],
): Promise<void> {
  return runStorageOp<void>(`storage.${kind}.remove`, (done) => {
    area(kind).remove(keys, () => done(undefined));
  });
}

/** Read every key/value currently held in a storage area. */
function getAllFromArea(
  kind: "sync" | "local",
): Promise<Record<string, unknown>> {
  return runStorageOp<Record<string, unknown>>(
    `storage.${kind}.get(null)`,
    (done) => {
      area(kind).get(null, (items) => done(items as Record<string, unknown>));
    },
  );
}

// Public, typed get/set/remove for each tier. Callers pass already-scoped keys
// (built via `scopedKey`) so this layer stays agnostic about domains.

/** Get a small setting value from `chrome.storage.sync`. */
export function getSync<T>(key: string): Promise<T | undefined> {
  return getFromArea<T>("sync", key);
}

/** Persist a small setting value to `chrome.storage.sync`. */
export function setSync<T>(key: string, value: T): Promise<void> {
  return setInArea<T>("sync", key, value);
}

/** Remove one or more keys from `chrome.storage.sync`. */
export function removeSync(keys: string | string[]): Promise<void> {
  return removeFromArea("sync", keys);
}

/** Get a metadata value from `chrome.storage.local`. */
export function getLocal<T>(key: string): Promise<T | undefined> {
  return getFromArea<T>("local", key);
}

/** Persist a metadata value to `chrome.storage.local`. */
export function setLocal<T>(key: string, value: T): Promise<void> {
  return setInArea<T>("local", key, value);
}

/** Remove one or more keys from `chrome.storage.local`. */
export function removeLocal(keys: string | string[]): Promise<void> {
  return removeFromArea("local", keys);
}

// ---------------------------------------------------------------------------
// IndexedDB blob store (`acx-blobs` / object store `blobs`)
// ---------------------------------------------------------------------------

/** Name of the IndexedDB database holding large binary blobs. */
export const BLOB_DB_NAME = "acx-blobs";
/** Name of the object store within `acx-blobs`. */
export const BLOB_STORE_NAME = "blobs";
const BLOB_DB_VERSION = 1;

/**
 * Value stored against a `blobRef` in the `blobs` object store. `data` is the
 * raw binary payload (e.g. a screenshot PNG or OCR source crop).
 */
export interface BlobRecord {
  mime: string;
  data: Blob;
  createdAt: number;
}

/** Resolve the ambient IndexedDB factory (service worker, page, or test shim). */
function getIndexedDB(): IDBFactory {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) {
    throw makeError(
      ErrorCode.STORAGE_FAILED,
      "IndexedDB is not available in this context",
      false,
    );
  }
  return idb;
}

/** Open (and lazily create/upgrade) the `acx-blobs` database. */
function openBlobDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = getIndexedDB().open(BLOB_DB_NAME, BLOB_DB_VERSION);
    } catch (error) {
      reject(toStorageError(error, "indexedDB.open"));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BLOB_STORE_NAME)) {
        // Out-of-line keys: the `blobRef` (a profile-scoped string) is supplied
        // explicitly on put, which lets us namespace + bulk-clear per profile.
        db.createObjectStore(BLOB_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(toStorageError(request.error, "indexedDB.open"));
    request.onblocked = () =>
      reject(
        toStorageError("open blocked by another connection", "indexedDB.open"),
      );
  });
}

/**
 * Run a transaction against the blob store and resolve with `extract(store)`'s
 * request result once the transaction completes. Errors convert to `AppError`.
 */
function runBlobTx<T>(
  mode: IDBTransactionMode,
  context: string,
  run: (store: IDBObjectStore) => IDBRequest<T> | { result?: T },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    openBlobDb().then(
      (db) => {
        let result: T;
        let tx: IDBTransaction;
        try {
          tx = db.transaction(BLOB_STORE_NAME, mode);
        } catch (error) {
          db.close();
          reject(toStorageError(error, context));
          return;
        }
        const store = tx.objectStore(BLOB_STORE_NAME);
        try {
          const request = run(store) as IDBRequest<T>;
          if (request && "onsuccess" in request) {
            request.onsuccess = () => {
              result = request.result;
            };
            request.onerror = () =>
              reject(toStorageError(request.error, context));
          }
        } catch (error) {
          reject(toStorageError(error, context));
          return;
        }
        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onerror = () => {
          db.close();
          reject(toStorageError(tx.error, context));
        };
        tx.onabort = () => {
          db.close();
          reject(toStorageError(tx.error ?? "transaction aborted", context));
        };
      },
      (error) => reject(toStorageError(error, context)),
    );
  });
}

/** Store a blob record under `blobRef`. Rejects with an `AppError`. */
export function putBlob(blobRef: string, record: BlobRecord): Promise<void> {
  return runBlobTx<void>("readwrite", `indexedDB.put(${blobRef})`, (store) =>
    store.put(record, blobRef) as unknown as IDBRequest<void>,
  );
}

/** Fetch a blob record by `blobRef`, or `undefined` when absent. */
export function getBlob(blobRef: string): Promise<BlobRecord | undefined> {
  return runBlobTx<BlobRecord | undefined>(
    "readonly",
    `indexedDB.get(${blobRef})`,
    (store) => store.get(blobRef) as IDBRequest<BlobRecord | undefined>,
  );
}

/** Delete a blob record by `blobRef`. No-op when the key is absent. */
export function deleteBlob(blobRef: string): Promise<void> {
  return runBlobTx<void>(
    "readwrite",
    `indexedDB.delete(${blobRef})`,
    (store) => store.delete(blobRef) as unknown as IDBRequest<void>,
  );
}

/** List every key currently present in the blob store. */
function getAllBlobKeys(): Promise<string[]> {
  return runBlobTx<string[]>("readonly", "indexedDB.getAllKeys", (store) => {
    return store.getAllKeys() as unknown as IDBRequest<string[]>;
  }).then((keys) => (keys ?? []).map((key) => String(key)));
}

// ---------------------------------------------------------------------------
// Bulk clear (Property 20: leaves no orphaned profile-scoped entries)
// ---------------------------------------------------------------------------

/**
 * Remove every key scoped to `profileId` across `chrome.storage.sync`,
 * `chrome.storage.local`, and the IndexedDB blob store. Used by the options
 * page "clear all data" control (Req 19.6, 21.7).
 *
 * Each tier is cleared independently; a failure in one tier rejects with an
 * `AppError` but the others may already have been cleared. Callers surface the
 * error via the Notification system.
 */
export async function clearAll(profileId: string): Promise<void> {
  const prefix = profilePrefix(profileId);

  const [syncItems, localItems, blobKeys] = await Promise.all([
    getAllFromArea("sync"),
    getAllFromArea("local"),
    getAllBlobKeys(),
  ]);

  const syncKeys = Object.keys(syncItems).filter((k) => k.startsWith(prefix));
  const localKeys = Object.keys(localItems).filter((k) => k.startsWith(prefix));
  const profileBlobKeys = blobKeys.filter((k) => k.startsWith(prefix));

  await Promise.all([
    syncKeys.length ? removeFromArea("sync", syncKeys) : Promise.resolve(),
    localKeys.length ? removeFromArea("local", localKeys) : Promise.resolve(),
    ...profileBlobKeys.map((k) => deleteBlob(k)),
  ]);
}
