/**
 * Task 17.4 — example test for the ToS-notice-before-first-download flow
 * (Req 13.8).
 *
 * The full media flow mounts a closed Shadow DOM dialog and drives
 * `chrome.downloads`, which is impractical to drive end-to-end in jsdom. The
 * REQUIREMENT under test (Req 13.8) is the persisted gate that decides whether
 * the one-time ToS notice is shown before the FIRST download: the notice must
 * appear when the flag is unset and must NOT reappear once accepted.
 *
 * We therefore test the storage-backed gate via the small exported helpers
 * {@link isMediaTosAccepted} / {@link acceptMediaTos} (added to `mediaTool.ts`
 * for testability), asserting:
 *   - the gate is initially `false` (so the notice shows before the first
 *     download),
 *   - after `acceptMediaTos()` it becomes `true` (so the notice never reappears),
 *   - acceptance is PERSISTED under the profile-scoped settings key, and
 *   - the gate is per-profile / fails closed when no profile exists.
 *
 * `chrome.storage.local` is a hand-rolled in-memory fake and `crypto.randomUUID`
 * is shimmed so `ensureLocalProfile()` can mint a profile id.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MEDIA_TOS_ACCEPTED_KEY,
  isMediaTosAccepted,
  acceptMediaTos,
} from "./mediaTool";
import {
  ensureLocalProfile,
  getActiveProfileId,
  resetIdentityCache,
} from "../../shared/identity";
import { scopedKey, StorageDomain } from "../../shared/storage";

// ---------------------------------------------------------------------------
// In-memory chrome.storage.local fake (callback form, like storage.ts expects).
// ---------------------------------------------------------------------------

interface ChromeFake {
  local: Record<string, unknown>;
}

function installChromeFake(): ChromeFake {
  const local: Record<string, unknown> = {};
  const lastError: { value: { message: string } | undefined } = {
    value: undefined,
  };

  const makeArea = (
    store: Record<string, unknown>,
  ): chrome.storage.StorageArea =>
    ({
      get: (key: string | null, cb: (items: Record<string, unknown>) => void) => {
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
      sync: makeArea({}),
      local: makeArea(local),
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    runtime: {
      get lastError() {
        return lastError.value;
      },
    },
  };

  return { local };
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
  resetIdentityCache();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("media ToS gate (Req 13.8)", () => {
  it("is initially not accepted, so the notice shows before the first download", async () => {
    await ensureLocalProfile();

    // Flag unset → gate false → the one-time ToS notice must be shown.
    expect(await isMediaTosAccepted()).toBe(false);
  });

  it("flips to accepted after acceptMediaTos() and persists under the scoped key", async () => {
    const profileId = await ensureLocalProfile();

    await acceptMediaTos();

    // Gate now true → the notice never reappears (Req 13.8).
    expect(await isMediaTosAccepted()).toBe(true);

    // Acceptance is persisted to chrome.storage.local under the profile-scoped
    // settings key, not some ad-hoc location.
    const key = scopedKey(
      profileId,
      StorageDomain.SETTINGS,
      MEDIA_TOS_ACCEPTED_KEY,
    );
    expect(fake.local[key]).toBe(true);
  });

  it("a fresh profile (no acceptance persisted) still shows the notice", async () => {
    const first = await ensureLocalProfile();
    await acceptMediaTos();
    expect(await isMediaTosAccepted()).toBe(true);

    // Simulate a different profile: clear the cache and wipe storage so a new
    // id is minted. The new profile has not accepted, so the gate is false.
    resetIdentityCache();
    for (const k of Object.keys(fake.local)) delete fake.local[k];

    const second = await ensureLocalProfile();
    expect(second).not.toBe(first);
    expect(await isMediaTosAccepted()).toBe(false);
  });

  it("fails closed (gate false) when no local profile is established", async () => {
    // No ensureLocalProfile() call → getActiveProfileId() is null.
    expect(getActiveProfileId()).toBeNull();
    expect(await isMediaTosAccepted()).toBe(false);

    // Accepting is a no-op without a profile and does not throw.
    await expect(acceptMediaTos()).resolves.toBeUndefined();
    expect(await isMediaTosAccepted()).toBe(false);
  });
});
