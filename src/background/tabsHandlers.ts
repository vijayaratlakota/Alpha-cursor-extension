// Background handlers for Tool 2 (Save All Tabs, Req 7) and Tool 3 (Restore
// Saved Tabs, Req 8) — task 12.3 / 12.5.
//
// The service worker owns `chrome.tabs.*` because content scripts cannot
// enumerate or create tabs across the window. These handlers register on the
// shared background router and compose the PURE helpers in
// `src/tools/tabs/tabFolders.ts` (`validateFolderName`, `partitionOpenableUrls`)
// with the profile-scoped storage layer.
//
// Messages (all flow through `installRouter`'s `chrome.runtime.onMessage`):
//   - TABS_SAVE   { name, overwrite? } -> TabsSaveResult
//   - TABS_LIST                        -> TabFolderSummary[]
//   - TABS_DELETE { folderId }         -> { deleted: boolean }
//   - TABS_RESTORE{ folderId }         -> { openedCount, failedCount }
//
// Data model (design "Data Models > Tab Folders"):
//   TabFolder { id; name; tabs: { url; title }[]; savedAt }
// The whole folder list for a profile is stored under a single scoped key
// (`acx:{profileId}:tabfolders`) so it can be read/written atomically and
// cleared in bulk by `storage.clearAll` (Property 20).
//
// Design references: "Tool 2 — Save All Tabs (Req 7) & Tool 3 — Restore Saved
// Tabs (Req 8)", "Error Handling".

import { registerHandler } from "./router";
import {
  StorageDomain,
  getLocal,
  scopedKey,
  setLocal,
} from "@/shared/storage";
import { requireProfile, withProfile } from "@/shared/identity";
import { ErrorCode, makeError } from "@/shared/messaging";
import {
  partitionOpenableUrls,
  validateFolderName,
  FolderNameError,
  MAX_FOLDER_NAME_LENGTH,
} from "@/tools/tabs/tabFolders";

// ---------------------------------------------------------------------------
// Message types + payload / result shapes
// ---------------------------------------------------------------------------

/** Message type strings for the tab save/restore handlers. */
export const TabsMessageType = {
  /** Save all tabs in the current window: payload {@link TabsSavePayload}. */
  SAVE: "TABS_SAVE",
  /** List saved tab folders: returns {@link TabFolderSummary}[]. */
  LIST: "TABS_LIST",
  /** Delete a saved tab folder: payload {@link TabsDeletePayload}. */
  DELETE: "TABS_DELETE",
  /** Restore (open) a saved tab folder: payload {@link TabsRestorePayload}. */
  RESTORE: "TABS_RESTORE",
} as const;

/** A single saved tab snapshot (design "Data Models > Tab Folders"). */
export interface SavedTab {
  url: string;
  title: string;
}

/** A named collection of saved tabs scoped to the active local profile. */
export interface TabFolder {
  id: string;
  name: string;
  tabs: SavedTab[];
  savedAt: number;
}

/** Payload for {@link TabsMessageType.SAVE}. */
export interface TabsSavePayload {
  /** Proposed folder name (validated server-side via {@link validateFolderName}). */
  name: string;
  /**
   * When `true`, replace an existing folder of the same name instead of
   * reporting a collision. The UI sets this after the user confirms overwrite
   * (Req 7.4).
   */
  overwrite?: boolean;
}

/**
 * Result of a save attempt. `saved: false, reason: "name_exists"` is an
 * EXPECTED outcome (not an error) so the UI can offer overwrite vs rename
 * (Req 7.4); genuine failures (no tabs, invalid name) reject with an `AppError`.
 */
export type TabsSaveResult =
  | { saved: true; folderId: string; name: string; savedCount: number }
  | { saved: false; reason: "name_exists"; name: string };

/** Compact folder descriptor returned by {@link TabsMessageType.LIST}. */
export interface TabFolderSummary {
  id: string;
  name: string;
  count: number;
  savedAt: number;
}

/** Payload for {@link TabsMessageType.DELETE}. */
export interface TabsDeletePayload {
  folderId: string;
}

/** Payload for {@link TabsMessageType.RESTORE}. */
export interface TabsRestorePayload {
  folderId: string;
}

/** Result of a restore attempt (Req 8.5 reports the failed count). */
export interface TabsRestoreResult {
  openedCount: number;
  failedCount: number;
}

// ---------------------------------------------------------------------------
// Storage helpers (profile-scoped folder list)
// ---------------------------------------------------------------------------

/** Scoped key holding the whole folder list: `acx:{profileId}:tabfolders`. */
function foldersKey(profileId: string): string {
  return scopedKey(profileId, StorageDomain.TAB_FOLDERS);
}

/** Read the saved folder list for a profile (empty array when none stored). */
async function loadFolders(profileId: string): Promise<TabFolder[]> {
  const folders = await getLocal<TabFolder[]>(foldersKey(profileId));
  return Array.isArray(folders) ? folders : [];
}

/** Persist the folder list for a profile. */
async function saveFolders(
  profileId: string,
  folders: TabFolder[],
): Promise<void> {
  await setLocal<TabFolder[]>(foldersKey(profileId), folders);
}

/** Generate a stable folder id using the platform crypto (every MV3 context). */
function generateFolderId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Map a validated folder-name rejection reason to a user-facing message. */
function folderNameErrorMessage(reason: FolderNameError): string {
  switch (reason) {
    case FolderNameError.EMPTY:
      return "Enter a name for the tab folder.";
    case FolderNameError.TOO_LONG:
      return `Folder name must be ${MAX_FOLDER_NAME_LENGTH} characters or fewer.`;
    default:
      return "Invalid folder name.";
  }
}

// ---------------------------------------------------------------------------
// Tab enumeration / creation (wrapped for promise + error normalization)
// ---------------------------------------------------------------------------

/** Enumerate the current window's tabs as `{ url, title }` snapshots in order. */
async function queryCurrentWindowTabs(): Promise<SavedTab[]> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  // Snapshot fidelity (Property 8): keep exactly these pairs, in this order.
  return tabs.map((tab) => ({ url: tab.url ?? "", title: tab.title ?? "" }));
}

/** Open a single URL in a new tab; resolves `true` on success, `false` on failure. */
async function openTab(url: string): Promise<boolean> {
  try {
    await chrome.tabs.create({ url });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

/**
 * TABS_SAVE — enumerate the current window's tabs and persist them as a named
 * `TabFolder` scoped to the active profile (Req 7.1–7.3, 7.6, 7.7).
 *
 * - Rejects with `NO_TABS` when the window has no tabs (Req 7.5).
 * - Returns `{ saved: false, reason: "name_exists" }` on a name collision when
 *   `overwrite` is not set, so the UI can offer overwrite vs rename (Req 7.4).
 * - On success returns `{ saved: true, folderId, name, savedCount }` (Req 7.6).
 */
export async function handleTabsSave(
  payload: TabsSavePayload,
): Promise<TabsSaveResult> {
  const validation = validateFolderName(payload?.name ?? "");
  if (!validation.valid) {
    throw makeError(
      ErrorCode.UNKNOWN,
      folderNameErrorMessage(validation.reason),
    );
  }
  const name = validation.name;

  // Req 7.5 — nothing to save: notify and create no folder.
  const tabs = await queryCurrentWindowTabs();
  if (tabs.length === 0) {
    throw makeError(ErrorCode.NO_TABS, "There are no tabs to save.");
  }

  return withProfile(async (profileId) => {
    const folders = await loadFolders(profileId);
    const existingIndex = folders.findIndex((folder) => folder.name === name);

    // Req 7.4 — collision without explicit overwrite: report it (not an error).
    if (existingIndex !== -1 && payload.overwrite !== true) {
      return { saved: false, reason: "name_exists", name };
    }

    const savedAt = Date.now();
    if (existingIndex !== -1) {
      // Overwrite: keep the existing id, replace the snapshot.
      const existing = folders[existingIndex]!;
      const updated: TabFolder = { ...existing, name, tabs, savedAt };
      folders[existingIndex] = updated;
      await saveFolders(profileId, folders);
      return {
        saved: true,
        folderId: updated.id,
        name,
        savedCount: tabs.length,
      };
    }

    const folder: TabFolder = {
      id: generateFolderId(),
      name,
      tabs,
      savedAt,
    };
    folders.push(folder);
    await saveFolders(profileId, folders);
    return {
      saved: true,
      folderId: folder.id,
      name,
      savedCount: tabs.length,
    };
  });
}

/** TABS_LIST — return compact summaries of the active profile's tab folders. */
export async function handleTabsList(): Promise<TabFolderSummary[]> {
  const profileId = await requireProfile();
  const folders = await loadFolders(profileId);
  return folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    count: folder.tabs.length,
    savedAt: folder.savedAt,
  }));
}

/** TABS_DELETE — remove a saved tab folder by id (Req 8.6). */
export async function handleTabsDelete(
  payload: TabsDeletePayload,
): Promise<{ deleted: boolean }> {
  return withProfile(async (profileId) => {
    const folders = await loadFolders(profileId);
    const next = folders.filter((folder) => folder.id !== payload?.folderId);
    const deleted = next.length !== folders.length;
    if (deleted) {
      await saveFolders(profileId, next);
    }
    return { deleted };
  });
}

/**
 * TABS_RESTORE — open the openable URLs of a saved folder (Req 8.3–8.5).
 *
 * - Rejects with `NO_OPENABLE_URLS` and opens NOTHING when the folder has no
 *   openable URLs (empty or all-invalid) (Req 8.4).
 * - Otherwise opens each openable URL, counting failures as the invalid URLs
 *   plus any `chrome.tabs.create` errors, and reports the failed count
 *   (Req 8.5).
 */
export async function handleTabsRestore(
  payload: TabsRestorePayload,
): Promise<TabsRestoreResult> {
  const profileId = await requireProfile();
  const folders = await loadFolders(profileId);
  const folder = folders.find((f) => f.id === payload?.folderId);
  if (!folder) {
    throw makeError(ErrorCode.UNKNOWN, "That tab folder no longer exists.");
  }

  const urls = folder.tabs.map((tab) => tab.url);
  const { openable, invalid } = partitionOpenableUrls(urls);

  // Req 8.4 — nothing can be opened: notify and open no tabs.
  if (openable.length === 0) {
    throw makeError(
      ErrorCode.NO_OPENABLE_URLS,
      "No tabs could be opened from this folder.",
    );
  }

  let openedCount = 0;
  let createFailures = 0;
  for (const url of openable) {
    if (await openTab(url)) {
      openedCount += 1;
    } else {
      createFailures += 1;
    }
  }

  // Req 8.5 — failed count = non-openable URLs + tabs that failed to open.
  return { openedCount, failedCount: invalid.length + createFailures };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the tab save/restore/list/delete handlers on the background router.
 * Idempotent (`registerHandler` overwrites prior registrations), so it is safe
 * to call on every service-worker wake. Wired from `src/background/index.ts`.
 */
export function installTabs(): void {
  registerHandler<TabsSavePayload, TabsSaveResult>(
    TabsMessageType.SAVE,
    (payload) => handleTabsSave(payload),
  );
  registerHandler<void, TabFolderSummary[]>(TabsMessageType.LIST, () =>
    handleTabsList(),
  );
  registerHandler<TabsDeletePayload, { deleted: boolean }>(
    TabsMessageType.DELETE,
    (payload) => handleTabsDelete(payload),
  );
  registerHandler<TabsRestorePayload, TabsRestoreResult>(
    TabsMessageType.RESTORE,
    (payload) => handleTabsRestore(payload),
  );
}
