// Background handler for Tool 10 — OCR Text Extraction (Req 15), task 19.3.
//
// The OCR flow rasterizes the user's drag-selected region by capturing the
// visible tab and cropping it on a canvas in the content script. Capturing the
// rendered viewport (`chrome.tabs.captureVisibleTab`) is a privileged operation
// that a content script cannot call directly, so it lives here in the service
// worker. Because the captured PNG is the *rendered* tab, it uniformly covers
// generic pages, images, AND playing video frames (Req 15.3) without any
// special per-context code.
//
// This handler deliberately defines its OWN message type
// (`OCR_CAPTURE_VISIBLE_TAB`) instead of reusing the screenshot tool's
// `SCREENSHOT_CAPTURE_VISIBLE`. Keeping a dedicated type makes Tool 10
// independent of the (separately-developed) screenshot tool — neither task can
// break the other by changing a shared message contract.
//
// `captureVisibleTab` is rate-limited by Chrome (it rejects with
// "MAX_CAPTURE_VISIBLE_TABS_PER_SECOND" when called too quickly). A single OCR
// capture is one call, so a short bounded retry is plenty to ride over a
// transient rate-limit collision with another capture-using tool.
//
// Required permissions (finalized in task 26.3): `"tabs"` + host access (or
// `"activeTab"`) for `captureVisibleTab`.

import { registerHandler } from "./router";
import { ErrorCode, makeError } from "@/shared/messaging";
import { OFFSCREEN_DOCUMENT_PATH } from "@/shared/offscreen";

/** Message type strings for the OCR background handlers. */
export const OcrMessageType = {
  /**
   * Capture the sender tab's visible viewport as a PNG data URL so the content
   * script can crop the OCR_Selection region from it. No payload. Returns
   * {@link OcrCaptureResult}.
   */
  CAPTURE_VISIBLE_TAB: "OCR_CAPTURE_VISIBLE_TAB",
  /**
   * Ensure the OCR offscreen document exists (creating it on first use). The
   * offscreen document hosts the tesseract.js worker under the EXTENSION's CSP
   * so OCR works even on strict-CSP pages (e.g. YouTube) where a page-context
   * worker is blocked. No payload. Returns {@link OcrEnsureOffscreenResult}.
   */
  ENSURE_OFFSCREEN: "OCR_ENSURE_OFFSCREEN",
} as const;

/** Result of an {@link OcrMessageType.CAPTURE_VISIBLE_TAB} request. */
export interface OcrCaptureResult {
  /** PNG data URL of the captured viewport (`data:image/png;base64,...`). */
  dataUrl: string;
}

/** Result of an {@link OcrMessageType.ENSURE_OFFSCREEN} request. */
export interface OcrEnsureOffscreenResult {
  /** `true` once the offscreen document is present (created or already open). */
  ready: boolean;
}

/** Max attempts for a single `captureVisibleTab` call before giving up. */
const CAPTURE_MAX_ATTEMPTS = 4;
/** Backoff between capture retries when the rate limit is hit (ms). */
const CAPTURE_RETRY_DELAY_MS = 500;

/** Promise-based sleep used for capture backoff. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capture the visible viewport of `windowId` (or the active window when
 * undefined) as a PNG data URL, retrying a few times on the rate-limit
 * rejection. Throws an `AppError` (`CAPTURE_FAILED`) when every attempt fails.
 */
async function captureVisible(windowId: number | undefined): Promise<string> {
  const tabs = (chrome as { tabs?: typeof chrome.tabs }).tabs;
  if (!tabs || typeof tabs.captureVisibleTab !== "function") {
    throw makeError(
      ErrorCode.CAPTURE_FAILED,
      "captureVisibleTab is not available in this context",
    );
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < CAPTURE_MAX_ATTEMPTS; attempt++) {
    try {
      const options: chrome.tabs.CaptureVisibleTabOptions = { format: "png" };
      const dataUrl =
        typeof windowId === "number"
          ? await tabs.captureVisibleTab(windowId, options)
          : await tabs.captureVisibleTab(options);
      if (typeof dataUrl === "string" && dataUrl.length > 0) {
        return dataUrl;
      }
      lastError = "captureVisibleTab returned an empty result";
    } catch (error) {
      lastError = error;
    }
    await delay(CAPTURE_RETRY_DELAY_MS);
  }

  const detail =
    lastError instanceof Error
      ? lastError.message
      : typeof lastError === "string"
        ? lastError
        : "unknown error";
  throw makeError(
    ErrorCode.CAPTURE_FAILED,
    `Failed to capture the visible tab for OCR: ${detail}`,
  );
}

/**
 * Ensure the OCR offscreen document exists, creating it on first use. Offscreen
 * documents host the tesseract.js worker under the extension's own CSP, which
 * is the only reliable way to run the worker on strict-CSP pages (YouTube etc.)
 * where a content-script-spawned worker is blocked. Idempotent: if the document
 * already exists this is a no-op. Requires the `"offscreen"` manifest
 * permission.
 */
async function ensureOffscreenDocument(): Promise<OcrEnsureOffscreenResult> {
  const offscreen = (chrome as { offscreen?: typeof chrome.offscreen }).offscreen;
  if (!offscreen || typeof offscreen.createDocument !== "function") {
    throw makeError(
      ErrorCode.UNKNOWN,
      "Offscreen documents are not available in this browser",
    );
  }

  // Avoid creating a second document: check for an existing one first.
  try {
    const hasDoc = (
      chrome as {
        offscreen?: { hasDocument?: () => Promise<boolean> };
      }
    ).offscreen?.hasDocument;
    if (typeof hasDoc === "function") {
      const exists = await hasDoc.call(chrome.offscreen);
      if (exists) return { ready: true };
    }
  } catch {
    /* fall through to createDocument; a duplicate create is caught below */
  }

  try {
    await offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["WORKERS" as chrome.offscreen.Reason],
      justification:
        "Run the bundled OCR (tesseract.js) worker under the extension CSP so text extraction works on strict-CSP pages.",
    });
  } catch (error) {
    // Creating while one already exists throws; treat that as success.
    const message = error instanceof Error ? error.message : String(error);
    if (/single offscreen|already|exists/i.test(message)) {
      return { ready: true };
    }
    throw makeError(ErrorCode.UNKNOWN, `Failed to open OCR offscreen: ${message}`);
  }
  return { ready: true };
}

/**
 * Register the OCR capture handler on the background router. Idempotent; safe to
 * call on every service-worker wake. Wired from `src/background/index.ts` (not
 * edited by this task).
 */
export function installOcr(): void {
  registerHandler<void, OcrCaptureResult>(
    OcrMessageType.CAPTURE_VISIBLE_TAB,
    async (_payload, sender) => {
      const windowId = sender?.tab?.windowId;
      const dataUrl = await captureVisible(windowId);
      return { dataUrl };
    },
  );

  registerHandler<void, OcrEnsureOffscreenResult>(
    OcrMessageType.ENSURE_OFFSCREEN,
    async () => ensureOffscreenDocument(),
  );
}
