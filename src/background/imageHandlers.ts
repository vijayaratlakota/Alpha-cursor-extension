// Background handler for Tool 5 — Save Image with Enhancement (Req 10), task 14.3.
//
// The Save-Image tool runs entirely in the content script: it fetches the
// source image, decodes it via `createImageBitmap` (WebP included, Req 10.4),
// optionally enhances it on a Canvas, and converts it to PNG / JPG (via
// `canvas.toBlob`) or PDF (via jsPDF). The ONE thing a content script cannot do
// is start a download — `chrome.downloads` is only reachable from the service
// worker (see design "Responsibility Split"). So the content script serializes
// the generated artifact to a self-contained `data:` URL and hands it here
// through a single `SAVE_IMAGE_DOWNLOAD { url, filename }` message; the worker
// then starts an automatic download (`saveAs: false`, Req 10.2/10.3/10.6).
//
// Why a `data:` URL rather than a blob object URL: `URL.createObjectURL` blobs
// are scoped to the originating page's context and are NOT resolvable from the
// background service worker, so the content script must serialize to a
// self-contained `data:` URL before sending (mirrors the screenshot download
// path in `screenshotHandlers.ts`).
//
// A failure to start the download surfaces as an `IMAGE_DECODE_FAILED`
// `AppError` (Req 10.5) which the router normalizes into an error `Response`;
// the content-script caller turns that into a "no download" notification.
//
// Registers on the shared background router and is idempotent on service-worker
// wake (`registerHandler` overwrites prior registrations).

import { registerHandler } from "./router";
import { ErrorCode, makeError } from "@/shared/messaging";

/** Message type strings for the Save-Image download bridge. */
export const ImageMessageType = {
  /**
   * Start an automatic download of a generated image/PDF artifact: payload
   * {@link ImageDownloadPayload}. Returns {@link ImageDownloadResult}.
   */
  DOWNLOAD: "SAVE_IMAGE_DOWNLOAD",
} as const;

/** Payload for {@link ImageMessageType.DOWNLOAD}. */
export interface ImageDownloadPayload {
  /** Source URL of the file to download — a self-contained `data:` URL. */
  url: string;
  /** Suggested filename including extension (relative to the Downloads dir). */
  filename: string;
}

/** Result of a {@link ImageMessageType.DOWNLOAD} request. */
export interface ImageDownloadResult {
  /** The `chrome.downloads` id of the started download. */
  downloadId: number;
}

/**
 * Start an automatic download via `chrome.downloads.download`. Resolves with the
 * download id, or rejects with an `AppError` (`IMAGE_DECODE_FAILED`) when the
 * API is unavailable, the payload is missing a URL, or the download cannot be
 * started (Req 10.5).
 */
async function startDownload(
  payload: ImageDownloadPayload,
): Promise<ImageDownloadResult> {
  const downloads = (chrome as { downloads?: typeof chrome.downloads })
    .downloads;
  if (!downloads || typeof downloads.download !== "function") {
    throw makeError(
      ErrorCode.IMAGE_DECODE_FAILED,
      "chrome.downloads is not available in this context",
    );
  }

  const url = typeof payload?.url === "string" ? payload.url : "";
  const filename =
    typeof payload?.filename === "string" && payload.filename.trim() !== ""
      ? payload.filename
      : "image";
  if (url === "") {
    throw makeError(ErrorCode.IMAGE_DECODE_FAILED, "No image URL to download");
  }

  try {
    const downloadId = await downloads.download({ url, filename, saveAs: false });
    if (typeof downloadId !== "number") {
      throw new Error(
        chrome.runtime?.lastError?.message ?? "download did not start",
      );
    }
    return { downloadId };
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    throw makeError(
      ErrorCode.IMAGE_DECODE_FAILED,
      `Failed to start the image download: ${detail}`,
    );
  }
}

/**
 * Register the Save-Image download handler on the background router. Idempotent;
 * safe to call on every service-worker wake. Wired from
 * `src/background/index.ts` (not edited by this task).
 */
export function installImage(): void {
  registerHandler<ImageDownloadPayload, ImageDownloadResult>(
    ImageMessageType.DOWNLOAD,
    (payload) => startDownload(payload),
  );
}
