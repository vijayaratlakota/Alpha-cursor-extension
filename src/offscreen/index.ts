/**
 * Alpha Cursor — OCR offscreen document (Tool 10, Req 15).
 *
 * ## Why an offscreen document
 * tesseract.js runs its recognition engine in a Web Worker. A Worker created
 * from a CONTENT SCRIPT is governed by the HOST PAGE's Content Security Policy
 * — and strict sites like YouTube allow neither `blob:` NOR `chrome-extension:`
 * worker scripts, so the worker can never spawn there ("Creating a worker from
 * '…' violates the following Content Security Policy directive"). An OFFSCREEN
 * document, by contrast, runs under the EXTENSION's own CSP, where loading our
 * bundled worker from `'self'` is allowed. So we move OCR off the page and into
 * here.
 *
 * ## Flow
 * The content script sends `OCR_RECOGNIZE { imageDataUrl }` (a PNG of the
 * cropped selection — page-tab crop or direct video frame). The background
 * ensures this offscreen document exists, then the message is delivered here
 * (it carries `target: "offscreen"` so the background router ignores it). We
 * run bundled tesseract.js and reply with the recognized text.
 */

import { createWorker } from "tesseract.js";
import { DEFAULT_OCR_LANG, localWorkerOptions } from "../tools/ocr/tesseractAssets";
import {
  OffscreenMessageType,
  type OcrRecognizePayload,
  type OcrRecognizeResult,
} from "../shared/offscreen";
import { type Message, type Response, makeError, ErrorCode } from "../shared/messaging";

/** Run bundled tesseract.js over the image data URL and return trimmed text. */
async function recognize(imageDataUrl: string): Promise<string> {
  const worker = await createWorker(DEFAULT_OCR_LANG, undefined, {
    ...localWorkerOptions(),
  });
  try {
    // tesseract.js accepts a data URL string as an `ImageLike` and decodes it
    // inside the worker — no DOM/canvas needed in the offscreen document.
    const result = await worker.recognize(imageDataUrl);
    return result.data.text.trim();
  } finally {
    await worker.terminate();
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: Message<OcrRecognizePayload>,
    _sender,
    sendResponse: (response: Response<OcrRecognizeResult>) => void,
  ): boolean => {
    // Only handle OCR recognition messages addressed to the offscreen document.
    if (
      !message ||
      message.target !== "offscreen" ||
      message.type !== OffscreenMessageType.RECOGNIZE
    ) {
      return false;
    }

    void (async () => {
      try {
        const text = await recognize(message.payload.imageDataUrl);
        sendResponse({ ok: true, data: { text } });
      } catch (error) {
        sendResponse({
          ok: false,
          error: makeError(
            ErrorCode.UNKNOWN,
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
    })();

    // Keep the channel open for the async sendResponse.
    return true;
  },
);
