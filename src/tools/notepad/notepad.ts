/**
 * Alpha Cursor — Notepad Clipboard storage + capture + Copy All (tasks 11.4, 11.7).
 *
 * Tool 1 (Notepad Clipboard) has three moving parts, all wired here:
 *
 *  1. **Storage core** (runs in the background service worker): append an
 *     ordered {@link NotepadEntry} with a monotonic `seq` (Req 4.5), accept an
 *     unbounded number of entries limited only by storage (Req 4.2), persist
 *     metadata + small text in `chrome.storage.local` and overflow large text
 *     to the IndexedDB blob store (per design Data Models), and on a quota limit
 *     attempt a best-effort append while flagging the caller so it can raise the
 *     "storage limit reached" Notification (Req 4.1, 4.4).
 *
 *  2. **Copy-event capture** ({@link initNotepadCapture}, content script): listen
 *     to the document `copy` event, read the current selection, and — only while
 *     the Toggle is ON (Req 4.1) — send `NOTEPAD_APPEND` to the background,
 *     surfacing the quota Notification when the append reports it.
 *
 *  3. **Copy All** ({@link registerNotepadTool}, content script): the
 *     context-independent Options_Panel tool. It asks the background to join all
 *     entries with the configured Separator (Req 6.2), then performs the actual
 *     `navigator.clipboard.writeText` in the content (user-gesture) context.
 *     Empty notepad → "Notepad is empty" Notification and NO clipboard write
 *     (Req 6.4); success → confirmation (Req 6.3); failure → failure
 *     Notification (Req 6.5).
 *
 * The background message handlers (`NOTEPAD_APPEND`, `NOTEPAD_COPY_ALL`,
 * `NOTEPAD_LIST`) are installed by `installNotepad()` in
 * `src/background/notepadHandlers.ts`; this module exports the storage core they
 * call plus the content-side wiring. Clipboard access is restricted in MV3
 * service workers, so `NOTEPAD_COPY_ALL` returns the joined string and the
 * content-side tool writes it to the clipboard.
 */

import {
  StorageDomain,
  getLocal,
  setLocal,
  getSync,
  removeLocal,
  scopedKey,
  makeBlobRef,
  putBlob,
  getBlob,
  deleteBlob,
  type BlobRecord,
} from "../../shared/storage";
import { requireProfile } from "../../shared/identity";
import {
  type Message,
  type Response,
  ErrorCode,
  createMessage,
  isOk,
  makeError,
} from "../../shared/messaging";
import type { SeparatorConfig } from "../../shared/settings";
import { getCachedEnabled } from "../../shared/settings";
import { resolveSeparator, joinEntries, DEFAULT_SEPARATOR } from "./separator";
import { registerTool, ToolId } from "../../content/tools";
import { notify } from "../../ui/notify";

// ---------------------------------------------------------------------------
// Data models (per design "Data Models > Notepad")
// ---------------------------------------------------------------------------

/** A single captured Notepad entry. `text` is inlined unless it overflows. */
export interface NotepadEntry {
  /** Stable UUID for this entry. */
  id: string;
  /** Monotonic capture-order sequence number (Req 4.5). */
  seq: number;
  /** The captured text, inlined when small; `""` when stored via {@link blobRef}. */
  text: string;
  /** IndexedDB blob key holding the full text when it exceeds the inline limit. */
  blobRef?: string;
  /** Epoch millis when the copy was captured. */
  capturedAt: number;
  /** URL of the page the copy originated from (Req 4.3 — captured regardless). */
  sourceUrl?: string;
}

/** Ordered index of entry ids plus the last-issued `seq` (Req 4.5). */
export interface NotepadIndex {
  lastSeq: number;
  entryIds: string[];
}

/**
 * Inline-vs-overflow threshold (characters). Text at or below this is stored
 * inline in `chrome.storage.local`; longer text overflows to the IndexedDB blob
 * store so the small `local` quota is preserved for metadata (per design).
 */
export const NOTEPAD_INLINE_TEXT_LIMIT = 8 * 1024;

/** MIME used for overflow text blobs in the IndexedDB blob store. */
const NOTEPAD_BLOB_MIME = "text/plain";

// ---------------------------------------------------------------------------
// Message contract (background handlers in notepadHandlers.ts)
// ---------------------------------------------------------------------------

/** Notepad message `type` strings routed through the background router. */
export const NotepadMessageType = {
  /** Append a captured entry: payload {@link NotepadAppendPayload}. */
  APPEND: "NOTEPAD_APPEND",
  /** Join all entries for Copy All: returns {@link NotepadCopyAllResult}. */
  COPY_ALL: "NOTEPAD_COPY_ALL",
  /** List all entries (for the popup, task 24): returns {@link NotepadEntry}[]. */
  LIST: "NOTEPAD_LIST",
  /** Remove a single entry by id (undo): payload {@link NotepadRemovePayload}. */
  REMOVE: "NOTEPAD_REMOVE",
  /** Clear every entry for the active profile: returns {@link ClearNotepadResult}. */
  CLEAR: "NOTEPAD_CLEAR",
} as const;

/** Union of the notepad message `type` string literals. */
export type NotepadMessageType =
  (typeof NotepadMessageType)[keyof typeof NotepadMessageType];

/** Payload for `NOTEPAD_APPEND`. */
export interface NotepadAppendPayload {
  /** The copied text to append. */
  text: string;
  /** Optional originating page URL (Req 4.3). */
  sourceUrl?: string;
}

/** Payload for `NOTEPAD_REMOVE` (undo of a captured entry). */
export interface NotepadRemovePayload {
  /** The id of the {@link NotepadEntry} to remove. */
  id: string;
}

/** Result of `NOTEPAD_REMOVE`. */
export interface NotepadRemoveResult {
  /** `true` when an entry was found and removed. */
  removed: boolean;
}

/** Result of `NOTEPAD_APPEND`. */
export interface NotepadAppendResult {
  /** The appended entry (metadata; `text` may be empty when overflowed). */
  entry: NotepadEntry;
  /**
   * `true` when a storage quota limit was hit during the append. The append is
   * still attempted best-effort; the caller raises the "storage limit reached"
   * Notification (Req 4.4).
   */
  quotaExceeded: boolean;
}

/** Result of `NOTEPAD_COPY_ALL`: the joined string plus emptiness/count. */
export interface NotepadCopyAllResult {
  /** All entries joined with the configured Separator (Req 6.2). `""` if empty. */
  joined: string;
  /** Number of entries joined. */
  count: number;
  /** `true` when the notepad has no entries (Req 6.4 — no clipboard write). */
  empty: boolean;
}

// ---------------------------------------------------------------------------
// Scoped key helpers
// ---------------------------------------------------------------------------

/** `acx:{profileId}:notepad:index` — the ordered entry index. */
function indexKey(profileId: string): string {
  return scopedKey(profileId, StorageDomain.NOTEPAD, "index");
}

/** `acx:{profileId}:notepad:entry:{id}` — a single entry record. */
function entryKey(profileId: string, id: string): string {
  return scopedKey(profileId, StorageDomain.NOTEPAD, "entry", id);
}

/** `acx:{profileId}:settings:separator` — the configured Separator (task 25.1). */
function separatorKey(profileId: string): string {
  return scopedKey(profileId, StorageDomain.SETTINGS, "separator");
}

// ---------------------------------------------------------------------------
// Storage core (background context)
// ---------------------------------------------------------------------------

/** Generate a UUID for a new entry, falling back when `randomUUID` is absent. */
function generateEntryId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `np-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Narrow an unknown value to an `AppError` carrying an `ErrorCode`. */
function isQuotaError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    (value as { code?: unknown }).code === ErrorCode.QUOTA_EXCEEDED
  );
}

/** Read the current index, or a fresh empty index when none is persisted. */
async function readIndex(profileId: string): Promise<NotepadIndex> {
  const existing = await getLocal<NotepadIndex>(indexKey(profileId));
  if (
    existing &&
    typeof existing.lastSeq === "number" &&
    Array.isArray(existing.entryIds)
  ) {
    return existing;
  }
  return { lastSeq: 0, entryIds: [] };
}

/**
 * Append `text` as a new {@link NotepadEntry} to the active profile's Notepad.
 *
 * Maintains a strictly increasing `seq` (Req 4.5), preserves capture order via
 * the {@link NotepadIndex} (Req 4.1), and accepts unlimited entries bounded only
 * by storage (Req 4.2). Large text overflows to the IndexedDB blob store; small
 * text is inlined in `chrome.storage.local` (per design). Capture is
 * origin-independent — `sourceUrl` is recorded but never gates the append
 * (Req 4.3).
 *
 * On a storage quota limit the append is attempted best-effort and the returned
 * `quotaExceeded` flag is set so the caller can raise the "storage limit
 * reached" Notification (Req 4.4). Non-quota storage failures reject.
 */
export async function appendEntry(
  text: string,
  sourceUrl?: string,
): Promise<NotepadAppendResult> {
  const profileId = await requireProfile();
  const index = await readIndex(profileId);

  const id = generateEntryId();
  const seq = index.lastSeq + 1;
  const safeText = typeof text === "string" ? text : String(text ?? "");

  let quotaExceeded = false;

  // Build the entry, overflowing large text to IndexedDB (which has far more
  // headroom than chrome.storage.local) so the index/metadata stay small.
  const entry: NotepadEntry = {
    id,
    seq,
    text: safeText,
    capturedAt: Date.now(),
    ...(sourceUrl ? { sourceUrl } : {}),
  };

  if (safeText.length > NOTEPAD_INLINE_TEXT_LIMIT) {
    const blobRef = makeBlobRef(profileId, "notepad", id);
    const record: BlobRecord = {
      mime: NOTEPAD_BLOB_MIME,
      data: new Blob([safeText], { type: NOTEPAD_BLOB_MIME }),
      createdAt: entry.capturedAt,
    };
    try {
      await putBlob(blobRef, record);
      entry.blobRef = blobRef;
      entry.text = "";
    } catch (cause) {
      // Overflow failed: keep the text inline as a best-effort fallback and let
      // the local write below surface any quota condition.
      if (isQuotaError(cause)) {
        quotaExceeded = true;
      } else {
        throw cause;
      }
    }
  }

  // Persist the entry record, then the updated index. A quota limit on either
  // write still counts as a best-effort append (Req 4.1) and flags the caller.
  try {
    await setLocal<NotepadEntry>(entryKey(profileId, id), entry);
  } catch (cause) {
    if (isQuotaError(cause)) {
      quotaExceeded = true;
    } else {
      throw cause;
    }
  }

  const nextIndex: NotepadIndex = {
    lastSeq: seq,
    entryIds: [...index.entryIds, id],
  };
  try {
    await setLocal<NotepadIndex>(indexKey(profileId), nextIndex);
  } catch (cause) {
    if (isQuotaError(cause)) {
      quotaExceeded = true;
    } else {
      throw cause;
    }
  }

  return { entry, quotaExceeded };
}

/**
 * Remove a single {@link NotepadEntry} by id (the undo path for an accidental
 * auto-copy capture). Deletes the entry record, drops its id from the ordered
 * {@link NotepadIndex}, and removes any IndexedDB overflow blob. `lastSeq` is
 * left untouched so subsequent appends keep a strictly increasing `seq`.
 *
 * @returns `{ removed: true }` when the entry existed in the index.
 */
export async function removeEntry(id: string): Promise<NotepadRemoveResult> {
  const profileId = await requireProfile();
  const index = await readIndex(profileId);
  if (!index.entryIds.includes(id)) {
    return { removed: false };
  }

  // Drop the overflow blob first so no orphan is left behind.
  const entry = await getLocal<NotepadEntry>(entryKey(profileId, id));
  if (entry?.blobRef) {
    try {
      await deleteBlob(entry.blobRef);
    } catch {
      /* best-effort */
    }
  }
  try {
    await removeLocal(entryKey(profileId, id));
  } catch {
    /* best-effort */
  }

  const nextIndex: NotepadIndex = {
    lastSeq: index.lastSeq,
    entryIds: index.entryIds.filter((entryId) => entryId !== id),
  };
  await setLocal<NotepadIndex>(indexKey(profileId), nextIndex);

  return { removed: true };
}

/** Resolve an entry's full text, reading the overflow blob when present. */
async function resolveEntryText(entry: NotepadEntry): Promise<string> {
  if (entry.blobRef) {
    const record = await getBlob(entry.blobRef);
    if (record?.data) {
      return await record.data.text();
    }
    // Blob missing (e.g. partially cleared) — fall back to any inline text.
  }
  return entry.text ?? "";
}

/**
 * Load every {@link NotepadEntry} for the active profile in capture order,
 * resolving any overflowed text from the IndexedDB blob store. Entries missing
 * from storage (e.g. partially cleared) are skipped.
 */
export async function listEntries(): Promise<NotepadEntry[]> {
  const profileId = await requireProfile();
  const index = await readIndex(profileId);

  const entries: NotepadEntry[] = [];
  for (const id of index.entryIds) {
    const entry = await getLocal<NotepadEntry>(entryKey(profileId, id));
    if (!entry) continue;
    const text = await resolveEntryText(entry);
    entries.push({ ...entry, text });
  }
  return entries;
}

/** Read the configured Separator (sync → local), defaulting per Req 5.5. */
async function loadSeparator(profileId: string): Promise<string> {
  const key = separatorKey(profileId);
  try {
    const fromSync = await getSync<SeparatorConfig | string>(key);
    if (fromSync != null) {
      return resolveSeparator(fromSync);
    }
  } catch {
    /* sync unavailable — fall through to local */
  }
  try {
    const fromLocal = await getLocal<SeparatorConfig | string>(key);
    return resolveSeparator(fromLocal ?? null);
  } catch {
    return DEFAULT_SEPARATOR;
  }
}

/**
 * Join all of the active profile's Notepad entries with the configured
 * Separator (Req 6.2). Returns the joined string plus the entry count and an
 * `empty` flag the Copy All tool uses to skip the clipboard write (Req 6.4).
 */
export async function copyAll(): Promise<NotepadCopyAllResult> {
  const profileId = await requireProfile();
  const entries = await listEntries();
  if (entries.length === 0) {
    return { joined: "", count: 0, empty: true };
  }
  const separator = await loadSeparator(profileId);
  const joined = joinEntries(
    entries.map((e) => e.text),
    separator,
  );
  return { joined, count: entries.length, empty: false };
}

/**
 * Result of {@link clearNotepad}: how many entry records and overflow blobs were
 * removed for the active profile.
 */
export interface ClearNotepadResult {
  /** Number of {@link NotepadEntry} records removed. */
  entriesCleared: number;
}

/**
 * Clear every Notepad entry for the active profile (Req 19.6, 21.7).
 *
 * Removes ONLY notepad-scoped data — the ordered {@link NotepadIndex}, each
 * `acx:{profileId}:notepad:entry:{id}` record, and any IndexedDB overflow blob
 * referenced by an entry — and deliberately leaves the rest of the profile's
 * data (settings, separator, search sites, tab folders, toggle) intact. This is
 * the notepad-specific counterpart to `storage.clearAll(profileId)`, which would
 * wipe the entire profile.
 *
 * The index is removed last so an interrupted clear can be safely retried (the
 * index still points at the entries that remain). Missing keys are ignored.
 *
 * @returns the number of entry records that were removed.
 */
export async function clearNotepad(): Promise<ClearNotepadResult> {
  const profileId = await requireProfile();
  const index = await readIndex(profileId);

  let entriesCleared = 0;
  for (const id of index.entryIds) {
    // Delete the overflow blob first (if any) so no orphaned blob is left when
    // the entry record is removed.
    const entry = await getLocal<NotepadEntry>(entryKey(profileId, id));
    if (entry?.blobRef) {
      try {
        await deleteBlob(entry.blobRef);
      } catch {
        /* best-effort: a missing/failed blob delete must not abort the clear */
      }
    }
    try {
      await removeLocal(entryKey(profileId, id));
      entriesCleared += 1;
    } catch {
      /* best-effort per entry */
    }
  }

  // Reset the index last (remove the key so the notepad starts fresh).
  try {
    await removeLocal(indexKey(profileId));
  } catch {
    /* best-effort */
  }

  return { entriesCleared };
}

// ---------------------------------------------------------------------------
// Content-side messaging helper
// ---------------------------------------------------------------------------

/**
 * Send a typed message to the background router and await its `Response`.
 * Wraps `chrome.runtime.sendMessage`'s promise form and normalizes a missing
 * channel / `lastError` into an error `Response`.
 */
function sendToBackground<T, R>(
  type: NotepadMessageType,
  payload: T,
): Promise<Response<R>> {
  const message: Message<T> = createMessage(type, payload);
  return new Promise<Response<R>>((resolve) => {
    try {
      const maybePromise = chrome.runtime.sendMessage(message) as
        | Promise<Response<R>>
        | undefined;
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(
          (response) => resolve(normalizeResponse(response)),
          (error) =>
            resolve({
              ok: false,
              error: makeError(
                ErrorCode.UNKNOWN,
                error instanceof Error ? error.message : String(error),
              ),
            }),
        );
        return;
      }
    } catch (error) {
      resolve({
        ok: false,
        error: makeError(
          ErrorCode.UNKNOWN,
          error instanceof Error ? error.message : String(error),
        ),
      });
      return;
    }
    resolve({
      ok: false,
      error: makeError(ErrorCode.UNKNOWN, "No response from background"),
    });
  });
}

/** Guard against a malformed/empty background response. */
function normalizeResponse<R>(response: Response<R> | undefined): Response<R> {
  if (response && typeof response === "object" && "ok" in response) {
    return response;
  }
  return {
    ok: false,
    error: makeError(ErrorCode.UNKNOWN, "Malformed background response"),
  };
}

// ---------------------------------------------------------------------------
// Copy-event capture (content script) — task 11.4
// ---------------------------------------------------------------------------

/** Disposer returned by {@link initNotepadCapture}. */
export type DetachNotepadCapture = () => void;

/**
 * Read the current document selection text, or `""` when nothing is selected.
 */
function readSelectionText(): string {
  const selection = (globalThis as { getSelection?: () => Selection | null })
    .getSelection?.();
  return selection ? selection.toString() : "";
}

/**
 * Attach the `copy`-event listener that feeds the Notepad (Req 4.1, 4.3).
 *
 * On every copy — only while the Toggle is ON (`getCachedEnabled()`) — the
 * current selection text is sent to the background as `NOTEPAD_APPEND`. The
 * append happens regardless of the originating site (Req 4.3). When the append
 * reports a quota limit, the "storage limit reached" Notification is raised
 * (Req 4.4). Empty selections are ignored (nothing to capture).
 *
 * @param target The event target to listen on. Defaults to `document`.
 * @returns A disposer that removes the listener.
 */
export function initNotepadCapture(
  target: Document = document,
): DetachNotepadCapture {
  const onCopy = (): void => {
    if (!getCachedEnabled()) return;
    const text = readSelectionText();
    if (text.length === 0) return;

    const sourceUrl =
      (globalThis as { location?: Location }).location?.href ?? undefined;
    const payload: NotepadAppendPayload = sourceUrl
      ? { text, sourceUrl }
      : { text };

    void sendToBackground<NotepadAppendPayload, NotepadAppendResult>(
      NotepadMessageType.APPEND,
      payload,
    ).then((response) => {
      if (isOk(response) && response.data.quotaExceeded) {
        notify({
          kind: "error",
          text: "Storage limit reached; some copies may not be saved.",
          code: ErrorCode.QUOTA_EXCEEDED,
        });
      }
    });
  };

  target.addEventListener("copy", onCopy, true);
  return () => target.removeEventListener("copy", onCopy, true);
}

// ---------------------------------------------------------------------------
// Copy All tool (content script) — task 11.7
// ---------------------------------------------------------------------------

/**
 * Perform the Copy All flow in the content (user-gesture) context: ask the
 * background to join all entries, then write the result to the system clipboard.
 *
 * - Empty notepad → "Notepad is empty" Notification, NO clipboard write (Req 6.4).
 * - Success → confirmation Notification (Req 6.3).
 * - Clipboard write failure → failure Notification (Req 6.5).
 */
export async function runCopyAll(): Promise<void> {
  const response = await sendToBackground<undefined, NotepadCopyAllResult>(
    NotepadMessageType.COPY_ALL,
    undefined,
  );

  if (!isOk(response)) {
    notify({
      kind: "error",
      text: "Couldn't read the notepad.",
      code: response.error.code,
    });
    return;
  }

  const { joined, count, empty } = response.data;

  // Empty notepad: notify and DO NOT touch the clipboard (Req 6.4).
  if (empty) {
    notify({ kind: "info", text: "Notepad is empty." });
    return;
  }

  try {
    await navigator.clipboard.writeText(joined);
  } catch {
    notify({
      kind: "error",
      text: "Couldn't copy to the clipboard.",
      code: ErrorCode.CLIPBOARD_FAILED,
    });
    return;
  }

  notify({
    kind: "success",
    text: `Copied ${count} ${count === 1 ? "entry" : "entries"} to the clipboard.`,
  });
}

/**
 * Install the Copy All behavior as the Options_Panel's context-independent
 * "Copy All" tool, replacing its placeholder stub (Req 6.1). Called by the
 * content-script orchestrator (task wiring) alongside {@link initNotepadCapture}.
 *
 * @returns `true` if the tool was registered.
 */
export function registerNotepadTool(): boolean {
  return registerTool(ToolId.NOTEPAD_COPY_ALL, () => runCopyAll());
}
