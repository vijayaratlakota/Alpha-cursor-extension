// Tests for the background tab save/restore handlers (tasks 12.4 + 12.6).
//
// Covers Tool 2 (Save All Tabs, Req 7) and Tool 3 (Restore Saved Tabs, Req 8):
//   - Property 8 (task 12.4): tab snapshot fidelity — a saved TabFolder stores
//     exactly the queried { url, title } pairs in order (Req 7.3).
//   - Integration tests (task 12.6): save/list, name-collision + overwrite,
//     no-tabs rejection, restore opened/failed counts, all-invalid rejection,
//     and delete (Req 7.4, 7.7, 8.3, 8.4, 8.5, 8.6).
//
// The ambient `chrome.*` surface is a hand-rolled in-memory fake providing
// tabs.query / tabs.create + storage.local + runtime.lastError, so the handlers
// exercise genuine persistence (via the real storage + identity layers) rather
// than stubs. `crypto.randomUUID` is shimmed for folder/profile id generation
// and `resetIdentityCache()` runs in beforeEach so each test starts cold.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  handleTabsSave,
  handleTabsList,
  handleTabsDelete,
  handleTabsRestore,
  type SavedTab,
  type TabFolder,
} from "./tabsHandlers";
import { resetIdentityCache } from "@/shared/identity";
import { getLocal, scopedKey, StorageDomain } from "@/shared/storage";
import { ErrorCode } from "@/shared/messaging";

// ---------------------------------------------------------------------------
// In-memory chrome fake: tabs.query / tabs.create + storage.local + lastError.
// ---------------------------------------------------------------------------

interface ChromeFake {
  /** Tabs returned by chrome.tabs.query({ currentWindow: true }). */
  openTabs: Array<{ url?: string; title?: string }>;
  /** URLs passed to chrome.tabs.create, in call order. */
  created: string[];
  /** Substrings that, when present in a create URL, force tabs.create to throw. */
  createFailureUrls: Set<string>;
  /** The profile-scoped chrome.storage.local backing object. */
  local: Record<string, unknown>;
}

function installChromeFake(): ChromeFake {
  const local: Record<string, unknown> = {};
  const lastError: { value: { message: string } | undefined } = {
    value: undefined,
  };
  const fake: ChromeFake = {
    openTabs: [],
    created: [],
    createFailureUrls: new Set<string>(),
    local,
  };

  const makeArea = (
    store: Record<string, unknown>,
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
    tabs: {
      query: (_info: unknown, cb?: (tabs: unknown[]) => void) => {
        const result = fake.openTabs.map((t) => ({ ...t }));
        if (cb) {
          cb(result);
          return undefined;
        }
        return Promise.resolve(result);
      },
      create: (props: { url?: string }) => {
        const url = props?.url ?? "";
        for (const bad of fake.createFailureUrls) {
          if (url.includes(bad)) {
            return Promise.reject(new Error(`tabs.create failed for ${url}`));
          }
        }
        fake.created.push(url);
        return Promise.resolve({ id: fake.created.length });
      },
    },
  };

  return fake;
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

/** Read the raw stored TabFolder[] for the (single) active profile. */
async function readStoredFolders(): Promise<TabFolder[]> {
  // The identity layer mints a profile id under the bootstrap key; every other
  // key is `acx:{profileId}:tabfolders`. Resolve the profile id from the
  // bootstrap record so we can rebuild the exact scoped key the handler used.
  const identity = await getLocal<{ localProfileId: string }>("acx::identity");
  const profileId = identity?.localProfileId;
  if (!profileId) return [];
  const folders = await getLocal<TabFolder[]>(
    scopedKey(profileId, StorageDomain.TAB_FOLDERS),
  );
  return Array.isArray(folders) ? folders : [];
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

// ---------------------------------------------------------------------------
// Task 12.4 — Property 8: Tab snapshot fidelity (Req 7.3).
// ---------------------------------------------------------------------------

describe("Property 8: tab snapshot fidelity (task 12.4)", () => {
  it("stores exactly the queried { url, title } pairs in the same order", async () => {
    // Feature: alpha-cursor-extension, Property 8: Tab snapshot fidelity
    // Validates: Requirements 7.3
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            url: fc.webUrl(),
            title: fc.string(),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        async (tabs) => {
          // Fresh state per run: new chrome fake + cold identity cache.
          fake = installChromeFake();
          resetIdentityCache();
          fake.openTabs = tabs.map((t) => ({ url: t.url, title: t.title }));

          const result = await handleTabsSave({ name: "snapshot" });
          expect(result.saved).toBe(true);

          const expected: SavedTab[] = tabs.map((t) => ({
            url: t.url,
            title: t.title,
          }));

          // Snapshot read back from the stored folder equals the queried tabs.
          const folders = await readStoredFolders();
          expect(folders).toHaveLength(1);
          expect(folders[0]!.tabs).toEqual(expected);

          // The list summary count matches the queried tab count (Req 7.7).
          const summaries = await handleTabsList();
          expect(summaries).toHaveLength(1);
          expect(summaries[0]!.count).toBe(tabs.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Task 12.6 — integration tests for save/restore/delete + name collision.
// ---------------------------------------------------------------------------

describe("tab save/list integration (task 12.6)", () => {
  it("Save then List returns the folder with the correct count (Req 7.7)", async () => {
    fake.openTabs = [
      { url: "https://a.example/1", title: "One" },
      { url: "https://b.example/2", title: "Two" },
      { url: "https://c.example/3", title: "Three" },
    ];

    const saved = await handleTabsSave({ name: "Work" });
    expect(saved.saved).toBe(true);

    const summaries = await handleTabsList();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.name).toBe("Work");
    expect(summaries[0]!.count).toBe(3);
  });

  it("rejects with NO_TABS when there are no open tabs (Req 7.5)", async () => {
    fake.openTabs = [];
    await expect(handleTabsSave({ name: "Empty" })).rejects.toMatchObject({
      code: ErrorCode.NO_TABS,
    });

    // Nothing was persisted.
    expect(await readStoredFolders()).toHaveLength(0);
  });
});

describe("name-collision flow (task 12.6, Req 7.4)", () => {
  it("returns { saved: false, reason: 'name_exists' } without overwrite", async () => {
    fake.openTabs = [{ url: "https://a.example/", title: "A" }];
    const first = await handleTabsSave({ name: "Dupe" });
    expect(first.saved).toBe(true);

    fake.openTabs = [
      { url: "https://b.example/", title: "B" },
      { url: "https://c.example/", title: "C" },
    ];
    const second = await handleTabsSave({ name: "Dupe" });
    expect(second).toEqual({
      saved: false,
      reason: "name_exists",
      name: "Dupe",
    });

    // The original snapshot is untouched (still the single A tab).
    const folders = await readStoredFolders();
    expect(folders).toHaveLength(1);
    expect(folders[0]!.tabs).toEqual([{ url: "https://a.example/", title: "A" }]);
  });

  it("with overwrite:true it replaces the snapshot keeping the same id", async () => {
    fake.openTabs = [{ url: "https://a.example/", title: "A" }];
    const first = await handleTabsSave({ name: "Dupe" });
    expect(first.saved).toBe(true);
    const originalId = first.saved ? first.folderId : "";

    fake.openTabs = [
      { url: "https://b.example/", title: "B" },
      { url: "https://c.example/", title: "C" },
    ];
    const second = await handleTabsSave({ name: "Dupe", overwrite: true });
    expect(second.saved).toBe(true);
    if (second.saved) {
      expect(second.folderId).toBe(originalId);
      expect(second.savedCount).toBe(2);
    }

    // Still a single folder; id preserved, snapshot replaced.
    const folders = await readStoredFolders();
    expect(folders).toHaveLength(1);
    expect(folders[0]!.id).toBe(originalId);
    expect(folders[0]!.tabs).toEqual([
      { url: "https://b.example/", title: "B" },
      { url: "https://c.example/", title: "C" },
    ]);
  });
});

describe("tab restore integration (task 12.6, Req 8.3-8.5)", () => {
  async function saveFolder(
    name: string,
    tabs: Array<{ url: string; title: string }>,
  ): Promise<string> {
    fake.openTabs = tabs;
    const result = await handleTabsSave({ name });
    if (!result.saved) throw new Error("expected save to succeed");
    return result.folderId;
  }

  it("opens openable URLs via tabs.create and counts invalid ones as failed (Req 8.3, 8.5)", async () => {
    const folderId = await saveFolder("Mixed", [
      { url: "https://ok-1.example/", title: "ok1" },
      { url: "javascript:void(0)", title: "bad-scheme" },
      { url: "https://ok-2.example/", title: "ok2" },
      { url: "not a url", title: "malformed" },
    ]);

    const result = await handleTabsRestore({ folderId });

    expect(result.openedCount).toBe(2);
    expect(result.failedCount).toBe(2);
    expect(fake.created).toEqual([
      "https://ok-1.example/",
      "https://ok-2.example/",
    ]);
  });

  it("counts tabs.create runtime failures toward failedCount (Req 8.5)", async () => {
    const folderId = await saveFolder("CreateFails", [
      { url: "https://good.example/", title: "good" },
      { url: "https://boom.example/", title: "boom" },
    ]);
    // Force the second create to throw at runtime.
    fake.createFailureUrls.add("boom.example");

    const result = await handleTabsRestore({ folderId });

    expect(result.openedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(fake.created).toEqual(["https://good.example/"]);
  });

  it("throws NO_OPENABLE_URLS and creates no tabs for an all-invalid folder (Req 8.4)", async () => {
    const folderId = await saveFolder("AllBad", [
      { url: "javascript:alert(1)", title: "x" },
      { url: "chrome://settings", title: "y" },
      { url: "", title: "empty" },
    ]);

    await expect(handleTabsRestore({ folderId })).rejects.toMatchObject({
      code: ErrorCode.NO_OPENABLE_URLS,
    });
    expect(fake.created).toHaveLength(0);
  });
});

describe("tab delete integration (task 12.6, Req 8.6)", () => {
  it("removes the folder so it no longer appears in List", async () => {
    fake.openTabs = [{ url: "https://a.example/", title: "A" }];
    const saved = await handleTabsSave({ name: "ToDelete" });
    expect(saved.saved).toBe(true);
    const folderId = saved.saved ? saved.folderId : "";

    const del = await handleTabsDelete({ folderId });
    expect(del).toEqual({ deleted: true });

    expect(await handleTabsList()).toHaveLength(0);
    expect(await readStoredFolders()).toHaveLength(0);
  });

  it("reports deleted:false when the folder id is unknown", async () => {
    fake.openTabs = [{ url: "https://a.example/", title: "A" }];
    await handleTabsSave({ name: "Keep" });

    const del = await handleTabsDelete({ folderId: "does-not-exist" });
    expect(del).toEqual({ deleted: false });

    expect(await handleTabsList()).toHaveLength(1);
  });
});
