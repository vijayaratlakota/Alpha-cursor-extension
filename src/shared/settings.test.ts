// Integration tests for Toggle persistence timing + startup restore (task 8.2).
//
// These exercise the real settings.ts <-> storage.ts <-> identity.ts stack
// against a hand-rolled in-memory `chrome.storage` (separate `sync`/`local`
// tiers + `chrome.runtime.lastError` + `chrome.storage.onChanged`). No mocking
// of the modules under test — only the ambient `chrome.*` browser surface is
// faked, so we validate the genuine sync-with-local-fallback writer and the
// cache/restore behavior.
//
// Coverage:
//   - Req 1.4 (persist within 500ms): setEnabled() persists to chrome.storage.sync
//     and getEnabled() reads it back; the write resolves well under 500ms (asserted
//     with fake timers). Sync failure falls back to chrome.storage.local.
//   - Req 1.5 (restore on startup): initializeEnabled() seeds DEFAULT_ENABLED on
//     empty storage and is idempotent; getEnabled() returns the persisted value
//     (restore) and warms getCachedEnabled().

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ENABLED,
  getCachedEnabled,
  getEnabled,
  initializeEnabled,
  onEnabledChanged,
  setEnabled,
} from "./settings";
import { resetIdentityCache } from "./identity";

// ---------------------------------------------------------------------------
// In-memory chrome fake (separate sync + local tiers, onChanged, lastError)
// ---------------------------------------------------------------------------

interface OnChangedListener {
  (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void;
}

interface ChromeFake {
  sync: Record<string, unknown>;
  local: Record<string, unknown>;
  /** When set, the next chrome.storage.sync.set reports this as lastError. */
  failSyncSetWith: string | null;
  /** Manually dispatch a chrome.storage.onChanged event to all listeners. */
  fireChange: (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => void;
  /** Number of onChanged listeners currently registered. */
  changeListenerCount: () => number;
}

function installChromeFake(): ChromeFake {
  const sync: Record<string, unknown> = {};
  const local: Record<string, unknown> = {};
  const lastError: { value: { message: string } | undefined } = {
    value: undefined,
  };
  const changeListeners = new Set<OnChangedListener>();
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
        if (key in store) {
          out[key] = store[key];
        }
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
        addListener: (l: OnChangedListener) => changeListeners.add(l),
        removeListener: (l: OnChangedListener) => changeListeners.delete(l),
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
    fireChange: (changes, areaName) => {
      for (const l of changeListeners) l(changes, areaName);
    },
    changeListenerCount: () => changeListeners.size,
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

// ---------------------------------------------------------------------------

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
// Req 1.4 — persistence timing (sync-first, local fallback)
// ---------------------------------------------------------------------------

describe("setEnabled persistence (Req 1.4)", () => {
  it("persists true to chrome.storage.sync and getEnabled reads it back", async () => {
    await setEnabled(true);

    // The active profile was established by setEnabled; compute its key.
    const key = Object.keys(fake.sync)[0];
    expect(key).toBeDefined();
    expect(key!.endsWith(":settings:enabled")).toBe(true);
    expect(fake.sync[key!]).toBe(true);
    // The enabled flag is not written to the local fallback tier on the happy
    // path (local only holds the identity bootstrap record).
    expect(Object.keys(fake.local).some((k) => k.endsWith(":settings:enabled"))).toBe(false);

    await expect(getEnabled()).resolves.toBe(true);
  });

  it("persists false to chrome.storage.sync and getEnabled reads it back", async () => {
    await setEnabled(false);

    const key = Object.keys(fake.sync)[0]!;
    expect(fake.sync[key]).toBe(false);
    await expect(getEnabled()).resolves.toBe(false);
  });

  it("resolves the write well within the 500ms budget", async () => {
    vi.useFakeTimers();
    const start = Date.now();

    const writePromise = setEnabled(true);
    // Drive any pending timers/microtasks the storage layer may schedule.
    await vi.runAllTimersAsync();
    await writePromise;

    expect(Date.now() - start).toBeLessThan(500);
  });

  it("falls back to chrome.storage.local when sync.set reports lastError", async () => {
    fake.failSyncSetWith = "sync is unavailable";

    await setEnabled(true);

    // Value landed in the local fallback tier under the enabled key, not sync.
    const localKey = Object.keys(fake.local).find((k) =>
      k.endsWith(":settings:enabled"),
    );
    expect(localKey).toBeDefined();
    expect(fake.local[localKey!]).toBe(true);
    expect(Object.keys(fake.sync).some((k) => k.endsWith(":settings:enabled"))).toBe(false);

    // getEnabled() reads back through the same sync->local fallback path.
    await expect(getEnabled()).resolves.toBe(true);
  });

  it("updates the synchronous cache immediately on setEnabled", async () => {
    await setEnabled(false);
    expect(getCachedEnabled()).toBe(false);

    await setEnabled(true);
    expect(getCachedEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Req 1.5 — startup restore + install seeding
// ---------------------------------------------------------------------------

describe("initializeEnabled seeding (Req 1.5)", () => {
  it("persists DEFAULT_ENABLED and returns it on empty storage", async () => {
    const result = await initializeEnabled();

    expect(result).toBe(DEFAULT_ENABLED);
    const key = Object.keys(fake.sync)[0]!;
    expect(fake.sync[key]).toBe(DEFAULT_ENABLED);
  });

  it("is idempotent: does not overwrite an explicitly-set value", async () => {
    // User explicitly turns the Toggle OFF.
    await setEnabled(false);
    const key = Object.keys(fake.sync)[0]!;
    expect(fake.sync[key]).toBe(false);

    // A later install/startup seed must NOT clobber the explicit choice.
    const result = await initializeEnabled();

    expect(result).toBe(false);
    expect(fake.sync[key]).toBe(false);
    await expect(getEnabled()).resolves.toBe(false);
  });
});

describe("startup restore (Req 1.5)", () => {
  it("getEnabled returns the persisted value and warms the cache", async () => {
    // Simulate a value persisted before the (worker) restart.
    await setEnabled(false);

    // New context after restart: identity + settings caches are cold.
    resetIdentityCache();

    const restored = await getEnabled();
    expect(restored).toBe(false);
    // The in-memory cache now reflects the restored value for synchronous gating.
    expect(getCachedEnabled()).toBe(false);
  });

  it("defaults to DEFAULT_ENABLED when nothing was ever persisted", async () => {
    await expect(getEnabled()).resolves.toBe(DEFAULT_ENABLED);
  });
});

// ---------------------------------------------------------------------------
// onEnabledChanged — cross-context reactivity (Req 1.2/1.6, supports restore)
// ---------------------------------------------------------------------------

describe("onEnabledChanged", () => {
  it("fires the callback with the new value and updates the cache", async () => {
    // Establish the active profile + persist a value so we have its scoped key.
    await setEnabled(true);
    const scopedKey = Object.keys(fake.sync)[0]!;
    // Sanity-check the key matches the module's own key builder for the profile.
    expect(scopedKey.endsWith(":settings:enabled")).toBe(true);

    const cb = vi.fn();
    const unsubscribe = onEnabledChanged(cb);

    fake.fireChange(
      { [scopedKey]: { oldValue: true, newValue: false } },
      "sync",
    );

    expect(cb).toHaveBeenCalledWith(false);
    expect(getCachedEnabled()).toBe(false);

    unsubscribe();
    expect(fake.changeListenerCount()).toBe(0);
  });

  it("ignores changes to unrelated keys and areas", async () => {
    await setEnabled(true);
    const scopedKey = Object.keys(fake.sync)[0]!;

    const cb = vi.fn();
    onEnabledChanged(cb);

    // Unrelated key.
    fake.fireChange({ "acx:p:notepad:index": { newValue: 1 } }, "sync");
    // Unrelated area.
    fake.fireChange({ [scopedKey]: { newValue: false } }, "managed");

    expect(cb).not.toHaveBeenCalled();
  });

  it("unsubscribe removes the listener so later changes are ignored", async () => {
    await setEnabled(true);
    const scopedKey = Object.keys(fake.sync)[0]!;

    const cb = vi.fn();
    const unsubscribe = onEnabledChanged(cb);
    unsubscribe();

    fake.fireChange({ [scopedKey]: { newValue: false } }, "sync");
    expect(cb).not.toHaveBeenCalled();
  });
});
