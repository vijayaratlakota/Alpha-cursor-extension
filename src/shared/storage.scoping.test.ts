// Property-based tests for the storage layer's profile scoping (tasks 4.3 & 4.4).
//
// Both properties exercise `src/shared/storage.ts`:
//   - Property 19: reads (built on the pure scoping helpers + chrome.storage
//                  wrappers) only ever return data for the active profile.
//   - Property 20: `clearAll(profileId)` removes every key scoped to that
//                  profile across sync, local, and the IndexedDB blob store,
//                  while leaving other profiles untouched.
//
// The chrome.storage tiers are backed by a hand-rolled in-memory fake that
// matches the callback contract storage.ts relies on (get/set/remove plus
// `get(null)` to enumerate). IndexedDB is provided by `fake-indexeddb`, reset
// per run so blob state never leaks between generated cases.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { IDBFactory } from "fake-indexeddb";

import {
  StorageDomain,
  scopedKey,
  profilePrefix,
  isProfileScopedKey,
  parseScopedKey,
  makeBlobRef,
  getSync,
  setSync,
  getLocal,
  setLocal,
  getBlob,
  putBlob,
  clearAll,
  BLOB_DB_NAME,
  BLOB_STORE_NAME,
  type BlobRecord,
} from "./storage";

// ---------------------------------------------------------------------------
// In-memory chrome.storage fake
// ---------------------------------------------------------------------------

type StoreCallback = (result: Record<string, unknown>) => void;

function makeArea() {
  const store = new Map<string, unknown>();
  return {
    store,
    get(keys: string | string[] | null | undefined, cb: StoreCallback) {
      const result: Record<string, unknown> = {};
      if (keys === null || keys === undefined) {
        for (const [k, v] of store) result[k] = v;
      } else if (typeof keys === "string") {
        if (store.has(keys)) result[keys] = store.get(keys);
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (store.has(k)) result[k] = store.get(k);
      }
      cb(result);
    },
    set(items: Record<string, unknown>, cb: () => void) {
      for (const k of Object.keys(items)) store.set(k, items[k]);
      cb();
    },
    remove(keys: string | string[], cb: () => void) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) store.delete(k);
      cb();
    },
  };
}

let syncArea: ReturnType<typeof makeArea>;
let localArea: ReturnType<typeof makeArea>;

function installChromeFake() {
  syncArea = makeArea();
  localArea = makeArea();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {},
    storage: { sync: syncArea, local: localArea },
  };
}

/** List every key currently held in the IndexedDB blob store. */
function listBlobKeys(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(BLOB_DB_NAME);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(BLOB_STORE_NAME)) {
        db.close();
        resolve([]);
        return;
      }
      const tx = db.transaction(BLOB_STORE_NAME, "readonly");
      const req = tx.objectStore(BLOB_STORE_NAME).getAllKeys();
      req.onsuccess = () => {
        const keys = (req.result ?? []).map((k) => String(k));
        db.close();
        resolve(keys);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    };
    open.onerror = () => reject(open.error);
  });
}

function makeBlobRecord(seed: string): BlobRecord {
  return {
    mime: "application/octet-stream",
    // Uint8Array is reliably structured-cloneable by fake-indexeddb.
    data: new Uint8Array([...seed].map((c) => c.charCodeAt(0) % 256)) as unknown as Blob,
    createdAt: 0,
  };
}

beforeEach(() => {
  installChromeFake();
  // Fresh IndexedDB per test so blob state never leaks between cases.
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// A single, colon-free, non-blank key segment (the separator is ":").
const segmentArb = fc
  .string({ minLength: 1, maxLength: 8 })
  .map((s) => s.replace(/:/g, "_"))
  .filter((s) => s.trim().length > 0);

const domainArb = fc.constantFrom(...Object.values(StorageDomain));

// Two distinct profile ids (UUIDs are colon-free and stable).
const twoProfilesArb = fc
  .tuple(fc.uuid(), fc.uuid())
  .filter(([a, b]) => a !== b);

const partsArb = fc.array(segmentArb, { maxLength: 3 });

// ---------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------

describe("Property 19: storage reads are scoped to the active local profile", () => {
  // Feature: alpha-cursor-extension, Property 19: Storage reads are scoped to the active local profile
  // Validates: Requirements 3.2, 3.3
  it("scoping helpers match only the owning profile and round-trip", () => {
    fc.assert(
      fc.property(
        twoProfilesArb,
        domainArb,
        partsArb,
        ([profileA, profileB], domain, parts) => {
          const keyA = scopedKey(profileA, domain, ...parts);

          // The key belongs to A and to no other profile.
          expect(isProfileScopedKey(keyA, profileA)).toBe(true);
          expect(isProfileScopedKey(keyA, profileB)).toBe(false);
          expect(keyA.startsWith(profilePrefix(profileB))).toBe(false);

          // parseScopedKey is the inverse of scopedKey for the owning profile.
          const parsed = parseScopedKey(keyA);
          expect(parsed).not.toBeNull();
          expect(parsed?.profileId).toBe(profileA);
          expect(parsed?.domain).toBe(domain);
          expect(parsed?.parts).toEqual(parts);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: alpha-cursor-extension, Property 19: Storage reads are scoped to the active local profile
  // Validates: Requirements 3.2, 3.3
  it("reads return the active profile's data, never another profile's", async () => {
    await fc.assert(
      fc.asyncProperty(
        twoProfilesArb,
        domainArb,
        partsArb,
        fc.string(),
        fc.string(),
        async ([active, other], domain, parts, activeValue, otherValue) => {
          installChromeFake();

          const activeKey = scopedKey(active, domain, ...parts);
          const otherKey = scopedKey(other, domain, ...parts);

          // Both profiles write under the same domain/parts shape.
          await setSync(activeKey, activeValue);
          await setSync(otherKey, otherValue);
          await setLocal(activeKey, activeValue);
          await setLocal(otherKey, otherValue);

          // Reading the active profile's scoped key returns its own value only.
          expect(await getSync(activeKey)).toEqual(activeValue);
          expect(await getLocal(activeKey)).toEqual(activeValue);

          // The active profile's key never resolves to the other profile's data.
          expect(isProfileScopedKey(activeKey, other)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 20
// ---------------------------------------------------------------------------

interface SeedEntry {
  tier: "sync" | "local" | "blob";
  domain: StorageDomain;
  parts: string[];
}

const seedEntryArb: fc.Arbitrary<SeedEntry> = fc.record({
  tier: fc.constantFrom("sync", "local", "blob") as fc.Arbitrary<SeedEntry["tier"]>,
  domain: domainArb,
  parts: partsArb,
});

const seedEntriesArb = fc.array(seedEntryArb, { minLength: 1, maxLength: 10 });

describe("Property 20: clear-data removes all profile-scoped data", () => {
  // Feature: alpha-cursor-extension, Property 20: Clear-data removes all profile-scoped data
  // Validates: Requirements 19.6, 21.7
  it("clearAll removes every key for the target profile across all tiers and leaves others intact", async () => {
    await fc.assert(
      fc.asyncProperty(
        twoProfilesArb,
        seedEntriesArb,
        async ([target, other], entries) => {
          installChromeFake();
          (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB =
            new IDBFactory();

          const targetKeys = { sync: [] as string[], local: [] as string[], blob: [] as string[] };
          const otherKeys = { sync: [] as string[], local: [] as string[], blob: [] as string[] };

          // Seed identical data shapes under both the target and other profiles
          // across all three tiers.
          for (const [i, entry] of entries.entries()) {
            const suffix = [...entry.parts, String(i)];
            if (entry.tier === "blob") {
              const tRef = makeBlobRef(target, ...suffix);
              const oRef = makeBlobRef(other, ...suffix);
              await putBlob(tRef, makeBlobRecord(`t${i}`));
              await putBlob(oRef, makeBlobRecord(`o${i}`));
              targetKeys.blob.push(tRef);
              otherKeys.blob.push(oRef);
            } else {
              const tKey = scopedKey(target, entry.domain, ...suffix);
              const oKey = scopedKey(other, entry.domain, ...suffix);
              if (entry.tier === "sync") {
                await setSync(tKey, `t${i}`);
                await setSync(oKey, `o${i}`);
                targetKeys.sync.push(tKey);
                otherKeys.sync.push(oKey);
              } else {
                await setLocal(tKey, `t${i}`);
                await setLocal(oKey, `o${i}`);
                targetKeys.local.push(tKey);
                otherKeys.local.push(oKey);
              }
            }
          }

          await clearAll(target);

          const targetPrefix = profilePrefix(target);

          // Completeness: no target-scoped key remains in any tier.
          for (const k of syncArea.store.keys()) {
            expect(k.startsWith(targetPrefix)).toBe(false);
          }
          for (const k of localArea.store.keys()) {
            expect(k.startsWith(targetPrefix)).toBe(false);
          }
          const blobKeysAfter = await listBlobKeys();
          expect(blobKeysAfter.some((k) => k.startsWith(targetPrefix))).toBe(false);

          // Every seeded target key is specifically gone.
          for (const k of targetKeys.sync) expect(await getSync(k)).toBeUndefined();
          for (const k of targetKeys.local) expect(await getLocal(k)).toBeUndefined();
          for (const k of targetKeys.blob) expect(await getBlob(k)).toBeUndefined();

          // Disjointness: the other profile's data is untouched.
          for (const k of otherKeys.sync) expect(await getSync(k)).toBeDefined();
          for (const k of otherKeys.local) expect(await getLocal(k)).toBeDefined();
          for (const k of otherKeys.blob) expect(await getBlob(k)).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});
