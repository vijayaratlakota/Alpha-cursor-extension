// Integration tests for the background Toggle handlers + lifecycle (task 8.2).
//
// `installToggle()` registers the TOGGLE_GET / TOGGLE_SET handlers on the router
// and wires chrome.runtime.onInstalled / onStartup. These tests dispatch through
// the real router (validating the end-to-end handler -> settings -> storage path)
// and assert the lifecycle listeners are registered and behave per Req 1.5
// (install seeds the default; startup restores/caches the persisted value).
//
// The ambient `chrome.*` surface is a hand-rolled in-memory fake providing
// storage.sync/local + runtime.lastError + onInstalled/onStartup listener
// registries, so we exercise genuine persistence rather than stubs.
//
//   - Req 1.4: TOGGLE_SET persists to chrome.storage.sync and echoes { enabled };
//              TOGGLE_GET reflects the persisted value.
//   - Req 1.5: onInstalled seeds DEFAULT_ENABLED; onStartup restores + warms the
//              in-memory cache from the persisted value.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installToggle } from "./toggleHandlers";
import { clearHandlers, dispatch } from "./router";
import { createMessage, isOk } from "@/shared/messaging";
import {
  DEFAULT_ENABLED,
  ToggleMessageType,
  getCachedEnabled,
} from "@/shared/settings";
import { resetIdentityCache } from "@/shared/identity";

// ---------------------------------------------------------------------------
// In-memory chrome fake with onInstalled / onStartup listener registries.
// ---------------------------------------------------------------------------

interface SimpleEvent {
  listeners: Array<() => void>;
  addListener: (cb: () => void) => void;
  /** Fire all registered listeners (simulates the browser event). */
  fire: () => void;
}

interface ChromeFake {
  sync: Record<string, unknown>;
  local: Record<string, unknown>;
  onInstalled: SimpleEvent;
  onStartup: SimpleEvent;
}

function makeEvent(): SimpleEvent {
  const listeners: Array<() => void> = [];
  return {
    listeners,
    addListener: (cb) => listeners.push(cb),
    fire: () => listeners.forEach((l) => l()),
  };
}

function installChromeFake(): ChromeFake {
  const sync: Record<string, unknown> = {};
  const local: Record<string, unknown> = {};
  const lastError: { value: { message: string } | undefined } = {
    value: undefined,
  };
  const onInstalled = makeEvent();
  const onStartup = makeEvent();

  const makeArea = (store: Record<string, unknown>): chrome.storage.StorageArea =>
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
      sync: makeArea(sync),
      local: makeArea(local),
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    runtime: {
      get lastError() {
        return lastError.value;
      },
      onInstalled: { addListener: onInstalled.addListener },
      onStartup: { addListener: onStartup.addListener },
    },
  };

  return { sync, local, onInstalled, onStartup };
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

/** Await microtasks so void-fire lifecycle handlers settle their async work. */
async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------

let fake: ChromeFake;
const noSender = {} as chrome.runtime.MessageSender;

beforeEach(() => {
  ensureCrypto();
  fake = installChromeFake();
  resetIdentityCache();
  clearHandlers();
});

afterEach(() => {
  clearHandlers();
  resetIdentityCache();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("installToggle - handler registration + lifecycle wiring", () => {
  it("registers an onInstalled and an onStartup listener", () => {
    installToggle();
    expect(fake.onInstalled.listeners).toHaveLength(1);
    expect(fake.onStartup.listeners).toHaveLength(1);
  });

  it("TOGGLE_GET returns { enabled } reflecting the default on empty storage", async () => {
    installToggle();

    const response = await dispatch(createMessage(ToggleMessageType.GET, undefined), noSender);

    expect(isOk(response)).toBe(true);
    if (isOk(response)) {
      expect(response.data).toEqual({ enabled: DEFAULT_ENABLED });
    }
  });

  it("TOGGLE_SET persists to chrome.storage.sync and echoes { enabled } (Req 1.4)", async () => {
    installToggle();

    const response = await dispatch(
      createMessage(ToggleMessageType.SET, { enabled: false }),
      noSender,
    );

    expect(isOk(response)).toBe(true);
    if (isOk(response)) {
      expect(response.data).toEqual({ enabled: false });
    }

    // Persisted to the sync tier under the profile-scoped enabled key.
    const key = Object.keys(fake.sync)[0];
    expect(key).toBeDefined();
    expect(key!.endsWith(":settings:enabled")).toBe(true);
    expect(fake.sync[key!]).toBe(false);
  });

  it("TOGGLE_GET reflects a value previously written via TOGGLE_SET", async () => {
    installToggle();

    await dispatch(createMessage(ToggleMessageType.SET, { enabled: false }), noSender);
    const getResponse = await dispatch(
      createMessage(ToggleMessageType.GET, undefined),
      noSender,
    );

    expect(isOk(getResponse)).toBe(true);
    if (isOk(getResponse)) {
      expect(getResponse.data).toEqual({ enabled: false });
    }
  });

  it("coerces a non-boolean TOGGLE_SET payload to a boolean", async () => {
    installToggle();

    const response = await dispatch(
      // Intentionally passing a non-boolean to test coercion.
      createMessage(ToggleMessageType.SET, { enabled: "yes" as unknown as boolean }),
      noSender,
    );

    expect(isOk(response)).toBe(true);
    if (isOk(response)) {
      expect(response.data).toEqual({ enabled: true });
    }
  });
});

describe("lifecycle behavior (Req 1.5)", () => {
  it("onInstalled seeds DEFAULT_ENABLED when nothing is persisted", async () => {
    installToggle();

    fake.onInstalled.fire();
    await flushAsync();

    const key = Object.keys(fake.sync)[0];
    expect(key).toBeDefined();
    expect(fake.sync[key!]).toBe(DEFAULT_ENABLED);
  });

  it("onInstalled does not overwrite an explicitly persisted value", async () => {
    installToggle();

    // User had previously turned it OFF.
    await dispatch(createMessage(ToggleMessageType.SET, { enabled: false }), noSender);
    const key = Object.keys(fake.sync)[0]!;
    expect(fake.sync[key]).toBe(false);

    fake.onInstalled.fire();
    await flushAsync();

    expect(fake.sync[key]).toBe(false);
  });

  it("onStartup restores the persisted value into the in-memory cache", async () => {
    // Persist a value, then simulate a fresh worker boot (cold caches).
    installToggle();
    await dispatch(createMessage(ToggleMessageType.SET, { enabled: false }), noSender);

    resetIdentityCache();

    fake.onStartup.fire();
    await flushAsync();

    // The startup read warmed the cache so synchronous gating sees the value.
    expect(getCachedEnabled()).toBe(false);
  });
});
