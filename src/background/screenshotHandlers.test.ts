// Integration tests for the background Screenshot handlers (task 13.5).
//
// `installScreenshot()` registers SCREENSHOT_CAPTURE_VISIBLE / SCREENSHOT_DOWNLOAD
// / SCREENSHOT_CHECKPOINT on the shared router. These tests dispatch through the
// real router (validating the end-to-end handler -> storage/identity path) and
// assert:
//
//   - Req 9.5: CAPTURE_VISIBLE returns { dataUrl } from chrome.tabs.captureVisibleTab,
//              retries a rejected capture then succeeds, and surfaces CAPTURE_FAILED
//              after exhausting its attempts. DOWNLOAD calls chrome.downloads.download
//              ({ saveAs: false }) and returns { downloadId }; a download failure maps
//              to a CAPTURE_FAILED error response.
//   - Req 22.3: CHECKPOINT writes a resumable progress marker to chrome.storage.local
//              (written:true) that readScreenshotCheckpoint can read back, and clears
//              it (written:false / undefined) when done:true.
//
// The ambient `chrome.*` surface is a hand-rolled in-memory fake providing
// tabs.captureVisibleTab + downloads.download + storage.local + runtime.lastError,
// so the handlers exercise genuine persistence rather than stubs. `crypto.randomUUID`
// is shimmed for profile id generation and `resetIdentityCache()` runs in beforeEach
// so each test starts cold.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installScreenshot,
  readScreenshotCheckpoint,
  ScreenshotMessageType,
} from "./screenshotHandlers";
import { clearHandlers, dispatch } from "./router";
import { createMessage, isErr, isOk, ErrorCode } from "@/shared/messaging";
import { resetIdentityCache } from "@/shared/identity";

// ---------------------------------------------------------------------------
// In-memory chrome fake: tabs.captureVisibleTab + downloads.download +
// storage.local + runtime.lastError.
// ---------------------------------------------------------------------------

type CaptureBehavior =
  | { kind: "resolve"; value: string }
  | { kind: "reject"; error: unknown };

interface ChromeFake {
  /** Backing object for chrome.storage.local. */
  local: Record<string, unknown>;
  /** Queue of behaviors for successive captureVisibleTab calls. */
  captureQueue: CaptureBehavior[];
  /** Default behavior used once the queue is empty. */
  captureDefault: CaptureBehavior;
  /** windowId values seen by captureVisibleTab, in call order. */
  captureWindowIds: Array<number | undefined>;
  /** Options objects passed to downloads.download, in call order. */
  downloadCalls: Array<{ url?: string; filename?: string; saveAs?: boolean }>;
  /** When set, downloads.download rejects with this error. */
  downloadError: unknown;
  /** downloadId resolved by a successful downloads.download. */
  downloadId: number;
}

function installChromeFake(): ChromeFake {
  const local: Record<string, unknown> = {};
  const lastError: { value: { message: string } | undefined } = {
    value: undefined,
  };
  const fake: ChromeFake = {
    local,
    captureQueue: [],
    captureDefault: { kind: "resolve", value: "data:image/png;base64,DEFAULT" },
    captureWindowIds: [],
    downloadCalls: [],
    downloadError: undefined,
    downloadId: 42,
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

  const nextCapture = (): CaptureBehavior =>
    fake.captureQueue.length > 0
      ? (fake.captureQueue.shift() as CaptureBehavior)
      : fake.captureDefault;

  const captureVisibleTab = (...args: unknown[]): Promise<string> => {
    // Signature is either (windowId, options) or (options).
    const windowId = typeof args[0] === "number" ? args[0] : undefined;
    fake.captureWindowIds.push(windowId);
    const behavior = nextCapture();
    if (behavior.kind === "reject") {
      return Promise.reject(behavior.error);
    }
    return Promise.resolve(behavior.value);
  };

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
      captureVisibleTab,
    },
    downloads: {
      download: (options: {
        url?: string;
        filename?: string;
        saveAs?: boolean;
      }) => {
        fake.downloadCalls.push(options);
        if (fake.downloadError !== undefined) {
          return Promise.reject(fake.downloadError);
        }
        return Promise.resolve(fake.downloadId);
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

// ---------------------------------------------------------------------------

let fake: ChromeFake;
const noSender = {} as chrome.runtime.MessageSender;

beforeEach(() => {
  ensureCrypto();
  fake = installChromeFake();
  resetIdentityCache();
  clearHandlers();
  installScreenshot();
});

afterEach(() => {
  clearHandlers();
  resetIdentityCache();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

// ---------------------------------------------------------------------------
// SCREENSHOT_CAPTURE_VISIBLE (Req 9.5)
// ---------------------------------------------------------------------------

describe("SCREENSHOT_CAPTURE_VISIBLE (task 13.5, Req 9.5)", () => {
  it("returns { dataUrl } from a successful captureVisibleTab", async () => {
    fake.captureDefault = {
      kind: "resolve",
      value: "data:image/png;base64,AAAA",
    };

    const response = await dispatch(
      createMessage(ScreenshotMessageType.CAPTURE_VISIBLE, undefined),
      noSender,
    );

    expect(isOk(response)).toBe(true);
    if (isOk(response)) {
      expect(response.data).toEqual({ dataUrl: "data:image/png;base64,AAAA" });
    }
    // A single capture call was made.
    expect(fake.captureWindowIds).toHaveLength(1);
  });

  it("passes the sender tab's windowId to captureVisibleTab", async () => {
    const sender = {
      tab: { windowId: 7 },
    } as unknown as chrome.runtime.MessageSender;

    await dispatch(
      createMessage(ScreenshotMessageType.CAPTURE_VISIBLE, undefined),
      sender,
    );

    expect(fake.captureWindowIds[0]).toBe(7);
  });

  it("retries a rejected capture then succeeds (Req 9.5)", async () => {
    // First attempt rejects (simulating the per-second rate limit), the retry
    // resolves. The handler backs off and tries again rather than failing.
    fake.captureQueue = [
      { kind: "reject", error: new Error("MAX_CAPTURE_VISIBLE_TABS_PER_SECOND") },
    ];
    fake.captureDefault = {
      kind: "resolve",
      value: "data:image/png;base64,RETRY_OK",
    };

    const response = await dispatch(
      createMessage(ScreenshotMessageType.CAPTURE_VISIBLE, undefined),
      noSender,
    );

    expect(isOk(response)).toBe(true);
    if (isOk(response)) {
      expect(response.data).toEqual({
        dataUrl: "data:image/png;base64,RETRY_OK",
      });
    }
    // Two calls: the rejected attempt + the successful retry.
    expect(fake.captureWindowIds).toHaveLength(2);
  });

  it("surfaces CAPTURE_FAILED after exhausting all attempts (Req 9.6)", async () => {
    // Every attempt rejects -> the handler gives up with a CAPTURE_FAILED error.
    fake.captureDefault = {
      kind: "reject",
      error: new Error("still rate limited"),
    };

    const response = await dispatch(
      createMessage(ScreenshotMessageType.CAPTURE_VISIBLE, undefined),
      noSender,
    );

    expect(isErr(response)).toBe(true);
    if (isErr(response)) {
      expect(response.error.code).toBe(ErrorCode.CAPTURE_FAILED);
    }
    // It made the maximum number of attempts before giving up.
    expect(fake.captureWindowIds.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// SCREENSHOT_DOWNLOAD (Req 9.5)
// ---------------------------------------------------------------------------

describe("SCREENSHOT_DOWNLOAD (task 13.5, Req 9.5)", () => {
  it("calls chrome.downloads.download({ saveAs: false }) and returns { downloadId }", async () => {
    fake.downloadId = 99;

    const response = await dispatch(
      createMessage(ScreenshotMessageType.DOWNLOAD, {
        url: "data:application/pdf;base64,JVBER",
        filename: "alpha/page.pdf",
      }),
      noSender,
    );

    expect(isOk(response)).toBe(true);
    if (isOk(response)) {
      expect(response.data).toEqual({ downloadId: 99 });
    }
    expect(fake.downloadCalls).toHaveLength(1);
    expect(fake.downloadCalls[0]).toEqual({
      url: "data:application/pdf;base64,JVBER",
      filename: "alpha/page.pdf",
      saveAs: false,
    });
  });

  it("maps a download failure to a CAPTURE_FAILED error response", async () => {
    fake.downloadError = new Error("download blocked");

    const response = await dispatch(
      createMessage(ScreenshotMessageType.DOWNLOAD, {
        url: "data:image/png;base64,AAAA",
        filename: "shot.png",
      }),
      noSender,
    );

    expect(isErr(response)).toBe(true);
    if (isErr(response)) {
      expect(response.error.code).toBe(ErrorCode.CAPTURE_FAILED);
    }
  });
});

// ---------------------------------------------------------------------------
// SCREENSHOT_CHECKPOINT + readScreenshotCheckpoint (Req 22.3)
// ---------------------------------------------------------------------------

describe("SCREENSHOT_CHECKPOINT resume marker (task 13.5, Req 22.3)", () => {
  it("writes a checkpoint readable via readScreenshotCheckpoint", async () => {
    const opId = "op-1";

    const response = await dispatch(
      createMessage(ScreenshotMessageType.CHECKPOINT, {
        opId,
        progress: 0.5,
        state: { captured: 2, total: 4 },
      }),
      noSender,
    );

    expect(isOk(response)).toBe(true);
    if (isOk(response)) {
      expect(response.data).toEqual({ written: true });
    }

    const checkpoint = await readScreenshotCheckpoint(opId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint).toMatchObject({
      opId,
      kind: "screenshot",
      progress: 0.5,
      state: { captured: 2, total: 4 },
    });
  });

  it("clears the checkpoint when done:true so readScreenshotCheckpoint returns undefined (Req 22.3)", async () => {
    const opId = "op-2";

    // Write, then complete the operation.
    await dispatch(
      createMessage(ScreenshotMessageType.CHECKPOINT, {
        opId,
        progress: 0.8,
        state: { captured: 4, total: 5 },
      }),
      noSender,
    );
    expect(await readScreenshotCheckpoint(opId)).toBeDefined();

    const done = await dispatch(
      createMessage(ScreenshotMessageType.CHECKPOINT, { opId, done: true }),
      noSender,
    );

    expect(isOk(done)).toBe(true);
    if (isOk(done)) {
      expect(done.data).toEqual({ written: false });
    }
    expect(await readScreenshotCheckpoint(opId)).toBeUndefined();
  });

  it("clamps out-of-range progress into [0, 1]", async () => {
    await dispatch(
      createMessage(ScreenshotMessageType.CHECKPOINT, {
        opId: "op-3",
        progress: 5,
      }),
      noSender,
    );

    const checkpoint = await readScreenshotCheckpoint("op-3");
    expect(checkpoint?.progress).toBe(1);
  });
});
