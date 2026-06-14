/**
 * Alpha Cursor — offscreen document message contract (Tool 10 OCR).
 *
 * Shared between the content script (sender), the background (which ensures the
 * offscreen document exists), and the offscreen document itself (handler). Kept
 * in `shared/` with no other imports so every context can use it without
 * pulling in DOM- or worker-only code.
 */

/** Message types handled by the offscreen document. */
export const OffscreenMessageType = {
  /** Recognize text in a PNG data URL. Payload {@link OcrRecognizePayload}. */
  RECOGNIZE: "OCR_RECOGNIZE",
} as const;

/** Payload for {@link OffscreenMessageType.RECOGNIZE}. */
export interface OcrRecognizePayload {
  /** PNG (or any canvas-encodable) data URL of the cropped region to OCR. */
  imageDataUrl: string;
}

/** Result of {@link OffscreenMessageType.RECOGNIZE}. */
export interface OcrRecognizeResult {
  /** The recognized text, trimmed. Empty string when nothing was detected. */
  text: string;
}

/** Path (relative to the extension root) of the offscreen document. */
export const OFFSCREEN_DOCUMENT_PATH = "src/offscreen/index.html";
