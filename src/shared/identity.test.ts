import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IDENTITY_BOOTSTRAP_KEY,
  LocalIdentity,
  ensureLocalProfile,
  getActiveProfileId,
  requireProfile,
  resetIdentityCache,
  withProfile,
} from "./identity";
import { ErrorCode } from "./messaging";

// Unit tests for local identity creation and write-gating (task 4.5).
//
// Covers:
//   - First-run creation (Req 3.4): empty storage -> mint + persist a
//     LocalIdentity at IDENTITY_BOOTSTRAP_KEY and expose it synchronously.
//   - Existing-profile read: never overwrite an already-stored identity.
//   - Concurrency: racing callers collapse onto one mint + one persist.
//   - Write-blocking on failure (Req 3.5): a failed persist rejects with an
//     IDENTITY_FAILED AppError, withProfile() never runs `fn`, and a later call
//     can retry because the in-flight promise is cleared.
//
// `chrome.storage.local` is replaced with a hand-rolled in-memory fake assigned
// to `globalThis.chrome` so we exercise the real storage.ts wrapper (including
// its `chrome.runtime.lastError` handling) without a real browser.

// ---------------------------------------------------------------------------
// In-memory chrome.storage.local fake
// ---------------------------------------------------------------------------

interface FakeStore {
  data: Record<string, unknown>;
  /** When set, the next set() (or all sets) reports this as runtime.lastError. */
  failSetWith: string | null;
}

function installChromeFake(): FakeStore {
  const store: FakeStore = { data: {}, failSetWith: null };
  const lastError: { value: { message: string } | undefined } = {
    value: undefined,
  };

  const local = {
    get: (
      key: string | null,
      cb: (items: Record<string, unknown>) => void,
    ) => {
      lastError.value = undefined;
      if (key === null) {
        cb({ ...store.data });
        return;
      }
      const out: Record<string, unknown> = {};
      if (key in store.data) {
        out[key] = store.data[key];
      }
      cb(out);
    },
    set: (items: Record<string, unknown>, cb: () => void) => {
      if (store.failSetWith) {
        lastError.value = { message: store.failSetWith };
        cb();
        return;
      }
      lastError.value = undefined;
      Object.assign(store.data, items);
      cb();
    },
    remove: (keys: string | string[], cb: () => void) => {
      lastError.value = undefined;
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete store.data[k];
      cb();
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local, sync: local },
    runtime: {
      // storage.ts reads `chrome.runtime.lastError` after each callback.
      get lastError() {
        return lastError.value;
      },
    },
  };

  return store;
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

let store: FakeStore;

beforeEach(() => {
  ensureCrypto();
  store = installChromeFake();
  resetIdentityCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureLocalProfile - first-run creation (Req 3.4)", () => {
  it("mints and persists a LocalIdentity when storage is empty", async () => {
    expect(getActiveProfileId()).toBeNull();

    const id = await ensureLocalProfile();

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    // Persisted at the fixed, non-profile-scoped bootstrap key.
    const persisted = store.data[IDENTITY_BOOTSTRAP_KEY] as
      | LocalIdentity
      | undefined;
    expect(persisted).toBeDefined();
    expect(persisted?.localProfileId).toBe(id);
    expect(typeof persisted?.createdAt).toBe("number");
  });

  it("exposes the id synchronously via getActiveProfileId after resolving", async () => {
    const id = await ensureLocalProfile();
    expect(getActiveProfileId()).toBe(id);
  });

  it("returns the cached id without re-reading storage on subsequent calls", async () => {
    const id = await ensureLocalProfile();
    const getSpy = vi.spyOn(globalThis.chrome.storage.local, "get");

    const again = await ensureLocalProfile();

    expect(again).toBe(id);
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe("ensureLocalProfile - existing profile read", () => {
  it("returns the existing id and does not overwrite it", async () => {
    const existing: LocalIdentity = {
      localProfileId: "existing-profile-123",
      createdAt: 111,
    };
    store.data[IDENTITY_BOOTSTRAP_KEY] = existing;

    const setSpy = vi.spyOn(globalThis.chrome.storage.local, "set");

    const id = await ensureLocalProfile();

    expect(id).toBe("existing-profile-123");
    expect(setSpy).not.toHaveBeenCalled();
    // The original record is untouched.
    expect(store.data[IDENTITY_BOOTSTRAP_KEY]).toEqual(existing);
  });
});

describe("ensureLocalProfile - concurrency", () => {
  it("collapses concurrent callers onto a single mint and a single persist", async () => {
    const setSpy = vi.spyOn(globalThis.chrome.storage.local, "set");

    const results = await Promise.all([
      ensureLocalProfile(),
      ensureLocalProfile(),
      ensureLocalProfile(),
      ensureLocalProfile(),
    ]);

    // All callers resolve to the same id.
    const unique = new Set(results);
    expect(unique.size).toBe(1);

    // Only one identity was persisted.
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect((store.data[IDENTITY_BOOTSTRAP_KEY] as LocalIdentity).localProfileId).toBe(
      results[0],
    );
  });
});

describe("write-blocking on failure (Req 3.5)", () => {
  it("ensureLocalProfile rejects with IDENTITY_FAILED when persist fails", async () => {
    store.failSetWith = "storage write blew up";

    await expect(ensureLocalProfile()).rejects.toMatchObject({
      code: ErrorCode.IDENTITY_FAILED,
    });
  });

  it("requireProfile rejects with IDENTITY_FAILED when persist fails", async () => {
    store.failSetWith = "storage write blew up";

    await expect(requireProfile()).rejects.toMatchObject({
      code: ErrorCode.IDENTITY_FAILED,
    });
  });

  it("withProfile does NOT invoke fn when identity cannot be established", async () => {
    store.failSetWith = "storage write blew up";
    const fn = vi.fn(async (profileId: string) => profileId);

    await expect(withProfile(fn)).rejects.toMatchObject({
      code: ErrorCode.IDENTITY_FAILED,
    });
    expect(fn).not.toHaveBeenCalled();
    // No profile became active, so writes stay blocked.
    expect(getActiveProfileId()).toBeNull();
  });

  it("allows a retry on a subsequent call after a failure (in-flight promise cleared)", async () => {
    store.failSetWith = "transient failure";
    await expect(ensureLocalProfile()).rejects.toMatchObject({
      code: ErrorCode.IDENTITY_FAILED,
    });

    // Recover: storage now succeeds; the next call should mint + persist.
    store.failSetWith = null;
    const id = await ensureLocalProfile();

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(getActiveProfileId()).toBe(id);
    expect((store.data[IDENTITY_BOOTSTRAP_KEY] as LocalIdentity).localProfileId).toBe(
      id,
    );
  });

  it("withProfile runs fn with the profile id once identity succeeds", async () => {
    const seen = await withProfile(async (profileId) => profileId);
    expect(seen).toBe(getActiveProfileId());
    expect(typeof seen).toBe("string");
  });
});
