// Settings + global ON/OFF Toggle module for Alpha Cursor (task 8.1).
//
// This module owns the single source of truth for the global Toggle
// (`settings.enabled`, Req 1) and the building blocks every context uses to
// read, persist, and react to it:
//   - `getEnabled()`    — read the persisted Toggle state (sync, fallback local)
//   - `setEnabled()`    — persist the Toggle state (sync, fallback local) (Req 1.4)
//   - `onEnabledChanged()` — subscribe to cross-context changes so all tabs react
//                            within one event loop via `chrome.storage.onChanged`
//   - `initializeEnabled()` — seed the default on install (Req 1.5)
//
// Per the design ("Cross-Cutting: Toggle" + "Data Models > Settings"), the
// Toggle lives in `chrome.storage.sync` so it follows the user's Chrome profile
// sync, and falls back to `chrome.storage.local` when sync is unavailable. The
// value is stored under a profile-scoped settings key
// (`acx:{localProfileId}:settings:enabled`) so it participates in per-profile
// isolation (Property 19) and bulk clear (Property 20).
//
// SCOPE NOTE (task 8.1 vs 25.1): The full `Settings` object (separator, search
// sites, sync preference, …) is fleshed out by the Options page task (25.1).
// This task implements ONLY the `enabled` flag end-to-end; the remaining fields
// are declared on the `Settings` interface as optional and clearly marked so
// 25.1 can complete them without reshaping the type.
//
// Content-script intent (Req 1.2, 1.6): content scripts call `getEnabled()` on
// load and subscribe via `onEnabledChanged()`. When the value flips to OFF they
// remove their middle-click handler (so default browser paste/scroll proceeds)
// and disable cookie-consent removal. The content script itself is built in a
// later task (10+); this module exposes the API and an `isEnabled` cache it
// will use to gate those behaviors synchronously.

import {
  KEY_NAMESPACE,
  KEY_SEPARATOR,
  StorageDomain,
  getLocal,
  getSync,
  removeSync,
  scopedKey,
  setLocal,
  setSync,
} from "./storage";
import { ensureLocalProfile, getActiveProfileId, requireProfile } from "./identity";

// ---------------------------------------------------------------------------
// Settings model
// ---------------------------------------------------------------------------

/** Separator config (Req 5). Fleshed out by the Options page task (25.1). */
export interface SeparatorConfig {
  kind: "comma" | "dash" | "slash" | "custom";
  custom?: string;
}

/** A configured "Search in" site (Req 12). Completed by task 25.1. */
export interface SearchSite {
  id: string;
  label: string;
  urlTemplate: string; // contains the {q} placeholder
  order: number;
}

/**
 * The Settings record stored in `chrome.storage.sync` (fallback `local`).
 *
 * Only `schemaVersion` and `enabled` are implemented in task 8.1. The remaining
 * fields are declared optional here and OWNED BY TASK 25.1 (Options page); they
 * are intentionally not read/written by this module yet.
 */
export interface Settings {
  /** Storage schema version, for future migrations. */
  schemaVersion: number;
  /** Global ON/OFF Toggle (Req 1). The only field implemented in task 8.1. */
  enabled: boolean;
  /** Req 5 — TODO(task 25.1). */
  separator?: SeparatorConfig;
  /** Req 12 (ordered) — TODO(task 25.1). */
  searchSites?: SearchSite[];
  /** Req 19.2 (reinterpreted; no custom server) — TODO(task 25.1). */
  syncPreference?: "chrome-sync" | "local-only";
}

/** Current settings schema version. */
export const SETTINGS_SCHEMA_VERSION = 1;

/**
 * Default Toggle state on first install. Chosen as `true` so the extension is
 * active immediately after install (the radial Options_Panel works out of the
 * box). Users can turn it OFF from the popup at any time (Req 1.1).
 */
export const DEFAULT_ENABLED = true;

/** Message types for the Toggle handlers registered in the background router. */
export const ToggleMessageType = {
  /** Read the current Toggle state: `Response<ToggleState>`. */
  GET: "TOGGLE_GET",
  /** Set the Toggle state: payload `{ enabled }`, `Response<ToggleState>`. */
  SET: "TOGGLE_SET",
} as const;

/** The shape returned by `TOGGLE_GET` / `TOGGLE_SET`. */
export interface ToggleState {
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Scoped key helpers
// ---------------------------------------------------------------------------

/** Profile-scoped key holding the Toggle flag: `acx:{profileId}:settings:enabled`. */
export function enabledKey(profileId: string): string {
  return scopedKey(profileId, StorageDomain.SETTINGS, "enabled");
}

/**
 * Profile-scoped key holding the full {@link Settings} record:
 * `acx:{profileId}:settings:settings`. This is the key `searchTool.ts` reads to
 * resolve the configured "Search in" sites, so the Options page persists the
 * whole Settings object here (Req 12.6, 19.2).
 */
export function settingsKey(profileId: string): string {
  return scopedKey(profileId, StorageDomain.SETTINGS, "settings");
}

/**
 * Profile-scoped key holding ONLY the resolved separator config:
 * `acx:{profileId}:settings:separator`. The Notepad's `loadSeparator`
 * (`notepad.ts`) reads this key directly, so the Options page mirrors the
 * separator here in addition to the full Settings object — see
 * {@link saveSettings} for the consistency contract.
 */
export function separatorKey(profileId: string): string {
  return scopedKey(profileId, StorageDomain.SETTINGS, "separator");
}

/**
 * Suffix every Toggle key ends with (`:settings:enabled`). Used by
 * `onEnabledChanged` to recognize relevant `chrome.storage.onChanged` entries
 * without needing the profile id resolved synchronously. Because there is
 * exactly one `localProfileId` per browser profile, suffix matching uniquely
 * identifies the active profile's Toggle key.
 */
const ENABLED_KEY_SUFFIX = `${KEY_SEPARATOR}${StorageDomain.SETTINGS}${KEY_SEPARATOR}enabled`;
const KEY_PREFIX = `${KEY_NAMESPACE}${KEY_SEPARATOR}`;

/** True when `key` is an Alpha Cursor profile-scoped Toggle (`enabled`) key. */
function isEnabledKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX) && key.endsWith(ENABLED_KEY_SUFFIX);
}

// ---------------------------------------------------------------------------
// In-memory cache (content-script gating, Req 1.2/1.6)
// ---------------------------------------------------------------------------

/**
 * Last known Toggle state, cached for synchronous gating. `null` until the
 * first `getEnabled()` / `initializeEnabled()` resolves or an `onChanged` event
 * arrives in this context.
 */
let cachedEnabled: boolean | null = null;

/**
 * Synchronously return the last known Toggle state, defaulting to
 * {@link DEFAULT_ENABLED} until a value has been loaded. Content scripts use
 * this to decide whether to run the middle-click handler / cookie removal
 * without awaiting storage on every interaction.
 */
export function getCachedEnabled(): boolean {
  return cachedEnabled ?? DEFAULT_ENABLED;
}

/** Read the Toggle value from sync, falling back to local. */
async function readEnabledValue(key: string): Promise<boolean | undefined> {
  try {
    const fromSync = await getSync<boolean>(key);
    if (typeof fromSync === "boolean") {
      return fromSync;
    }
    // Absent in sync — it may have been written to the local fallback tier.
    const fromLocal = await getLocal<boolean>(key);
    return typeof fromLocal === "boolean" ? fromLocal : undefined;
  } catch {
    // sync unavailable — fall back to local.
    try {
      const fromLocal = await getLocal<boolean>(key);
      return typeof fromLocal === "boolean" ? fromLocal : undefined;
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the persisted Toggle state. Reads from `chrome.storage.sync` and falls
 * back to `chrome.storage.local` if sync is unavailable or the value is absent;
 * defaults to {@link DEFAULT_ENABLED} when nothing is persisted yet. Updates the
 * in-memory cache as a side effect (Req 1.1, 1.5).
 */
export async function getEnabled(): Promise<boolean> {
  const profileId = await requireProfile();
  const value = await readEnabledValue(enabledKey(profileId));
  const enabled = typeof value === "boolean" ? value : DEFAULT_ENABLED;
  cachedEnabled = enabled;
  return enabled;
}

/**
 * Persist a new Toggle state. Writes to `chrome.storage.sync`, falling back to
 * `chrome.storage.local` if sync rejects. `chrome.storage` writes resolve well
 * within the 500ms budget (Req 1.4). Updates the cache immediately so callers in
 * this context see the new value without a round-trip.
 */
export async function setEnabled(enabled: boolean): Promise<void> {
  const profileId = await requireProfile();
  const key = enabledKey(profileId);
  cachedEnabled = enabled;
  try {
    await setSync<boolean>(key, enabled);
  } catch {
    await setLocal<boolean>(key, enabled);
  }
}

/**
 * Seed the Toggle on first install (Req 1.5): if a value is already persisted,
 * cache and return it; otherwise persist {@link DEFAULT_ENABLED}. Idempotent, so
 * it is safe to call from both `onInstalled` and `onStartup`.
 */
export async function initializeEnabled(): Promise<boolean> {
  const profileId = await requireProfile();
  const existing = await readEnabledValue(enabledKey(profileId));
  if (typeof existing === "boolean") {
    cachedEnabled = existing;
    return existing;
  }
  await setEnabled(DEFAULT_ENABLED);
  return DEFAULT_ENABLED;
}

/**
 * Subscribe to Toggle changes across contexts. Wraps
 * `chrome.storage.onChanged` and invokes `cb` with the new boolean whenever the
 * active profile's `enabled` value changes in either the `sync` or `local`
 * tier. All tabs share Chrome's storage event, so every content script reacts
 * within one event loop (Req 1.2, 1.6). The cache is refreshed before `cb`
 * fires. Returns an unsubscribe function.
 */
export function onEnabledChanged(cb: (enabled: boolean) => void): () => void {
  // Warm the cache/profile in the background so a missing-newValue change (a
  // removal) can be reconciled, but never block listener registration on it.
  void ensureLocalProfile().catch(() => {
    /* identity errors surface elsewhere; the listener still works via suffix match */
  });

  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "sync" && areaName !== "local") {
      return;
    }
    for (const [key, change] of Object.entries(changes)) {
      if (!isEnabledKey(key)) {
        continue;
      }
      const next =
        typeof change.newValue === "boolean" ? change.newValue : DEFAULT_ENABLED;
      cachedEnabled = next;
      cb(next);
    }
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * Resolve the active profile's Toggle key if the profile is already known in
 * this context (synchronous, non-creating). Exposed for callers that want to
 * scope a manual `chrome.storage.onChanged` comparison; returns `null` until
 * `ensureLocalProfile()` has resolved here.
 */
export function activeEnabledKey(): string | null {
  const profileId = getActiveProfileId();
  return profileId ? enabledKey(profileId) : null;
}

// ---------------------------------------------------------------------------
// Full Settings persistence (Options page — task 25.1)
// ---------------------------------------------------------------------------
//
// CONSISTENCY CONTRACT
// --------------------
// Two consumers read settings written by the Options page, and they read from
// DIFFERENT keys:
//   - `searchTool.ts` reads the FULL `Settings` object at `:settings:settings`
//     (sync, falling back to local) to resolve `searchSites`.
//   - `notepad.ts` (`loadSeparator`) reads ONLY the resolved separator at
//     `:settings:separator` (sync, falling back to local).
//
// To keep both consumers correct, {@link saveSettings} writes BOTH keys:
//   1. the full `Settings` record at `:settings:settings`, and
//   2. the `separator` config mirrored to `:settings:separator`.
//
// The `syncPreference` field decides WHERE settings live:
//   - "chrome-sync"  -> `chrome.storage.sync`  (follows the user's Chrome sync)
//   - "local-only"   -> `chrome.storage.local` (never leaves the device)
// Neither contacts any server — "sync" is Chrome's built-in `storage.sync`.
// When writing local-only we also clear the sync copies so a stale synced value
// can't shadow the local-only one on read, and vice versa.

/** Default sync preference: follow the user's Chrome profile sync (Req 19.2). */
export const DEFAULT_SYNC_PREFERENCE: "chrome-sync" | "local-only" = "chrome-sync";

/** Default separator config (comma) — mirrors Req 5.5 / `DEFAULT_SEPARATOR`. */
export const DEFAULT_SEPARATOR_CONFIG: SeparatorConfig = { kind: "comma" };

/** A fully-defaulted {@link Settings} record used when nothing is persisted. */
export function defaultSettings(): Settings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    enabled: DEFAULT_ENABLED,
    separator: { ...DEFAULT_SEPARATOR_CONFIG },
    searchSites: [],
    syncPreference: DEFAULT_SYNC_PREFERENCE,
  };
}

/**
 * Read the persisted full {@link Settings} record for the active profile. Reads
 * from `chrome.storage.sync` first, then falls back to `chrome.storage.local`
 * (matching how `searchTool.ts` resolves the same key). Missing fields are
 * back-filled from {@link defaultSettings} so callers always receive a complete
 * record; the persisted `enabled` flag is reconciled with the dedicated Toggle
 * key so the Options page reflects the live Toggle state (Req 19.4).
 */
export async function loadSettings(): Promise<Settings> {
  const profileId = await requireProfile();
  const key = settingsKey(profileId);

  let stored: Partial<Settings> | undefined;
  try {
    stored = await getSync<Settings>(key);
    if (!stored) {
      stored = await getLocal<Settings>(key);
    }
  } catch {
    try {
      stored = await getLocal<Settings>(key);
    } catch {
      stored = undefined;
    }
  }

  const base = defaultSettings();
  const merged: Settings = {
    ...base,
    ...(stored ?? {}),
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };

  // The Toggle has its own authoritative key (`:settings:enabled`); reconcile so
  // the Options page shows the current state even if the full record is stale.
  const liveEnabled = await readEnabledValue(enabledKey(profileId));
  if (typeof liveEnabled === "boolean") {
    merged.enabled = liveEnabled;
  }

  return merged;
}

/**
 * Persist the full {@link Settings} record for the active profile (Req 5.3,
 * 12.6, 19.2, 19.3). Honors {@link Settings.syncPreference} to choose the
 * storage tier and mirrors the separator to the dedicated `:settings:separator`
 * key the Notepad reads (see the CONSISTENCY CONTRACT above).
 *
 * Writes resolve well within the 500ms budget (Req 19.3). The Toggle `enabled`
 * flag is intentionally NOT written here — it is owned by {@link setEnabled} so
 * the dedicated key stays the single source of truth — but it is persisted in
 * the full record for completeness.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const profileId = await requireProfile();
  const record: Settings = {
    ...settings,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };

  const preference = record.syncPreference ?? DEFAULT_SYNC_PREFERENCE;
  const sKey = settingsKey(profileId);
  const sepKey = separatorKey(profileId);
  const separator = record.separator ?? { ...DEFAULT_SEPARATOR_CONFIG };

  if (preference === "local-only") {
    // Write local; clear any synced copy so it can't shadow the local value.
    await setLocal<Settings>(sKey, record);
    await setLocal<SeparatorConfig>(sepKey, separator);
    await removeSync([sKey, sepKey]).catch(() => {
      /* best-effort: sync may be unavailable; persistence-failure is silent */
    });
  } else {
    // Write sync, falling back to local when sync is unavailable.
    try {
      await setSync<Settings>(sKey, record);
      await setSync<SeparatorConfig>(sepKey, separator);
    } catch {
      await setLocal<Settings>(sKey, record);
      await setLocal<SeparatorConfig>(sepKey, separator);
    }
  }
}

/**
 * Persist only the {@link SeparatorConfig}, leaving the rest of the stored
 * {@link Settings} record untouched (Req 5.3). Convenience wrapper used by the
 * Options page separator control; reads the current record, updates the
 * `separator` field, and re-persists via {@link saveSettings} so the dedicated
 * `:settings:separator` key stays mirrored.
 */
export async function saveSeparator(separator: SeparatorConfig): Promise<void> {
  const current = await loadSettings();
  await saveSettings({ ...current, separator });
}

/**
 * Persist only the ordered {@link SearchSite} list (Req 12.6). Reads the current
 * record, replaces `searchSites`, and re-persists.
 */
export async function saveSearchSites(searchSites: SearchSite[]): Promise<void> {
  const current = await loadSettings();
  await saveSettings({ ...current, searchSites });
}

/**
 * Persist the sync preference (Req 19.2) and migrate the existing settings to
 * the chosen tier. Because {@link saveSettings} honors the preference when
 * choosing where to write (and clears the other tier for `local-only`), this
 * effectively moves the settings to the selected storage area.
 */
export async function saveSyncPreference(
  syncPreference: "chrome-sync" | "local-only",
): Promise<void> {
  const current = await loadSettings();
  await saveSettings({ ...current, syncPreference });
}

// ---------------------------------------------------------------------------
// Per-feature flags (automatic content features)
// ---------------------------------------------------------------------------
//
// The global Toggle (`enabled`) is the master switch. ON TOP of it, the user
// can individually enable/disable each AUTOMATIC content feature — the ones
// that act without an explicit click — from the Options page. All default ON so
// the extension works out of the box right after install; users who don't want
// a given behavior (e.g. drag-to-copy) can turn just that one off.
//
// Flags live at `acx:{profileId}:settings:features` in `chrome.storage.sync`
// (fallback `local`) and are cached for synchronous content-script gating, the
// same pattern as the `enabled` Toggle.

/** Toggleable automatic features (each gated UNDER the global Toggle). */
export interface FeatureFlags {
  /** Copy highlighted text to the clipboard + notepad on left-drag release. */
  dragCopy: boolean;
  /** Keep a green highlight on drag-copied text until the page is refreshed. */
  persistHighlight: boolean;
  /** Save every Ctrl+C / copy into the notepad history. */
  notepadCapture: boolean;
  /** Also save OCR-extracted text into the notepad history. */
  ocrToNotepad: boolean;
  /** Automatically remove cookie-consent popups on page load. */
  cookieRemoval: boolean;
}

/** Stable ordered keys for rendering the feature toggles in the Options page. */
export const FEATURE_FLAG_KEYS: (keyof FeatureFlags)[] = [
  "dragCopy",
  "persistHighlight",
  "notepadCapture",
  "ocrToNotepad",
  "cookieRemoval",
];

/** Every automatic feature defaults ON (works immediately after install). */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  dragCopy: true,
  persistHighlight: true,
  notepadCapture: true,
  ocrToNotepad: true,
  cookieRemoval: true,
};

/** Profile-scoped key holding the {@link FeatureFlags}: `…:settings:features`. */
export function featureFlagsKey(profileId: string): string {
  return scopedKey(profileId, StorageDomain.SETTINGS, "features");
}

const FEATURES_KEY_SUFFIX = `${KEY_SEPARATOR}${StorageDomain.SETTINGS}${KEY_SEPARATOR}features`;

/** True when `key` is an Alpha Cursor profile-scoped feature-flags key. */
function isFeatureFlagsKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX) && key.endsWith(FEATURES_KEY_SUFFIX);
}

/** Last known feature flags, cached for synchronous content-script gating. */
let cachedFlags: FeatureFlags | null = null;

/** Back-fill any missing flag from the defaults so callers get a full record. */
function normalizeFlags(stored: Partial<FeatureFlags> | undefined): FeatureFlags {
  return { ...DEFAULT_FEATURE_FLAGS, ...(stored ?? {}) };
}

/**
 * Synchronously return the last known feature flags, defaulting to
 * {@link DEFAULT_FEATURE_FLAGS} (all ON) until a value has been loaded. Content
 * features use this to gate themselves without awaiting storage.
 */
export function getCachedFeatureFlags(): FeatureFlags {
  return cachedFlags ?? { ...DEFAULT_FEATURE_FLAGS };
}

/** Read the feature flags from sync, falling back to local. */
async function readFlagsValue(
  key: string,
): Promise<Partial<FeatureFlags> | undefined> {
  try {
    const fromSync = await getSync<Partial<FeatureFlags>>(key);
    if (fromSync && typeof fromSync === "object") return fromSync;
    const fromLocal = await getLocal<Partial<FeatureFlags>>(key);
    return fromLocal && typeof fromLocal === "object" ? fromLocal : undefined;
  } catch {
    try {
      const fromLocal = await getLocal<Partial<FeatureFlags>>(key);
      return fromLocal && typeof fromLocal === "object" ? fromLocal : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Read the persisted feature flags (all-on default), updating the cache. */
export async function getFeatureFlags(): Promise<FeatureFlags> {
  const profileId = await requireProfile();
  const stored = await readFlagsValue(featureFlagsKey(profileId));
  const flags = normalizeFlags(stored);
  cachedFlags = flags;
  return flags;
}

/** Persist a single feature flag, leaving the others untouched (Req 19.3). */
export async function setFeatureFlag(
  key: keyof FeatureFlags,
  value: boolean,
): Promise<void> {
  const profileId = await requireProfile();
  const current = await getFeatureFlags();
  const next: FeatureFlags = { ...current, [key]: value };
  cachedFlags = next;
  const storageKey = featureFlagsKey(profileId);
  try {
    await setSync<FeatureFlags>(storageKey, next);
  } catch {
    await setLocal<FeatureFlags>(storageKey, next);
  }
}

/**
 * Subscribe to feature-flag changes across contexts (mirrors
 * {@link onEnabledChanged}). The cache is refreshed before `cb` fires. Returns
 * an unsubscribe function.
 */
export function onFeatureFlagsChanged(
  cb: (flags: FeatureFlags) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "sync" && areaName !== "local") return;
    for (const [key, change] of Object.entries(changes)) {
      if (!isFeatureFlagsKey(key)) continue;
      const next = normalizeFlags(
        (change.newValue as Partial<FeatureFlags> | undefined) ?? undefined,
      );
      cachedFlags = next;
      cb(next);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
