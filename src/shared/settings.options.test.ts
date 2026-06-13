// Settings persistence integration tests for the Options-page settings layer
// (task 25.3): separator persistence + silent-failure, sync-preference tiering,
// and the <500ms persistence budget (Req 5.3, 5.4, 19.3, 19.6).
//
// These exercise the REAL settings.ts <-> storage.ts <-> identity.ts stack
// against a hand-rolled in-memory `chrome.storage` (separate sync/local tiers +
// `chrome.runtime.lastError`), mirroring the approach in settings.test.ts. No
// module under test is mocked — only the ambient `chrome.*` surface and crypto
// (for the identity UUID) are faked, so the genuine sync-with-local-fallback
// writer and the persistence-failure-silent contract are validated.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadSettings,
  saveSettings,
  saveSeparator,
  saveSyncPreference,
  defaultSettings,
  separatorKey,
  settingsKey,
  type Settings,
} from "./settings";
import { requireProfile, resetIdentityCache } from "./identity";

// ---------------------------------------------------------------------------
// In-memory chrome fake (sync + local tiers, lastError, optional sync-set fail)
// ---------------------------------------------------------------------------

interface ChromeFake {
  sync: Record<string, unknown>;
  local: Record<string, unknown>;
  /** When set, every chrome.storage.sync.set reports this as lastError. */
  failSyncSetWith: string | null;
}

function installChromeFake(): ChromeFake {
  const sync: Record<string, unknown> = {};
  const local: Record<string, unknown> = {};
  const lastError: { value: { message: string } | undefined } = {
    value: undefined,
  };
  const fake = { failSyncSetWith: null as string | null };

  const makeArea = (
    store: Record<string, unknown>,
    kind: "sync" | "local",
  ): chrome.storage.StorageArea =>
    ({
      get: (
        key: string | null,
        cb: (items: Record<string, unknown>) => void,
      ) => {
        lastError.value = undefined;
        if (key === null) {
          cb({ ...store });
          return;
        }
        const out: Record<string, unknown> = {};
        if (key in store) out[key] = store[key];
        cb(out);
      },
      set: (items: Record<string, unknown>, cb: () => void) => {
        if (kind === "sync" && fake.failSyncSetWith) {
          lastError.value = { message: fake.failSyncSetWith };
          cb();
          return;
        }
        lastError.value = undefined;
        Object.assign(store, items);
        cb();
      },
      remove: (keys: string | string[], cb: () => void) => {
        lastError.value = undefined;
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) delete store[k];
        cb();
      },
    }) as unknown as chrome.storage.StorageArea;

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: makeArea(sync, "sync"),
      local: makeArea(local, "local"),
      onChanged: {
        addListener: () => {},
        removeListener: () => {},
      },
    },
    runtime: {
      get lastError() {
        return lastError.value;
      },
    },
  };

  return {
    sync,
    local,
    get failSyncSetWith() {
      return fake.failSyncSetWith;
    },
    set failSyncSetWith(v: string | null) {
      fake.failSyncSetWith = v;
    },
  };
}

function ensureCrypto(): void {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoObj || typeof cryptoObj.randomUUID !== "function") {
    let counter = 0;
    (globalThis as unknown as { crypto: { randomUUID: () => string } }).crypto =
      {
        randomUUID: () =>
          `00000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`,
      };
  }
}

let fake: ChromeFake;

beforeEach(() => {
  ensureCrypto();
  fake = installChromeFake();
  resetIdentityCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

// ---------------------------------------------------------------------------
// Separator persistence (Req 5.3) + mirroring
// ---------------------------------------------------------------------------

describe("saveSeparator persistence (Req 5.3)", () => {
  it("persists the separator and loadSettings reflects it", async () => {
    await saveSeparator({ kind: "custom", custom: " | " });

    const loaded = await loadSettings();
    expect(loaded.separator).toEqual({ kind: "custom", custom: " | " });
  });

  it("mirrors the separator to the dedicated :settings:separator key", async () => {
    const profileId = await requireProfile();
    await saveSeparator({ kind: "dash" });

    expect(fake.sync[separatorKey(profileId)]).toEqual({ kind: "dash" });
  });

  it("round-trips successive separator changes", async () => {
    await saveSeparator({ kind: "slash" });
    await saveSeparator({ kind: "comma" });

    const loaded = await loadSettings();
    expect(loaded.separator).toEqual({ kind: "comma" });
  });
});

// ---------------------------------------------------------------------------
// Sync preference tiering (Req 19.2) — where settings live
// ---------------------------------------------------------------------------

describe("saveSettings honors syncPreference", () => {
  it("'chrome-sync' writes the settings + separator to the sync tier", async () => {
    const profileId = await requireProfile();
    const settings: Settings = {
      ...defaultSettings(),
      syncPreference: "chrome-sync",
      separator: { kind: "dash" },
    };

    await saveSettings(settings);

    expect(fake.sync[settingsKey(profileId)]).toBeDefined();
    expect(fake.sync[separatorKey(profileId)]).toEqual({ kind: "dash" });
    // Nothing was written to local on the happy sync path.
    expect(fake.local[settingsKey(profileId)]).toBeUndefined();
  });

  it("'local-only' writes to local and clears the sync copies", async () => {
    const profileId = await requireProfile();

    // Seed an existing synced copy that local-only must clear.
    await saveSettings({ ...defaultSettings(), syncPreference: "chrome-sync" });
    expect(fake.sync[settingsKey(profileId)]).toBeDefined();

    await saveSyncPreference("local-only");

    // Settings + separator now live in local...
    expect(fake.local[settingsKey(profileId)]).toBeDefined();
    expect(fake.local[separatorKey(profileId)]).toBeDefined();
    // ...and the stale sync copies were removed so they can't shadow local.
    expect(fake.sync[settingsKey(profileId)]).toBeUndefined();
    expect(fake.sync[separatorKey(profileId)]).toBeUndefined();

    // loadSettings reads back the local-only record.
    const loaded = await loadSettings();
    expect(loaded.syncPreference).toBe("local-only");
  });
});

// ---------------------------------------------------------------------------
// Persistence-failure-silent (Req 5.4)
// ---------------------------------------------------------------------------

describe("persistence failure is silent (Req 5.4)", () => {
  it("saveSettings still resolves (falls back to local) when sync.set fails", async () => {
    const profileId = await requireProfile();
    fake.failSyncSetWith = "sync quota exceeded";

    // chrome-sync preference, but sync rejects -> silent fallback to local.
    await expect(
      saveSettings({ ...defaultSettings(), syncPreference: "chrome-sync" }),
    ).resolves.toBeUndefined();

    // The settings landed in the local fallback tier, not sync.
    expect(fake.local[settingsKey(profileId)]).toBeDefined();
    expect(fake.sync[settingsKey(profileId)]).toBeUndefined();
  });

  it("saveSeparator does not throw when sync persistence fails", async () => {
    fake.failSyncSetWith = "sync unavailable";
    await expect(saveSeparator({ kind: "slash" })).resolves.toBeUndefined();

    // The value is still readable via the local fallback.
    const loaded = await loadSettings();
    expect(loaded.separator).toEqual({ kind: "slash" });
  });
});

// ---------------------------------------------------------------------------
// 500ms persistence budget (Req 19.3)
// ---------------------------------------------------------------------------

describe("persistence resolves within the 500ms budget (Req 19.3)", () => {
  it("saveSeparator resolves well under 500ms", async () => {
    vi.useFakeTimers();
    const start = Date.now();

    const promise = saveSeparator({ kind: "comma" });
    await vi.runAllTimersAsync();
    await promise;

    expect(Date.now() - start).toBeLessThan(500);
  });
});
