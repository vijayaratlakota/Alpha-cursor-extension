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

import { normalizeSelectionRect, type SelectionRect } from "./selectionRect";
import { createShadowHost, type ShadowHostHandle } from "../../ui/shadowHost";
import { joinClasses } from "../../ui/primitives/classNames";
import { notify } from "../../ui/notify";
import { createMessage, isOk, type Response } from "../../shared/messaging";
import { ErrorCode } from "../../shared/messaging";
import { getCachedFeatureFlags } from "../../shared/settings";
import { registerTool, ToolId, type ToolRun } from "../../content/tools";
import {
  NotepadMessageType,
  type NotepadAppendPayload,
  type NotepadAppendResult,
} from "../notepad/notepad";
import {
  OcrMessageType,
  type OcrCaptureResult,
  type OcrEnsureOffscreenResult,
} from "../../background/ocrHandlers";
import {
  OffscreenMessageType,
  type OcrRecognizePayload,
  type OcrRecognizeResult,
} from "../../shared/offscreen";

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

/**
 * Send a message to the OCR offscreen document and resolve with its `Response`.
 * The message carries `target: "offscreen"` so the background router ignores it
 * and only the offscreen document answers. `chrome.runtime.sendMessage`
 * broadcasts to all extension contexts; the offscreen listener filters by type.
 */
function sendToOffscreen<T, R>(type: string, payload: T): Promise<Response<R>> {
  return new Promise<Response<R>>((resolve) => {
    try {
      const message = { ...createMessage(type, payload), target: "offscreen" };
      chrome.runtime.sendMessage(message, (response: Response<R>) => {
        const lastError = chrome.runtime?.lastError;
        if (lastError || !response) {
          resolve({
            ok: false,
            error: {
              code: ErrorCode.UNKNOWN,
              message: lastError?.message ?? "OCR engine did not respond.",
              recoverable: true,
            },
          });
          return;
        }
        resolve(response);
      });
    } catch (cause) {
      resolve({
        ok: false,
        error: {
          code: ErrorCode.UNKNOWN,
          message: cause instanceof Error ? cause.message : String(cause),
          recoverable: true,
        },
      });
    }
  });
}

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
      "border-2 border-hairline bg-[rgba(255,217,19,0.25)]",
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
 * Find a `<video>` element that (a) overlaps the selection rect and (b) actually
 * has decoded frame data we can draw. `captureVisibleTab` composites a BLACK
 * box over hardware-accelerated/playing video, so OCR over a video frame must
 * read pixels straight from the element instead. Returns the best-overlapping
 * ready video, or `null` when none qualifies (page/image OCR falls back to the
 * tab capture).
 */
function findVideoForSelection(rect: SelectionRect): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video"));
  let best: HTMLVideoElement | null = null;
  let bestOverlap = 0;

  for (const video of videos) {
    // HAVE_CURRENT_DATA (2) or better means a frame is available to draw.
    if (video.readyState < 2) continue;
    if (video.videoWidth === 0 || video.videoHeight === 0) continue;

    const b = video.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;

    // Intersection area between the selection and the video's viewport box.
    const ix = Math.max(rect.x, b.left);
    const iy = Math.max(rect.y, b.top);
    const iw = Math.min(rect.x + rect.width, b.right) - ix;
    const ih = Math.min(rect.y + rect.height, b.bottom) - iy;
    if (iw <= 0 || ih <= 0) continue;

    const overlap = iw * ih;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = video;
    }
  }
  return best;
}

/**
 * Crop the selection region directly out of a `<video>` element's current
 * frame. The video is drawn to an offscreen canvas at its native resolution,
 * then the portion of the selection that overlaps the video's on-screen box is
 * mapped from CSS/viewport coordinates into the video's intrinsic pixel space
 * (accounting for `object-fit: contain/cover` letterboxing). Returns `null`
 * when the selection does not overlap the rendered frame or the frame can't be
 * read (e.g. a cross-origin/DRM-tainted canvas).
 */
function cropVideoFrame(
  video: HTMLVideoElement,
  rect: SelectionRect,
): HTMLCanvasElement | null {
  const box = video.getBoundingClientRect();

  // The intersection of the selection with the video's on-screen box (CSS px).
  const ix = Math.max(rect.x, box.left);
  const iy = Math.max(rect.y, box.top);
  const iw = Math.min(rect.x + rect.width, box.right) - ix;
  const ih = Math.min(rect.y + rect.height, box.bottom) - iy;
  if (iw <= 0 || ih <= 0) return null;

  const vw = video.videoWidth;
  const vh = video.videoHeight;

  // Work out how the intrinsic frame is laid out inside the element box. Most
  // players use object-fit: contain (letterboxed); handle contain + fill, which
  // covers the common cases without over-engineering cover/none.
  const objectFit = getComputedStyle(video).objectFit || "contain";
  let renderW = box.width;
  let renderH = box.height;
  let offsetX = 0;
  let offsetY = 0;
  if (objectFit === "contain" || objectFit === "scale-down") {
    const scale = Math.min(box.width / vw, box.height / vh);
    renderW = vw * scale;
    renderH = vh * scale;
    offsetX = (box.width - renderW) / 2;
    offsetY = (box.height - renderH) / 2;
  } else if (objectFit === "cover") {
    const scale = Math.max(box.width / vw, box.height / vh);
    renderW = vw * scale;
    renderH = vh * scale;
    offsetX = (box.width - renderW) / 2;
    offsetY = (box.height - renderH) / 2;
  }
  // else "fill"/default: render fills the box (offset 0, renderW/H = box).

  // Map the intersection (relative to the element box) into the rendered frame,
  // then into intrinsic video pixels.
  const relX = ix - box.left - offsetX;
  const relY = iy - box.top - offsetY;
  const sx = (relX / renderW) * vw;
  const sy = (relY / renderH) * vh;
  const sw = (iw / renderW) * vw;
  const sh = (ih / renderH) * vh;

  // Clamp to the frame bounds.
  const cx = Math.max(0, Math.min(sx, vw));
  const cy = Math.max(0, Math.min(sy, vh));
  const cw = Math.max(0, Math.min(sw, vw - cx));
  const ch = Math.max(0, Math.min(sh, vh - cy));
  if (cw < 1 || ch < 1) return null;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cw);
  canvas.height = Math.round(ch);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(
      video,
      cx,
      cy,
      cw,
      ch,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    // Touch the pixels to force a security error NOW if the frame is tainted
    // (cross-origin/DRM), so we can fall back rather than OCR a blank canvas.
    ctx.getImageData(0, 0, 1, 1);
  } catch {
    return null;
  }
  return canvas;
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
 * Recognise text in `canvas` by handing the cropped image to the OCR offscreen
 * document, which runs the bundled tesseract.js worker under the EXTENSION's
 * CSP. Running OCR in the page context fails on strict-CSP sites (YouTube),
 * where the page CSP blocks the tesseract worker; the offscreen document avoids
 * that entirely. Returns the recognised text (trimmed), or throws on failure.
 */
async function recognizeText(canvas: HTMLCanvasElement): Promise<string> {
  // Make sure the offscreen worker host exists before sending the image.
  const ensured = await sendToBackground<void, OcrEnsureOffscreenResult>(
    OcrMessageType.ENSURE_OFFSCREEN,
    undefined,
  );
  if (!isOk(ensured) || ensured.data.ready !== true) {
    throw new Error(
      isOk(ensured)
        ? "OCR engine could not start"
        : ensured.error.message,
    );
  }

  const imageDataUrl = canvas.toDataURL("image/png");
  const response = await sendToOffscreen<OcrRecognizePayload, OcrRecognizeResult>(
    OffscreenMessageType.RECOGNIZE,
    { imageDataUrl },
  );
  if (!isOk(response)) {
    throw new Error(response.error.message);
  }
  return response.data.text;
}

/**
 * Copy extracted text to the clipboard and notify success (Req 15.4). Also
 * appends the text to the Notepad when the `ocrToNotepad` feature flag is on
 * (default), so OCR results join the "Copy All" history. Returns `false`
 * (showing an error toast) if the clipboard write fails.
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

  // Also save into the Notepad history unless the user disabled it.
  if (getCachedFeatureFlags().ocrToNotepad) {
    const sourceUrl =
      (globalThis as { location?: Location }).location?.href ?? undefined;
    const payload: NotepadAppendPayload = sourceUrl ? { text, sourceUrl } : { text };
    void sendToBackground<NotepadAppendPayload, NotepadAppendResult>(
      NotepadMessageType.APPEND,
      payload,
    );
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

  // 1) Video-frame path (Req 15.3): `captureVisibleTab` renders playing/
  //    hardware-accelerated video as a BLACK box, so if the selection overlaps
  //    a ready <video> we read the frame pixels directly from the element.
  const video = findVideoForSelection(outcome.rect);
  if (video) {
    try {
      const videoCanvas = cropVideoFrame(video, outcome.rect);
      if (videoCanvas) {
        const text = await recognizeText(videoCanvas);
        if (text === "") {
          notify({ kind: "info", text: NO_TEXT_TEXT, code: ErrorCode.OCR_NO_TEXT });
          return;
        }
        await copyAndNotify(text);
        return;
      }
      // videoCanvas === null → frame unreadable (tainted/cross-origin); fall
      // through to the tab-capture path below as a best effort.
    } catch (error) {
      console.error("[acx] OCR video-frame extraction failed:", error);
      // Fall through to the tab-capture path.
    }
  }

  // 2) Page/image path: capture the rendered tab and crop the selection.
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
