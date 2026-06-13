// Background handler for Tool 8 — Media Downloader (Req 13 — honestly scoped,
// best-effort), task 17.3.
//
// Content scripts cannot call `chrome.downloads` directly, so the media tool
// resolves a *directly accessible* media URL on the page (see
// `src/tools/media/classify.ts`) and hands it to the service worker through a
// single `MEDIA_DOWNLOAD_REQUEST { url, filename }` message. The worker then
// starts an automatic download via `chrome.downloads.download({ saveAs: false })`
// (Req 13.2).
//
// Honest scope (design "Tool 8 — Media Downloader"): only media the extension
// can fetch directly is downloadable client-side under MV3 (no remote code, no
// server, no muxing/transcoding/DRM). Infeasible cases never reach this handler
// — the content tool disables them with an explanatory notification (Req 22.4).
//
// Failure model (Req 13.7): rather than throwing, this handler RESOLVES with
// `{ downloaded: false }` when the download cannot be started, so the content
// caller can surface a per-item `MEDIA_FAILED` notification naming the item.
// It registers on the shared background router and is idempotent on
// service-worker wake (`registerHandler` overwrites prior registrations).

import { registerHandler } from "./router";

/** Message type strings for the media download bridge. */
export const MediaMessageType = {
  /**
   * Start an automatic download of a directly-accessible media URL: payload
   * {@link MediaDownloadPayload}. Always resolves with {@link MediaDownloadResult}.
   */
  DOWNLOAD_REQUEST: "MEDIA_DOWNLOAD_REQUEST",
} as const;

/** Payload for {@link MediaMessageType.DOWNLOAD_REQUEST}. */
export interface MediaDownloadPayload {
  /** A directly-fetchable media URL (validated client-side before sending). */
  url: string;
  /** Suggested filename (may include a subfolder relative to Downloads). */
  filename: string;
}

/** Result of a {@link MediaMessageType.DOWNLOAD_REQUEST}. */
export interface MediaDownloadResult {
  /** `true` when the download started; `false` when it could not be started. */
  downloaded: boolean;
}

/**
 * Start an automatic media download via `chrome.downloads.download`. Resolves
 * with `{ downloaded: true }` on success and `{ downloaded: false }` for every
 * failure path (missing API, empty URL, rejected download) so the caller can
 * report a per-item failure (Req 13.7) rather than receiving a thrown error.
 */
async function startMediaDownload(
  payload: MediaDownloadPayload,
): Promise<MediaDownloadResult> {
  const downloads = (chrome as { downloads?: typeof chrome.downloads })
    .downloads;
  if (!downloads || typeof downloads.download !== "function") {
    return { downloaded: false };
  }

  const url = typeof payload?.url === "string" ? payload.url : "";
  if (url === "") {
    return { downloaded: false };
  }
  const filename =
    typeof payload?.filename === "string" && payload.filename.trim() !== ""
      ? payload.filename
      : "media-download";

  try {
    const downloadId = await downloads.download({ url, filename, saveAs: false });
    if (typeof downloadId !== "number") {
      // `lastError` set or the download was not started.
      return { downloaded: false };
    }
    return { downloaded: true };
  } catch {
    return { downloaded: false };
  }
}

/**
 * Register the media download handler on the background router. Idempotent;
 * safe to call on every service-worker wake. Wired from
 * `src/background/index.ts` (not edited by this task).
 */
export function installMedia(): void {
  registerHandler<MediaDownloadPayload, MediaDownloadResult>(
    MediaMessageType.DOWNLOAD_REQUEST,
    (payload) => startMediaDownload(payload),
  );
}
