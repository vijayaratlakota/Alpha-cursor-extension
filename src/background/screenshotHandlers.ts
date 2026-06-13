// Background handlers for Tool 4 — Full Page Screenshot (Req 9), tasks 13.3 / 13.4.
//
// Two privileged operations live in the service worker because content scripts
// cannot call them directly:
//
//   - SCREENSHOT_CAPTURE_VISIBLE  -> capture the sender tab's visible viewport
//       via `chrome.tabs.captureVisibleTab({ format: "png" })`, returning a PNG
//       data URL. The content-script orchestrator (screenshotTool.ts) drives the
//       page's auto-scroll and asks for one capture per segment, then stitches
//       the returned images on a canvas (Req 9.2).
//
//   - SCREENSHOT_DOWNLOAD { url, filename } -> start an automatic download via
//       `chrome.downloads.download` (Req 9.5). The content script generates the
//       chosen PNG / PDF as a data URL and hands it here.
//
//   - SCREENSHOT_CHECKPOINT { opId, progress, state, done } -> write or clear an
//       `OperationCheckpoint` record in `chrome.storage.local` so a long capture
//       leaves a resumable progress marker that survives a service-worker
//       restart (Req 22.3). The marker is profile-scoped and is CLEARED when the
//       capture completes or fails. NOTE: mid-capture *resume* is intentionally
//       limited — `captureVisibleTab` requires the page to be re-driven through
//       its scroll positions, which the content script owns. The checkpoint
//       therefore RECORDS progress (so a stalled/aborted op can be detected and
//       reported) rather than transparently resuming a half-finished stitch.
//
// Required permissions (added during manifest finalization, task 26.3; assumed
// granted here): `"tabs"` + host permission (`"<all_urls>"`) or `"activeTab"`
// for `captureVisibleTab`, and `"downloads"` for `chrome.downloads.download`.
//
// captureVisibleTab is RATE-LIMITED by Chrome (roughly a couple of calls per
// second; it rejects with "MAX_CAPTURE_VISIBLE_TABS_PER_SECOND" when called too
// quickly). To keep multi-segment captures robust we retry a rejected capture a
// few times with a short backoff rather than failing the whole screenshot
// (Req 9.6 only fires when capture truly cannot complete).
//
// All handlers register on the shared background router and are idempotent on
// service-worker wake (`registerHandler` overwrites prior registrations).
//
// Design references: "Tool 4 — Full Page Screenshot (Req 9)", "Responsibility
// Split" (SW owns captureVisibleTab + chrome.downloads), "Service-Worker
// Checkpoints" / "MV3 Lifecycle Handling", "Error Handling".

import { registerHandler } from "./router";
import { ErrorCode, makeError } from "@/shared/messaging";
import { requireProfile } from "@/shared/identity";
import {
  getLocal,
  removeLocal,
  scopedKey,
  setLocal,
  StorageDomain,
} from "@/shared/storage";

/** Message type strings for the full-page screenshot handlers. */
export const ScreenshotMessageType = {
  /**
   * Capture the sender tab's visible viewport as a PNG data URL. No payload.
   * Returns {@link CaptureVisibleResult}.
   */
  CAPTURE_VISIBLE: "SCREENSHOT_CAPTURE_VISIBLE",
  /**
   * Start an automatic download of a generated file: payload
   * {@link ScreenshotDownloadPayload}. Returns {@link ScreenshotDownloadResult}.
   */
  DOWNLOAD: "SCREENSHOT_DOWNLOAD",
  /**
   * Write or clear an {@link OperationCheckpoint} for a full-page capture so it
   * survives a service-worker restart (Req 22.3). Payload
   * {@link ScreenshotCheckpointPayload}; returns {@link ScreenshotCheckpointResult}.
   */
  CHECKPOINT: "SCREENSHOT_CHECKPOINT",
} as const;

/** Result of a {@link ScreenshotMessageType.CAPTURE_VISIBLE} request. */
export interface CaptureVisibleResult {
  /** PNG data URL of the captured viewport (`data:image/png;base64,...`). */
  dataUrl: string;
}

/** Payload for {@link ScreenshotMessageType.DOWNLOAD}. */
export interface ScreenshotDownloadPayload {
  /** Source URL of the file to download (a `data:` URL for generated output). */
  url: string;
  /** Suggested filename (may include a subfolder relative to Downloads). */
  filename: string;
}

/** Result of a {@link ScreenshotMessageType.DOWNLOAD} request. */
export interface ScreenshotDownloadResult {
  /** The `chrome.downloads` id of the started download. */
  downloadId: number;
}

/**
 * A long-running operation's resumption checkpoint, persisted to
 * `chrome.storage.local` (Req 22.3). Mirrors the design's `OperationCheckpoint`
 * data model. For full-page screenshots `kind` is always `"screenshot"`.
 */
export interface OperationCheckpoint {
  /** Stable id for this capture operation (one per screenshot run). */
  opId: string;
  /** Operation family — `"screenshot"` for Tool 4. */
  kind: "screenshot" | "tab-restore" | "media-batch";
  /** Fractional progress in `[0, 1]`. */
  progress: number;
  /** Free-form operation state (e.g. captured segment count, total). */
  state: Record<string, unknown>;
}

/** Payload for {@link ScreenshotMessageType.CHECKPOINT}. */
export interface ScreenshotCheckpointPayload {
  /** Stable id for the capture operation. */
  opId: string;
  /** Fractional progress in `[0, 1]`. Ignored when {@link done} is `true`. */
  progress?: number;
  /** Free-form operation state. Ignored when {@link done} is `true`. */
  state?: Record<string, unknown>;
  /**
   * When `true`, the checkpoint is CLEARED (the operation completed or failed);
   * otherwise the checkpoint is written/updated.
   */
  done?: boolean;
}

/** Result of a {@link ScreenshotMessageType.CHECKPOINT} request. */
export interface ScreenshotCheckpointResult {
  /** `true` when the checkpoint was written; `false` when it was cleared. */
  written: boolean;
}

/** Max attempts for a single `captureVisibleTab` call before giving up. */
const CAPTURE_MAX_ATTEMPTS = 5;
/** Backoff between capture retries when the rate limit is hit (ms). */
const CAPTURE_RETRY_DELAY_MS = 600;

/** Promise-based sleep used for capture backoff. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capture the visible viewport of `windowId` (or the active window when
 * undefined) as a PNG data URL. Retries on the `captureVisibleTab` rate-limit
 * rejection with a short backoff so a multi-segment screenshot does not fail
 * just because segments were requested in quick succession.
 *
 * @throws an `AppError` (`CAPTURE_FAILED`) when every attempt fails.
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
    // Back off before retrying — the most common failure is the per-second
    // capture rate limit, which clears after a brief wait.
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
    `Failed to capture the visible tab: ${detail}`,
  );
}

/**
 * Start an automatic download via `chrome.downloads.download`. Resolves with the
 * download id, or rejects with an `AppError` (`CAPTURE_FAILED`) when the API is
 * unavailable or the download cannot be started (Req 9.6).
 */
async function startDownload(
  payload: ScreenshotDownloadPayload,
): Promise<ScreenshotDownloadResult> {
  const downloads = (chrome as { downloads?: typeof chrome.downloads })
    .downloads;
  if (!downloads || typeof downloads.download !== "function") {
    throw makeError(
      ErrorCode.CAPTURE_FAILED,
      "chrome.downloads is not available in this context",
    );
  }
  const url = typeof payload?.url === "string" ? payload.url : "";
  const filename =
    typeof payload?.filename === "string" && payload.filename.trim() !== ""
      ? payload.filename
      : "screenshot.png";
  if (url === "") {
    throw makeError(ErrorCode.CAPTURE_FAILED, "No file URL to download");
  }

  try {
    const downloadId = await downloads.download({
      url,
      filename,
      saveAs: false,
    });
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
      ErrorCode.CAPTURE_FAILED,
      `Failed to start the download: ${detail}`,
    );
  }
}

/**
 * Write or clear the full-page screenshot {@link OperationCheckpoint} in
 * `chrome.storage.local`, profile-scoped under the `checkpoint` domain
 * (Req 22.3). Best-effort: a storage failure here must NOT abort the capture,
 * so the caller treats rejection as non-fatal. The marker primarily lets a
 * stalled/aborted capture be detected on a later service-worker wake; it is
 * always cleared on completion or failure.
 */
async function writeCheckpoint(
  payload: ScreenshotCheckpointPayload,
): Promise<ScreenshotCheckpointResult> {
  const opId = typeof payload?.opId === "string" ? payload.opId : "";
  if (opId === "") {
    throw makeError(ErrorCode.CAPTURE_FAILED, "Checkpoint requires an opId");
  }
  const profileId = await requireProfile();
  const key = scopedKey(profileId, StorageDomain.CHECKPOINT, opId);

  if (payload.done === true) {
    await removeLocal(key);
    return { written: false };
  }

  const progress =
    typeof payload.progress === "number" && Number.isFinite(payload.progress)
      ? Math.min(1, Math.max(0, payload.progress))
      : 0;
  const checkpoint: OperationCheckpoint = {
    opId,
    kind: "screenshot",
    progress,
    state: payload.state ?? {},
  };
  await setLocal<OperationCheckpoint>(key, checkpoint);
  return { written: true };
}

/**
 * Read a previously-written full-page screenshot checkpoint (Req 22.3), or
 * `undefined` when none exists. Exported for resumption logic / tests; the SW
 * itself does not auto-resume a half-finished stitch (see the module header).
 */
export async function readScreenshotCheckpoint(
  opId: string,
): Promise<OperationCheckpoint | undefined> {
  const profileId = await requireProfile();
  const key = scopedKey(profileId, StorageDomain.CHECKPOINT, opId);
  return getLocal<OperationCheckpoint>(key);
}

/**
 * Register the screenshot capture + download + checkpoint handlers on the
 * background router. Idempotent; safe to call on every service-worker wake.
 * Wired from `src/background/index.ts` (not edited by this task).
 */
export function installScreenshot(): void {
  registerHandler<void, CaptureVisibleResult>(
    ScreenshotMessageType.CAPTURE_VISIBLE,
    async (_payload, sender) => {
      const windowId = sender?.tab?.windowId;
      const dataUrl = await captureVisible(windowId);
      return { dataUrl };
    },
  );

  registerHandler<ScreenshotDownloadPayload, ScreenshotDownloadResult>(
    ScreenshotMessageType.DOWNLOAD,
    (payload) => startDownload(payload),
  );

  registerHandler<ScreenshotCheckpointPayload, ScreenshotCheckpointResult>(
    ScreenshotMessageType.CHECKPOINT,
    (payload) => writeCheckpoint(payload),
  );
}
