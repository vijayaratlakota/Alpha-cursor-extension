/**
 * Alpha Cursor — Tool 10 "OCR Text Extraction" content wiring (task 19.3, Req 15).
 *
 * Registers the {@link ToolId.TEXT_EXTRACTION} handler in the content-script
 * tool catalog. The tool is shown for the `generic-page`, `image`, AND `video`
 * contexts (see `src/content/tools.ts`), so a single uniform flow covers all
 * three (Req 15.1). When invoked it:
 *
 *   1. Mounts a full-viewport CLOSED Shadow DOM overlay with a crosshair cursor
 *      and lets the user drag a rectangular OCR_Selection (mousedown →
 *      mousemove → mouseup), visualised with a Notion-styled selection box
 *      (Req 15.2). The drag rect is computed by the pure
 *      {@link normalizeSelectionRect} (property-tested in task 19.2).
 *   2. On mouseup the overlay is hidden and the visible tab is captured via the
 *      background `OCR_CAPTURE_VISIBLE_TAB` message (privileged capture lives in
 *      the service worker). The returned PNG data URL is the *rendered* tab, so
 *      it already includes page text, image pixels, and the current video frame
 *      uniformly (Req 15.3).
 *   3. The selected region is cropped from the capture onto a canvas, scaling
 *      the CSS-pixel selection rect by `devicePixelRatio` because
 *      `captureVisibleTab` returns a device-pixel bitmap.
 *   4. Bundled `tesseract.js` (local WASM core + worker + `eng.traineddata.gz`,
 *      never a CDN — Req 22.2) recognises text in the cropped canvas (Req 15.3).
 *   5. If text is found it is copied to the clipboard and a success toast is
 *      shown (Req 15.4); if no text is found a notification is shown and the
 *      clipboard is left untouched (Req 15.5).
 *
 * Escape at ANY point during selection (or while OCR is running) cancels the
 * whole flow, tears down the overlay, and writes nothing to the clipboard
 * (Req 15.6).
 *
 * The pure geometry helper lives in `./selectionRect`; the local-asset wiring
 * for tesseract lives in `./tesseractAssets`; the privileged capture lives in
 * `src/background/ocrHandlers.ts`.
 */

import { createWorker } from "tesseract.js";
import { normalizeSelectionRect, type SelectionRect } from "./selectionRect";
import { DEFAULT_OCR_LANG, localWorkerOptions } from "./tesseractAssets";
import { createShadowHost, type ShadowHostHandle } from "../../ui/shadowHost";
import { joinClasses } from "../../ui/primitives/classNames";
import { notify } from "../../ui/notify";
import { createMessage, isOk, type Response } from "../../shared/messaging";
import { ErrorCode } from "../../shared/messaging";
import { registerTool, ToolId, type ToolRun } from "../../content/tools";
import {
  OcrMessageType,
  type OcrCaptureResult,
} from "../../background/ocrHandlers";

/** Toast text when extracted text is copied (Req 15.4). */
const COPIED_TEXT = "text extracted and copied";
/** Toast text when the selection contained no detectable text (Req 15.5). */
const NO_TEXT_TEXT = "no text found in the selection";
/** Toast text when capture/recognition fails outright. */
const FAILED_TEXT = "could not extract text";
/**
 * Minimum selection size (CSS px) for which OCR is attempted. A click or a
 * tiny accidental drag is treated as a no-op cancel rather than an OCR run.
 */
const MIN_SELECTION_PX = 4;

/**
 * Send a typed message to the background router and resolve with its
 * `Response<R>`. Mirrors the helper used by the other content-side tools so a
 * missing/duplicate response always becomes a discriminated error branch.
 */
function sendToBackground<T, R>(type: string, payload: T): Promise<Response<R>> {
  return new Promise<Response<R>>((resolve) => {
    try {
      chrome.runtime.sendMessage(
        createMessage(type, payload),
        (response: Response<R>) => {
          const lastError = chrome.runtime?.lastError;
          if (lastError || !response) {
            resolve({
              ok: false,
              error: {
                code: ErrorCode.CAPTURE_FAILED,
                message: lastError?.message ?? "No response from background.",
                recoverable: true,
              },
            });
            return;
          }
          resolve(response);
        },
      );
    } catch (cause) {
      resolve({
        ok: false,
        error: {
          code: ErrorCode.CAPTURE_FAILED,
          message: cause instanceof Error ? cause.message : String(cause),
          recoverable: true,
        },
      });
    }
  });
}

/** Module-level handle to the active OCR overlay, if any. */
let activeOverlay: ShadowHostHandle | null = null;

/** Returns `true` while the OCR selection overlay is open. */
export function isOcrOverlayOpen(): boolean {
  return activeOverlay !== null && !activeOverlay.destroyed;
}

/**
 * The outcome of the drag-selection overlay: either a normalized selection rect
 * (CSS px, viewport coordinates) or `null` when the user cancelled (Escape) or
 * produced no usable drag.
 */
type SelectionOutcome =
  | { kind: "selected"; rect: SelectionRect }
  | { kind: "cancelled" };

/**
 * Open the full-viewport drag-selection overlay and resolve with the selected
 * rectangle (or a cancellation). The overlay is always torn down before the
 * promise resolves so the page is interactive again before capture runs (the
 * overlay must not appear in the screenshot).
 */
function selectRegion(): Promise<SelectionOutcome> {
  return new Promise<SelectionOutcome>((resolve) => {
    const handle = createShadowHost({
      overlay: "full-viewport",
      surfaceId: "ocr-overlay",
    });
    activeOverlay = handle;

    // Full-surface crosshair catcher (the host itself is pointer-events:none).
    const catcher = document.createElement("div");
    catcher.setAttribute("role", "presentation");
    catcher.className = joinClasses(
      "fixed inset-0 pointer-events-auto cursor-crosshair",
      "bg-[rgba(15,15,15,0.08)]",
    );

    // The visualised selection box (Notion blue accent, hidden until dragging).
    const box = document.createElement("div");
    box.className = joinClasses(
      "absolute box-border rounded-sm pointer-events-none hidden",
      "border-2 border-primary bg-[rgba(35,131,226,0.12)]",
    );
    catcher.appendChild(box);

    handle.mount(catcher);

    let dragging = false;
    let settled = false;
    let startX = 0;
    let startY = 0;

    const cleanup = (): void => {
      window.removeEventListener("keydown", onKeyDown, true);
      catcher.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      handle.destroy();
      if (activeOverlay === handle) activeOverlay = null;
    };

    /** Resolve exactly once, tearing the overlay down first. */
    const finish = (outcome: SelectionOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const drawBox = (rect: SelectionRect): void => {
      box.style.left = `${rect.x}px`;
      box.style.top = `${rect.y}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Escape cancels the whole flow (Req 15.6).
      event.preventDefault();
      event.stopPropagation();
      finish({ kind: "cancelled" });
    };

    const onMouseDown = (event: MouseEvent): void => {
      // Only the primary button starts a selection.
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      box.classList.remove("hidden");
      drawBox({ x: startX, y: startY, width: 0, height: 0 });
    };

    const onMouseMove = (event: MouseEvent): void => {
      if (!dragging) return;
      event.preventDefault();
      drawBox(
        normalizeSelectionRect(
          { x: startX, y: startY },
          { x: event.clientX, y: event.clientY },
        ),
      );
    };

    const onMouseUp = (event: MouseEvent): void => {
      if (!dragging) return;
      event.preventDefault();
      event.stopPropagation();
      dragging = false;
      const rect = normalizeSelectionRect(
        { x: startX, y: startY },
        { x: event.clientX, y: event.clientY },
      );
      if (rect.width < MIN_SELECTION_PX || rect.height < MIN_SELECTION_PX) {
        // Treat a click / negligible drag as a cancel — nothing to OCR.
        finish({ kind: "cancelled" });
        return;
      }
      finish({ kind: "selected", rect });
    };

    catcher.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
    // Capture Escape at the window level so it works regardless of focus.
    window.addEventListener("keydown", onKeyDown, true);
  });
}

/** Decode a PNG data URL into an `HTMLImageElement`. */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error("Failed to decode the captured tab image"));
    img.src = dataUrl;
  });
}

/**
 * Crop the selected region out of the captured tab image onto a canvas. The
 * selection rect is in CSS pixels but `captureVisibleTab` returns a
 * device-pixel bitmap, so the rect is scaled by `devicePixelRatio` and clamped
 * to the captured image bounds. Returns `null` when the region has no area.
 */
function cropRegion(
  image: HTMLImageElement,
  rect: SelectionRect,
): HTMLCanvasElement | null {
  const dpr =
    typeof window.devicePixelRatio === "number" && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;

  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.min(
    Math.round(rect.width * dpr),
    Math.max(0, image.naturalWidth - sx),
  );
  const sh = Math.min(
    Math.round(rect.height * dpr),
    Math.max(0, image.naturalHeight - sy),
  );

  if (sw <= 0 || sh <= 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

/**
 * Run bundled tesseract.js over the cropped canvas and return the recognised
 * text (trimmed). The worker is created with LOCAL asset paths only (Req 22.2)
 * and is always terminated, even on error, so no worker/WASM instance leaks.
 */
async function recognizeText(canvas: HTMLCanvasElement): Promise<string> {
  const worker = await createWorker(DEFAULT_OCR_LANG, undefined, {
    ...localWorkerOptions(),
  });
  try {
    const result = await worker.recognize(canvas);
    return result.data.text.trim();
  } finally {
    await worker.terminate();
  }
}

/**
 * Copy extracted text to the clipboard and notify success (Req 15.4). Returns
 * `false` (showing an error toast) if the clipboard write fails.
 */
async function copyAndNotify(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    notify({
      kind: "error",
      text: FAILED_TEXT,
      code: ErrorCode.CLIPBOARD_FAILED,
    });
    return false;
  }
  notify({ kind: "success", text: COPIED_TEXT });
  return true;
}

/**
 * The {@link ToolId.TEXT_EXTRACTION} run handler. Drives the full OCR flow:
 * region selection → capture → crop → recognise → copy/notify, with Escape
 * cancelling at any point (Req 15.2–15.6).
 */
const runOcr: ToolRun = async (): Promise<void> => {
  const outcome = await selectRegion();
  if (outcome.kind === "cancelled") {
    // Escape / click / negligible drag → silent cancel, no clipboard (Req 15.6).
    return;
  }

  const capture = await sendToBackground<void, OcrCaptureResult>(
    OcrMessageType.CAPTURE_VISIBLE_TAB,
    undefined,
  );
  if (!isOk(capture)) {
    notify({
      kind: "error",
      text: FAILED_TEXT,
      code: capture.error.code,
    });
    return;
  }

  try {
    const image = await loadImage(capture.data.dataUrl);
    const canvas = cropRegion(image, outcome.rect);
    if (!canvas) {
      notify({ kind: "info", text: NO_TEXT_TEXT, code: ErrorCode.OCR_NO_TEXT });
      return;
    }

    const text = await recognizeText(canvas);
    if (text === "") {
      // No text detected → notify, do NOT touch the clipboard (Req 15.5).
      notify({ kind: "info", text: NO_TEXT_TEXT, code: ErrorCode.OCR_NO_TEXT });
      return;
    }

    await copyAndNotify(text);
  } catch (error) {
    notify({
      kind: "error",
      text: FAILED_TEXT,
      code: ErrorCode.UNKNOWN,
    });
    // Surface the underlying reason to the console for debugging; the user-
    // facing path is the toast above.
    console.error("[acx] OCR extraction failed:", error);
  }
};

/**
 * Install the real "Text extraction" behavior into the tool catalog, replacing
 * the placeholder stub (Req 15.1–15.6). Wired by the content-script
 * orchestrator at init time (not edited by this task).
 *
 * @returns `true` if the tool was registered (always, unless the catalog id
 * changes).
 */
export function registerOcrTool(): boolean {
  return registerTool(ToolId.TEXT_EXTRACTION, runOcr);
}
