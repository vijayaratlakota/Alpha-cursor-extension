// Property-based + edge-case tests for the Notepad storage core (tasks 11.5, 11.6, 11.8).
//
// Exercises the storage-core functions exported from ./notepad.ts:
//   - Property 4 (task 11.5): appending grows the entry list by one each time,
//     the newest text is last, and `seq` is strictly increasing across all
//     entries (monotonic capture order) (Req 4.1, 4.5).
//   - Property 5 (task 11.6): capture is origin-independent — the stored text
//     equals the copied text for ANY `sourceUrl`, and the append always happens
//     regardless of origin (Req 4.3).
//   - Edge cases (task 11.8): a storage quota condition flags `quotaExceeded`
//     while still attempting a best-effort append (Req 4.4); `copyAll()` on an
//     empty notepad reports `empty` and produces no clipboard string (Req 6.4);
//     `copyAll()` with entries reports `empty: false` and the joined string; and
//     `runCopyAll` notifies on a clipboard write failure (Req 6.5).
//
// The storage layer is backed by a hand-rolled in-memory `chrome.storage`
// fake (matching the callback contract `storage.ts` relies on, including
// `chrome.runtime.lastError`) plus `fake-indexeddb` for the blob-overflow path.
// State is reset before every test — and before every generated property run —
// so nothing leaks between cases. Property tests run a minimum of 100 cases.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";

import {
  appendEntry,
  listEntries,
  copyAll,
  runCopyAll,
  NotepadMessageType,
  NOTEPAD_INLINE_TEXT_LIMIT,
  type NotepadCopyAllResult,
} from "./notepad";
import { resetIdentityCache } from "../../shared/identity";
import { ok, type Response } from "../../shared/messaging";

// `notify` renders into a closed Shadow DOM (real implementation pulls in the
// shared stylesheet). For these tests we only care THAT it was called and with
// what, so it is mocked out to a spy.
vi.mock("../../ui/notify", () => ({
  notify: vi.fn(() => ({ dismiss: () => {} })),
}));
import { notify } from "../../ui/notify";

// ---------------------------------------------------------------------------
// In-memory chrome.storage fake (callback contract used by storage.ts)
// ---------------------------------------------------------------------------

interface FakeState {
  data: Record<string, unknown>;
  /** When set, every set() reports this message via chrome.runtime.lastError. */
  failSetWith: string | null;
}

let state: FakeState;
/** Configurable handler for chrome.runtime.sendMessage (runCopyAll tests). */
let sendMessageHandler: ((message: unknown) => unknown) | null;

function installChromeFake(): void {
  state = { data: {}, failSetWith: null };
  const lastError: { value: { message: string } | undefined } = {
    value: undefined,
  };

  const area = {
    get: (
      key: string | null,
      cb: (items: Record<string, unknown>) => void,
    ) => {
      lastError.value = undefined;
      if (key === null) {
        cb({ ...state.data });
        return;
      }
      const out: Record<string, unknown> = {};
      if (key in state.data) out[key] = state.data[key];
      cb(out);
    },
    set: (items: Record<string, unknown>, cb: () => void) => {
      if (state.failSetWith) {
        lastError.value = { message: state.failSetWith };
        cb();
        return;
      }
      lastError.value = undefined;
      Object.assign(state.data, items);
      cb();
    },
    remove: (keys: string | string[], cb: () => void) => {
      lastError.value = undefined;
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete state.data[k];
      cb();
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: area, sync: area },
    runtime: {
      get lastError() {
        return lastError.value;
      },
      sendMessage: (message: unknown) => {
        if (sendMessageHandler) {
          return Promise.resolve(sendMessageHandler(message));
        }
        return Promise.reject(new Error("no sendMessage handler"));
      },
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

/** Reset ALL shared state: chrome fake, identity cache, and IndexedDB. */
function resetWorld(): void {
  installChromeFake();
  resetIdentityCache();
  sendMessageHandler = null;
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB =
    new IDBFactory();
}

beforeEach(() => {
  ensureCrypto();
  // jsdom's Blob does not survive fake-indexeddb's structured clone (it loses
  // `.text()`); Node's Blob does. The real service-worker Blob round-trips
  // fine, so this shim only bridges the jsdom test environment.
  (globalThis as unknown as { Blob: unknown }).Blob = NodeBlob;
  resetWorld();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Property 4 — Notepad append grows and preserves order (Req 4.1, 4.5)
// ---------------------------------------------------------------------------

describe("Property 4: Notepad append grows and preserves order", () => {
  // Feature: alpha-cursor-extension, Property 4: Notepad append grows and preserves order
  // Validates: Requirements 4.1, 4.5
  it("grows by one per append, keeps the newest text last, and seq strictly increases", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Keep texts small (inline) so each run does many quick appends.
        fc.array(fc.string({ maxLength: 64 }), { minLength: 1, maxLength: 12 }),
        async (texts) => {
          // Isolate every generated case from the others.
          resetWorld();

          let previousLength = 0;
          let previousSeq = 0;

          for (const text of texts) {
            const { entry } = await appendEntry(text);
            const entries = await listEntries();

            // The list grows by exactly one with each append (Req 4.1).
            expect(entries.length).toBe(previousLength + 1);

            const last = entries[entries.length - 1]!;
            // The newest text is the last entry (capture order preserved).
            expect(last.text).toBe(text);

            // seq is strictly increasing across all entries (Req 4.5).
            const seqs = entries.map((e) => e.seq);
            for (let i = 1; i < seqs.length; i++) {
              expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
            }
            // ...and the just-appended entry carries the newest seq.
            expect(entry.seq).toBeGreaterThan(previousSeq);
            expect(last.seq).toBe(entry.seq);

            previousLength = entries.length;
            previousSeq = entry.seq;
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // A focused unit example alongside the property for clarity.
  it("appends three entries in capture order with monotonic seq", async () => {
    await appendEntry("first");
    await appendEntry("second");
    await appendEntry("third");

    const entries = await listEntries();
    expect(entries.map((e) => e.text)).toEqual(["first", "second", "third"]);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Property 5 — Capture is origin-independent (Req 4.3)
// ---------------------------------------------------------------------------

describe("Property 5: Capture is origin-independent", () => {
  // A broad mix of origin/sourceUrl shapes: real-looking URLs, junk strings,
  // empty string, and "no sourceUrl at all".
  const sourceUrlArb: fc.Arbitrary<string | undefined> = fc.oneof(
    fc.webUrl(),
    fc.string({ maxLength: 40 }),
    fc.constant(""),
    fc.constant(undefined),
    fc.constantFrom(
      "https://example.com",
      "http://localhost:3000/page?x=1#frag",
      "about:blank",
      "chrome-extension://abc/page.html",
    ),
  );

  // Feature: alpha-cursor-extension, Property 5: Capture is origin-independent
  // Validates: Requirements 4.3
  it("stores the copied text unchanged for any sourceUrl, and always captures", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 256 }),
        sourceUrlArb,
        async (text, sourceUrl) => {
          resetWorld();

          const before = (await listEntries()).length;
          const { entry } = await appendEntry(text, sourceUrl);

          // Capture happened regardless of origin (Req 4.3).
          const entries = await listEntries();
          expect(entries.length).toBe(before + 1);

          // The stored text equals the copied text, independent of sourceUrl.
          expect(entries[entries.length - 1]!.text).toBe(text);
          expect(entry.text === text || entry.blobRef !== undefined).toBe(true);

          // sourceUrl is recorded when provided (truthy) but never alters text.
          if (sourceUrl) {
            expect(entries[entries.length - 1]!.sourceUrl).toBe(sourceUrl);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: alpha-cursor-extension, Property 5: Capture is origin-independent
  // Validates: Requirements 4.3
  it("captures identical text the same way from different origins", async () => {
    const text = "shared clipboard text";
    await appendEntry(text, "https://siteA.example/path");
    await appendEntry(text, "https://siteB.different/other");

    const entries = await listEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.text).toBe(text);
    expect(entries[1]!.text).toBe(text);
    expect(entries[0]!.sourceUrl).toBe("https://siteA.example/path");
    expect(entries[1]!.sourceUrl).toBe("https://siteB.different/other");
  });
});

// ---------------------------------------------------------------------------
// Large-text overflow path (blobRef → IndexedDB, resolved back on read)
// ---------------------------------------------------------------------------

describe("large-text overflow to the IndexedDB blob store", () => {
  it("stores oversized text via blobRef and resolves it back on listEntries", async () => {
    const big = "x".repeat(NOTEPAD_INLINE_TEXT_LIMIT + 100);
    const { entry } = await appendEntry(big, "https://example.com");

    // The metadata entry overflows: blobRef set, inline text emptied.
    expect(entry.blobRef).toBeDefined();
    expect(entry.text).toBe("");

    // listEntries resolves the full text back from the blob store.
    const entries = await listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe(big);
  });
});

// ---------------------------------------------------------------------------
// Task 11.8 — quota-exceed flag + empty/failed Copy All edge cases
// ---------------------------------------------------------------------------

describe("quota-exceeded best-effort append (Req 4.4)", () => {
  it("flags quotaExceeded while still attempting the append when a write hits quota", async () => {
    // Establish the local profile + first entry while storage is healthy.
    await appendEntry("first entry");

    // Now make every set() report a quota condition (storage.ts maps the
    // "quota" message to ErrorCode.QUOTA_EXCEEDED).
    state.failSetWith = "QUOTA_BYTES quota exceeded";

    const result = await appendEntry("second entry", "https://example.com");

    // Best-effort: the append is still attempted and a quota flag is raised so
    // the caller can surface the "storage limit reached" Notification.
    expect(result.quotaExceeded).toBe(true);
    expect(result.entry.text).toBe("second entry");
  });
});

describe("copyAll edge cases (Req 6.4)", () => {
  it("returns empty:true with no joined string on an empty notepad (no clipboard write)", async () => {
    const result = await copyAll();
    expect(result).toEqual({ empty: true, count: 0, joined: "" });
  });

  it("returns empty:false and the joined string when entries exist", async () => {
    await appendEntry("alpha");
    await appendEntry("beta");
    await appendEntry("gamma");

    const result = await copyAll();
    expect(result.empty).toBe(false);
    expect(result.count).toBe(3);
    // Default separator is a comma (no Separator configured here).
    expect(result.joined).toBe("alpha,beta,gamma");
  });
});

describe("runCopyAll clipboard outcomes (Req 6.4, 6.5)", () => {
  /** Wire chrome.runtime.sendMessage to answer COPY_ALL with `result`. */
  function answerCopyAll(result: NotepadCopyAllResult): void {
    sendMessageHandler = (message): Response<NotepadCopyAllResult> | undefined => {
      const type = (message as { type?: string }).type;
      if (type === NotepadMessageType.COPY_ALL) {
        return ok(result);
      }
      return undefined;
    };
  }

  it("notifies 'empty' and does NOT touch the clipboard on an empty notepad (Req 6.4)", async () => {
    answerCopyAll({ joined: "", count: 0, empty: true });
    const writeText = vi.fn();
    (globalThis as unknown as { navigator: { clipboard: unknown } }).navigator = {
      clipboard: { writeText },
    };

    await runCopyAll();

    expect(writeText).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "info" }),
    );
  });

  it("notifies a failure when the clipboard write rejects (Req 6.5)", async () => {
    answerCopyAll({ joined: "a,b", count: 2, empty: false });
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    (globalThis as unknown as { navigator: { clipboard: unknown } }).navigator = {
      clipboard: { writeText },
    };

    // The failure is reported via Notification, never thrown.
    await expect(runCopyAll()).resolves.toBeUndefined();

    expect(writeText).toHaveBeenCalledWith("a,b");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("notifies success after a successful clipboard write", async () => {
    answerCopyAll({ joined: "a,b,c", count: 3, empty: false });
    const writeText = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { navigator: { clipboard: unknown } }).navigator = {
      clipboard: { writeText },
    };

    await runCopyAll();

    expect(writeText).toHaveBeenCalledWith("a,b,c");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "success" }),
    );
  });
});
