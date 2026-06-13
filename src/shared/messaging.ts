// Typed cross-context messaging envelope and error model for Alpha Cursor.
//
// This module is a shared dependency for the storage layer (which wraps
// `chrome.*` errors into `AppError`) and the background router (task 5.2). It is
// intentionally self-contained with NO imports from other `src` modules to
// avoid circular dependencies between the storage, identity, and router layers.
//
// Design references:
// - "Components and Interfaces": the `Message<T>` / `Response<R>` envelope.
// - "Error Handling": the scenario table that drives the `ErrorCode` set.

/**
 * Enumeration of every error scenario the extension normalizes into an
 * `AppError`. The codes map onto the design's Error Handling table plus the
 * cross-cutting failures (identity, storage, permissions) and a catch-all
 * `UNKNOWN` for anything unclassified.
 *
 * Implemented as a const object + union type (rather than a TS `enum`) so it
 * survives `isolatedModules`/bundler erasure cleanly and can be iterated.
 */
export const ErrorCode = {
  /** Local identity (`localProfileId`) could not be created/persisted (Req 3.5). */
  IDENTITY_FAILED: "IDENTITY_FAILED",
  /** A storage write/read against `chrome.storage` or IndexedDB failed (Req 22.5). */
  STORAGE_FAILED: "STORAGE_FAILED",
  /** A `chrome.storage` quota limit was hit, e.g. notepad append (Req 4.4). */
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  /** Writing to the system clipboard failed (Req 6.5, 14.4). */
  CLIPBOARD_FAILED: "CLIPBOARD_FAILED",
  /** Copy All invoked on an empty notepad (Req 6.4). */
  EMPTY_NOTEPAD: "EMPTY_NOTEPAD",
  /** Tab folder name collides with an existing folder (Req 7.4). */
  TAB_NAME_EXISTS: "TAB_NAME_EXISTS",
  /** No tabs available to save (Req 7.5). */
  NO_TABS: "NO_TABS",
  /** No openable URLs found while restoring a tab folder (Req 8.4). */
  NO_OPENABLE_URLS: "NO_OPENABLE_URLS",
  /** Full-page screenshot capture/stitching failed (Req 9.6). */
  CAPTURE_FAILED: "CAPTURE_FAILED",
  /** Source image could not be retrieved or decoded (Req 10.5). */
  IMAGE_DECODE_FAILED: "IMAGE_DECODE_FAILED",
  /** A search/OCR/voice action was invoked with no text selected (Req 12.4). */
  EMPTY_SELECTION: "EMPTY_SELECTION",
  /** Media download failed at runtime (Req 13.7). */
  MEDIA_FAILED: "MEDIA_FAILED",
  /** Requested media is not downloadable client-side under MV3 (Req 13, 22.4). */
  MEDIA_INFEASIBLE: "MEDIA_INFEASIBLE",
  /** Color sampling via EyeDropper/Canvas failed (Req 14.4). */
  COLOR_SAMPLE_FAILED: "COLOR_SAMPLE_FAILED",
  /** OCR completed but found no text in the selected region (Req 15.5). */
  OCR_NO_TEXT: "OCR_NO_TEXT",
  /** Microphone access was denied for voice-to-text (Req 16.5). */
  MIC_DENIED: "MIC_DENIED",
  /** A host/device permission was denied at point of use (Req 21.3). */
  PERMISSION_DENIED: "PERMISSION_DENIED",
  /** Catch-all for unclassified or unexpected failures. */
  UNKNOWN: "UNKNOWN",
} as const;

/** Union of all valid error code string literals. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Normalized error shape surfaced to the Notification system. `recoverable`
 * hints whether the user can retry or otherwise continue (most failures) versus
 * a hard stop.
 */
export interface AppError {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
}

/**
 * A request envelope sent across extension contexts via `chrome.runtime`
 * messaging. `requestId` correlates a `Response` back to its originating
 * `Message`.
 */
export interface Message<T = unknown> {
  type: string;
  payload: T;
  requestId: string;
}

/** A successful response carrying typed `data`. */
export interface SuccessResponse<R = unknown> {
  ok: true;
  data: R;
}

/** A failed response carrying a normalized `AppError`. */
export interface ErrorResponse {
  ok: false;
  error: AppError;
}

/** Discriminated response union returned by message handlers. */
export type Response<R = unknown> = SuccessResponse<R> | ErrorResponse;

/**
 * Construct an `AppError`. Defaults to `recoverable: true` since the system
 * favors graceful degradation; pass `false` for hard-stop failures.
 */
export function makeError(
  code: ErrorCode,
  message: string,
  recoverable = true,
): AppError {
  return { code, message, recoverable };
}

/** Wrap a value in a successful `Response`. */
export function ok<R>(data: R): SuccessResponse<R> {
  return { ok: true, data };
}

/** Wrap an `AppError` in a failed `Response`. */
export function err(error: AppError): ErrorResponse {
  return { ok: false, error };
}

/**
 * Build a `Message` envelope, generating a unique `requestId`.
 *
 * Uses `crypto.randomUUID()` (available in service workers, content scripts, and
 * extension pages in modern Chrome). Falls back to a timestamp+random id only if
 * `crypto.randomUUID` is unavailable, so the module never throws at the boundary.
 */
export function createMessage<T>(type: string, payload: T): Message<T> {
  return { type, payload, requestId: generateRequestId() };
}

function generateRequestId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Type guard narrowing a `Response` to its success branch. */
export function isOk<R>(response: Response<R>): response is SuccessResponse<R> {
  return response.ok === true;
}

/** Type guard narrowing a `Response` to its error branch. */
export function isErr<R>(response: Response<R>): response is ErrorResponse {
  return response.ok === false;
}
