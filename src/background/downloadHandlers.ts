// Background download handler — generic auto-download bridge (task 14.3, Req 10.2/10.3).
//
// Content scripts cannot call `chrome.downloads` directly, so any tool that
// generates a file client-side (Save Image with Enhancement, and potentially
// others) hands the generated artifact to the service worker through a single
// `DOWNLOAD { url, filename }` message. The worker then starts an automatic
// download via `chrome.downloads.download({ saveAs: false })`.
//
// The `url` is expected to be a self-contained `data:` URL. Blob object URLs
// created with `URL.createObjectURL` inside a content-script document are scoped
// to that page's context and are NOT resolvable from the background service
// worker, so callers serialize their blob to a `data:` URL before sending it
// here (mirroring the screenshot download path).
//
// This handler is intentionally generic and standalone so it is not coupled to
// any one tool. It registers on the shared background router and is idempotent
// on service-worker wake (`registerHandler` overwrites prior registrations).
//
// Design references: "Tool 5 — Save Image with Enhancement (Req 10)",
// "Responsibility Split" (SW owns `chrome.downloads`), "Error Handling".

import { registerHandler } from "./router";
import { ErrorCode, makeError } from "@/shared/messaging";

/** Message type strings for the generic download bridge. */
export const DownloadMessageType = {
  /**
   * Start an automatic download of a generated file: payload
   * {@link DownloadPayload}. Returns {@link DownloadResult}.
   */
  DOWNLOAD: "DOWNLOAD",
} as const;

/** Payload for {@link DownloadMessageType.DOWNLOAD}. */
export interface DownloadPayload {
  /** Source URL of the file to download — a self-contained `data:` URL. */
  url: string;
  /** Suggested filename (may include a subfolder relative to Downloads). */
  filename: string;
}

/** Result of a {@link DownloadMessageType.DOWNLOAD} request. */
export interface DownloadResult {
  /** The `chrome.downloads` id of the started download. */
  downloadId: number;
}

/**
 * Start an automatic download via `chrome.downloads.download`. Resolves with the
 * download id, or rejects with an `AppError` when the API is unavailable, the
 * payload is missing a URL, or the download cannot be started.
 */
async function startDownload(payload: DownloadPayload): Promise<DownloadResult> {
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
      : "download";
  if (url === "") {
    throw makeError(ErrorCode.IMAGE_DECODE_FAILED, "No file URL to download");
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
      `Failed to start the download: ${detail}`,
    );
  }
}

/**
 * Register the generic download handler on the background router. Idempotent;
 * safe to call on every service-worker wake. Wired from
 * `src/background/index.ts` (not edited by this task).
 */
export function installDownloads(): void {
  registerHandler<DownloadPayload, DownloadResult>(
    DownloadMessageType.DOWNLOAD,
    (payload) => startDownload(payload),
  );
}
