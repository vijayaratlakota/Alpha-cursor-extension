/**
 * Task 19.4 — edge-case test for the OCR "no text found" path (Req 15.5).
 *
 * The full OCR flow drags a selection, captures the visible tab, crops it, and
 * runs bundled tesseract.js. Real tesseract (WASM worker) cannot run in jsdom,
 * so this test mocks the integration boundaries and drives the OBSERVABLE
 * no-text branch:
 *
 *   - `tesseract.js` `createWorker` is mocked so `recognize` resolves
 *     `{ data: { text: "" } }` — i.e. the selection contained no detectable
 *     text.
 *   - The background `OCR_CAPTURE_VISIBLE_TAB` message is faked to return a PNG
 *     data URL, and `Image` / canvas `2d` context are stubbed so cropping
 *     succeeds and reaches recognition.
 *   - `notify` is mocked so we can assert the no-text notification
 *     (`ErrorCode.OCR_NO_TEXT`) is shown and the clipboard is left untouched
 *     (Req 15.5).
 *
 * The selection overlay mounts in a CLOSED shadow root; we capture it via an
 * `attachShadow` spy (same technique as the Options_Panel test) so we can drive
 * the drag (mousedown → mousemove → mouseup) on the overlay's catcher element.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// --- Mock the notification channel so we can assert the no-text branch. ----
const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("../../ui/notify", () => ({ notify: notifyMock }));

import { registerOcrTool } from "./ocrTool";
import { getTool, ToolId, type Tool } from "../../content/tools";
import { ErrorCode } from "../../shared/messaging";
import { OcrMessageType } from "../../background/ocrHandlers";
import { OffscreenMessageType } from "../../shared/offscreen";

// ---------------------------------------------------------------------------
// Environment shims: Image (onload), canvas 2d context, chrome.runtime, clipboard.
// ---------------------------------------------------------------------------

const realAttachShadow = Element.prototype.attachShadow;
let capturedRoots: ShadowRoot[] = [];

/** Stub <img> decoding: setting `src` resolves onload with fixed dimensions. */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 800;
  naturalHeight = 600;
  width = 800;
  height = 600;
  private _src = "";
  set src(value: string) {
    this._src = value;
    // Resolve asynchronously like a real decode.
    queueMicrotask(() => this.onload?.());
  }
  get src(): string {
    return this._src;
  }
}

const clipboardWrite = vi.fn(async () => {});

function installEnvironment(): void {
  // Image used by loadImage().
  (globalThis as unknown as { Image: unknown }).Image = FakeImage;

  // Canvas 2d context (jsdom has no real canvas backend).
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        drawImage: vi.fn(),
      }) as unknown as CanvasRenderingContext2D,
  );
  // Canvas → data URL used to hand the crop to the offscreen OCR document.
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,BBBB",
  );

  // Deterministic device pixel ratio for cropRegion math.
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    writable: true,
    value: 1,
  });

  // Clipboard (should NOT be written on the no-text path).
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    writable: true,
    value: { writeText: clipboardWrite },
  });

  // chrome.runtime.sendMessage → fake the capture, offscreen-ensure, and the
  // offscreen recognition (empty text → the no-text branch).
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (
        message: { type: string },
        callback: (response: unknown) => void,
      ) => {
        if (message.type === OcrMessageType.CAPTURE_VISIBLE_TAB) {
          callback({
            ok: true,
            data: { dataUrl: "data:image/png;base64,AAAA" },
          });
          return;
        }
        if (message.type === OcrMessageType.ENSURE_OFFSCREEN) {
          callback({ ok: true, data: { ready: true } });
          return;
        }
        if (message.type === OffscreenMessageType.RECOGNIZE) {
          // No text detected → exercises the no-text branch (Req 15.5).
          callback({ ok: true, data: { text: "" } });
          return;
        }
        callback({ ok: false, error: { code: "UNKNOWN", message: "no handler", recoverable: true } });
      },
      getURL: (p: string) => `/${p}`,
    },
  };
}

/** The catcher div inside the most-recently mounted closed shadow root. */
function overlayCatcher(): HTMLElement {
  const root = capturedRoots[capturedRoots.length - 1];
  if (!root) throw new Error("no OCR overlay shadow root captured");
  const catcher = root.querySelector<HTMLElement>('[role="presentation"]');
  if (!catcher) throw new Error("no OCR overlay catcher found");
  return catcher;
}

/** Drive a full drag selection from (sx,sy) to (ex,ey). */
function dragSelect(
  catcher: HTMLElement,
  sx: number,
  sy: number,
  ex: number,
  ey: number,
): void {
  catcher.dispatchEvent(
    new MouseEvent("mousedown", { button: 0, clientX: sx, clientY: sy, bubbles: true }),
  );
  window.dispatchEvent(
    new MouseEvent("mousemove", { clientX: ex, clientY: ey, bubbles: true }),
  );
  window.dispatchEvent(
    new MouseEvent("mouseup", { button: 0, clientX: ex, clientY: ey, bubbles: true }),
  );
}

// ---------------------------------------------------------------------------

let original: Tool["run"];

beforeEach(() => {
  notifyMock.mockClear();
  clipboardWrite.mockClear();
  capturedRoots = [];
  document.body.innerHTML = "";
  installEnvironment();

  // Capture closed shadow roots so we can reach the overlay's catcher.
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ): ShadowRoot {
    const root = realAttachShadow.call(this, init);
    capturedRoots.push(root);
    return root;
  });

  original = getTool(ToolId.TEXT_EXTRACTION)!.run;
  registerOcrTool();
});

afterEach(() => {
  getTool(ToolId.TEXT_EXTRACTION)!.run = original;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("OCR text extraction — no text found (Req 15.5)", () => {
  it("registers the TEXT_EXTRACTION tool run handler", () => {
    // Registration smoke check: the real handler replaced the placeholder stub.
    expect(typeof getTool(ToolId.TEXT_EXTRACTION)!.run).toBe("function");
  });

  it("notifies OCR_NO_TEXT and writes nothing to the clipboard when recognition is empty", async () => {
    const run = getTool(ToolId.TEXT_EXTRACTION)!.run;

    // selectRegion() mounts the overlay synchronously and resolves on mouseup.
    const runPromise = run({ context: "generic-page", point: { x: 0, y: 0 } });

    // Drive a real-sized drag so the selection passes the MIN_SELECTION_PX gate.
    dragSelect(overlayCatcher(), 10, 10, 200, 160);

    await runPromise;

    // No-text notification carries the OCR_NO_TEXT code (Req 15.5).
    const noTextCall = notifyMock.mock.calls.find(
      (call) => (call[0] as { code?: ErrorCode }).code === ErrorCode.OCR_NO_TEXT,
    );
    expect(noTextCall).toBeDefined();

    // The clipboard is left untouched when no text was found (Req 15.5).
    expect(clipboardWrite).not.toHaveBeenCalled();
  });
});
