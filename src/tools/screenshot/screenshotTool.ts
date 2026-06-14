/**
 * Alpha Cursor — Tool 4 "Full page screenshot" wiring (tasks 13.3 / 13.4, Req 9).
 *
 * Registers the {@link ToolId.FULL_PAGE_SCREENSHOT} handler in the content-script
 * tool catalog. The tool is only ever shown for the `generic-page` context (see
 * `src/content/tools.ts`).
 *
 * This module is the *content-side* half of the capture pipeline; the privileged
 * half (captureVisibleTab, chrome.downloads, the OperationCheckpoint store) lives
 * in `src/background/screenshotHandlers.ts` and is reached via `chrome.runtime`
 * messages. The pure segmentation math lives in `./segments`.
 *
 * ## Capture orchestration (task 13.3, Req 9.2, 9.7, 22.3)
 *
 * On invoke the content script:
 *   1. Measures the document scroll height, the viewport size, and the device
 *      pixel ratio, and computes the scroll/stitch plan via
 *      {@link computeSegments} (Req 9.2). The composed canvas is sized in DEVICE
 *      pixels so the output meets the Full HD / 2K thresholds where the page
 *      width permits (Req 9.3).
 *   2. Shows a Notion-styled progress indicator in a closed Shadow DOM (Req 9.7).
 *   3. For each segment: scrolls to `segment.scrollY`, waits for the browser to
 *      paint AND for the captureVisibleTab rate-limit window (~2/sec, Req 9.2),
 *      asks the background for a `SCREENSHOT_CAPTURE_VISIBLE` PNG data URL,
 *      decodes it, and draws the segment's device-pixel rectangle into the
 *      stitching canvas. Progress is reported to the UI and checkpointed to
 *      `chrome.storage.local` (via `SCREENSHOT_CHECKPOINT`) so a service-worker
 *      restart leaves a resumable marker (Req 22.3).
 *   4. Restores the page's original scroll position and hides the progress UI.
 *
 * ## Output handling (task 13.4, Req 9.4, 9.5, 9.6)
 *
 * After stitching, the user is prompted (a Notion dialog in the Shadow DOM) to
 * choose between a PDF (jsPDF) and a high-quality PNG image (Req 9.4). The chosen
 * artifact is serialized to a `data:` URL and handed to the background via
 * `SCREENSHOT_DOWNLOAD`, which starts an automatic download through
 * `chrome.downloads` (Req 9.5). Any failure along the way surfaces a
 * `CAPTURE_FAILED` notification and starts NO download (Req 9.6).
 *
 * ## Canvas tainting
 *
 * `captureVisibleTab` returns the extension's OWN capture of the viewport, which
 * is same-origin to the extension. Drawing it into the stitching canvas does NOT
 * taint the canvas, so `canvas.toBlob` / `toDataURL` succeed even on pages with
 * cross-origin content.
 */

import jsPDF from "jspdf";
import {
  computeSegments,
  composedHeightPx,
  composedWidthPx,
  effectiveDpr,
  type ScreenshotSegment,
} from "./segments";
import { notify } from "../../ui/notify";
import { createShadowHost } from "../../ui/shadowHost";
import { joinClasses } from "../../ui/primitives/classNames";
import { createCard, createButton } from "../../ui/primitives";
import { createMessage, ErrorCode } from "../../shared/messaging";
import { registerTool, ToolId, type ToolRun } from "../../content/tools";
import {
  ScreenshotMessageType,
  type CaptureVisibleResult,
  type ScreenshotCheckpointPayload,
  type ScreenshotCheckpointResult,
  type ScreenshotDownloadPayload,
  type ScreenshotDownloadResult,
  type ScreenshotProgressPayload,
  type ScreenshotProgressResult,
} from "../../background/screenshotHandlers";

/**
 * The output format the user can pick after a capture completes (Req 9.4). PNG
 * is the "high-quality image" branch; PDF is rendered with jsPDF.
 */
export type ScreenshotOutputFormat = "png" | "pdf";

/**
 * captureVisibleTab is rate-limited by Chrome to roughly two calls per second
 * (`MAX_CAPTURE_VISIBLE_TABS_PER_SECOND`). We sleep at least this long between
 * segment captures so a multi-segment screenshot does not trip the limit
 * (the background also retries with backoff as a safety net).
 */
const CAPTURE_INTERVAL_MS = 500;

/** Extra settle delay after scrolling, so the browser repaints before capture. */
const PAINT_DELAY_MS = 120;

/** Notification text shown when a capture cannot complete (Req 9.6). */
const CAPTURE_FAILED_TEXT = "Screenshot capture failed";

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tracks `position: fixed` / `position: sticky` elements so they can be hidden
 * during a multi-segment capture. Such elements stay pinned in the viewport on
 * every scroll step, so without intervention a fixed header/footer/nav gets
 * captured into EVERY segment and stitched in repeatedly (the "header shows
 * multiple times" bug). We let them render on the first (top) segment so the
 * page still looks natural at the top, then hide them for all later segments so
 * they appear exactly once in the stitched output.
 */
interface PinnedElements {
  /** Hide every tracked fixed/sticky element (no layout shift — uses visibility). */
  hide(): void;
  /** Restore every tracked element to its original inline visibility. */
  restore(): void;
}

/**
 * Scan the document for elements whose COMPUTED position is `fixed` or
 * `sticky` and return a handle to hide/restore them. Uses `visibility: hidden`
 * (not `display: none`) so the page layout — and therefore the scroll geometry
 * the segment plan was computed against — never shifts mid-capture.
 */
function collectPinnedElements(): PinnedElements {
  const tracked: { el: HTMLElement; prevVisibility: string }[] = [];

  const all = document.body
    ? document.body.querySelectorAll<HTMLElement>("*")
    : ([] as unknown as NodeListOf<HTMLElement>);
  all.forEach((el) => {
    let position = "";
    try {
      position = window.getComputedStyle(el).position;
    } catch {
      return;
    }
    if (position === "fixed" || position === "sticky") {
      tracked.push({ el, prevVisibility: el.style.visibility });
    }
  });

  return {
    hide(): void {
      for (const { el } of tracked) {
        el.style.setProperty("visibility", "hidden", "important");
      }
    },
    restore(): void {
      for (const { el, prevVisibility } of tracked) {
        if (prevVisibility) {
          el.style.visibility = prevVisibility;
        } else {
          el.style.removeProperty("visibility");
        }
      }
    },
  };
}

/**
 * Resolve the `chrome.runtime` messaging endpoint, or `null` when it is not
 * available (e.g. unit tests outside an extension context).
 */
function runtime(): typeof chrome.runtime | null {
  const rt = (chrome as { runtime?: typeof chrome.runtime }).runtime;
  return rt && typeof rt.sendMessage === "function" ? rt : null;
}

/**
 * Send a typed request to the background router and unwrap its `Response`,
 * returning the success `data`. Throws an `Error` when messaging is unavailable,
 * the channel rejects, or the handler returned an error response — callers map
 * this into the single `CAPTURE_FAILED` notification (Req 9.6).
 */
async function request<T, R>(type: string, payload: T): Promise<R> {
  const rt = runtime();
  if (!rt) {
    throw new Error("extension messaging is unavailable");
  }
  const response = (await rt.sendMessage(createMessage<T>(type, payload))) as
    | { ok: true; data: R }
    | { ok: false; error: { message: string } }
    | undefined;
  if (!response) {
    throw new Error("no response from background");
  }
  if (response.ok === false) {
    throw new Error(response.error?.message ?? "background reported an error");
  }
  return response.data;
}

/**
 * Measured page geometry used to drive the capture. All values are CSS pixels
 * except {@link devicePixelRatio}.
 */
interface PageMetrics {
  /** Full scrollable page height (CSS px). */
  totalHeight: number;
  /** Visible viewport height (CSS px). */
  viewportHeight: number;
  /** Page CSS width used to size the composed canvas width (Req 9.3). */
  pageWidth: number;
  /** Page device pixel ratio (capture is produced at this scale). */
  devicePixelRatio: number;
}

/** Measure the current document/viewport geometry for the capture plan. */
function measurePage(): PageMetrics {
  const doc = document.documentElement;
  const body = document.body;
  const totalHeight = Math.max(
    doc?.scrollHeight ?? 0,
    body?.scrollHeight ?? 0,
    doc?.clientHeight ?? 0,
  );
  const viewportHeight = window.innerHeight || doc?.clientHeight || 0;
  const pageWidth = Math.max(
    doc?.clientWidth ?? 0,
    window.innerWidth || 0,
  );
  const devicePixelRatio = effectiveDpr(window.devicePixelRatio);
  return { totalHeight, viewportHeight, pageWidth, devicePixelRatio };
}

/** Load a PNG data URL into an `HTMLImageElement` (decoded, ready to draw). */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to decode captured segment"));
    img.src = dataUrl;
  });
}

/**
 * A minimal handle to the progress indicator overlay so the orchestrator can
 * update the percentage and tear it down.
 */
interface ProgressHandle {
  /** Update the visible progress fraction in `[0, 1]`. */
  update(fraction: number): void;
  /** Remove the progress indicator. */
  destroy(): void;
}

/**
 * Drive a capture-progress indicator on the extension's TOOLBAR ICON BADGE,
 * via the background service worker (Req 9.7). The badge lives entirely outside
 * the web page, so — unlike an in-page overlay — it can NEVER be captured into
 * the screenshot and never covers page content. The previous full-viewport
 * card had to be hidden frame-by-frame during each capture; the badge needs no
 * such juggling.
 *
 * All updates are best-effort and fire-and-forget: a messaging failure must not
 * abort the capture.
 */
function showProgress(): ProgressHandle {
  // Show an immediate 0% so the user gets instant feedback the capture started.
  void request<ScreenshotProgressPayload, ScreenshotProgressResult>(
    ScreenshotMessageType.PROGRESS,
    { progress: 0 },
  ).catch(() => {
    /* cosmetic only */
  });

  return {
    update(fraction: number): void {
      void request<ScreenshotProgressPayload, ScreenshotProgressResult>(
        ScreenshotMessageType.PROGRESS,
        { progress: fraction },
      ).catch(() => {
        /* cosmetic only */
      });
    },
    destroy(): void {
      void request<ScreenshotProgressPayload, ScreenshotProgressResult>(
        ScreenshotMessageType.PROGRESS,
        { done: true },
      ).catch(() => {
        /* cosmetic only */
      });
    },
  };
}

/**
 * Prompt the user to choose the output format (Req 9.4). Renders a Notion dialog
 * in a closed Shadow DOM with "Download PDF" and "Download image" actions, plus
 * a cancel affordance. Resolves with the chosen {@link ScreenshotOutputFormat},
 * or `null` when the user dismisses the prompt (Escape / outside click / cancel).
 */
function promptOutputFormat(): Promise<ScreenshotOutputFormat | null> {
  return new Promise((resolve) => {
    const handle = createShadowHost({
      overlay: "full-viewport",
      surfaceId: "screenshot-prompt",
      theme: "dark",
    });

    let settled = false;
    const finish = (value: ScreenshotOutputFormat | null): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKeyDown, true);
      handle.destroy();
      resolve(value);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }
    };

    const title = document.createElement("div");
    title.className = "text-ink text-body-md font-sans font-medium";
    title.textContent = "Save full page screenshot";

    const subtitle = document.createElement("div");
    subtitle.className = "text-ink-faint text-body-sm font-sans";
    subtitle.textContent = "Choose how to download the captured page.";

    const pdfButton = createButton({
      variant: "primary",
      label: "Download PDF",
      onClick: () => finish("pdf"),
    });
    const imageButton = createButton({
      variant: "secondary",
      label: "Download image",
      onClick: () => finish("png"),
    });
    const cancelButton = createButton({
      variant: "utility",
      label: "Cancel",
      onClick: () => finish(null),
    });

    const actions = document.createElement("div");
    actions.className = "flex items-center justify-end gap-sm";
    actions.append(cancelButton, imageButton, pdfButton);

    const card = createCard({
      variant: "elevated",
      className: joinClasses(
        "pointer-events-auto flex flex-col gap-md min-w-[320px] max-w-[90vw]",
      ),
      children: [title, subtitle, actions],
    });
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "Save full page screenshot");

    const wrapper = document.createElement("div");
    wrapper.className = joinClasses(
      "fixed inset-0 flex items-center justify-center",
      "bg-scrim pointer-events-auto",
    );
    // Outside click (on the scrim) cancels.
    wrapper.addEventListener("click", (event) => {
      if (event.target === wrapper) finish(null);
    });
    wrapper.appendChild(card);

    handle.mount(wrapper);
    window.addEventListener("keydown", onKeyDown, true);
  });
}

/**
 * Convert a stitched `HTMLCanvasElement` to a PNG `data:` URL. Throws on failure
 * (e.g. an unexpectedly tainted canvas) so the caller surfaces `CAPTURE_FAILED`.
 */
function canvasToPngDataUrl(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL("image/png");
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
    throw new Error("failed to encode PNG output");
  }
  return dataUrl;
}

/**
 * Render the stitched canvas into a multi-page PDF (jsPDF) and return it as a
 * `data:application/pdf` URL. The composed image is sliced vertically into
 * page-height bands so a tall page spans multiple PDF pages at full width,
 * preserving aspect ratio (Req 9.5). Throws on failure.
 */
function canvasToPdfDataUrl(canvas: HTMLCanvasElement): string {
  const widthPx = canvas.width;
  const heightPx = canvas.height;
  if (widthPx <= 0 || heightPx <= 0) {
    throw new Error("cannot build a PDF from an empty canvas");
  }

  // Use a pixel-unit PDF so 1 canvas px maps to 1 PDF unit; the page is as wide
  // as the image and as tall as one viewport-equivalent band, with the image
  // tiled across however many pages are needed.
  const pageHeightPx = Math.min(heightPx, Math.max(1, Math.round(widthPx * 1.4142)));
  const orientation = widthPx >= pageHeightPx ? "landscape" : "portrait";
  const pdf = new jsPDF({
    orientation,
    unit: "px",
    format: [widthPx, pageHeightPx],
    compress: true,
  });

  let offset = 0;
  let first = true;
  while (offset < heightPx) {
    const bandHeight = Math.min(pageHeightPx, heightPx - offset);

    // Copy this band into a scratch canvas so we can hand jsPDF a per-page image.
    const band = document.createElement("canvas");
    band.width = widthPx;
    band.height = bandHeight;
    const bandCtx = band.getContext("2d");
    if (!bandCtx) {
      throw new Error("failed to allocate a PDF page canvas");
    }
    bandCtx.drawImage(
      canvas,
      0,
      offset,
      widthPx,
      bandHeight,
      0,
      0,
      widthPx,
      bandHeight,
    );

    if (!first) {
      pdf.addPage([widthPx, pageHeightPx], orientation);
    }
    pdf.addImage(
      band.toDataURL("image/png"),
      "PNG",
      0,
      0,
      widthPx,
      bandHeight,
    );
    first = false;
    offset += bandHeight;
  }

  return pdf.output("datauristring");
}

/**
 * Build a timestamped filename for the downloaded artifact, e.g.
 * `alpha-cursor-screenshot-2024-01-02T03-04-05.png`.
 */
function buildFilename(format: ScreenshotOutputFormat): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  return `alpha-cursor-screenshot-${stamp}.${format}`;
}

/** Generate a fresh operation id for the checkpoint lifecycle (Req 22.3). */
function newOpId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Best-effort checkpoint write/clear. A failure here must NOT abort the capture
 * (Req 22.3), so rejections are swallowed.
 */
async function checkpoint(payload: ScreenshotCheckpointPayload): Promise<void> {
  try {
    await request<ScreenshotCheckpointPayload, ScreenshotCheckpointResult>(
      ScreenshotMessageType.CHECKPOINT,
      payload,
    );
  } catch {
    /* checkpointing is best-effort; never fail the capture for it */
  }
}

/**
 * Drive the multi-segment capture: scroll → rate-limit wait → request a
 * viewport capture → draw into the stitching canvas. Returns the composed
 * canvas. Throws on any capture/stitch failure (Req 9.6). Always restores the
 * page's original scroll position before returning.
 */
async function captureAndStitch(
  metrics: PageMetrics,
  segments: ScreenshotSegment[],
  progress: ProgressHandle,
  opId: string,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(
    composedWidthPx(metrics.pageWidth, metrics.devicePixelRatio),
  );
  canvas.height = Math.round(
    composedHeightPx(metrics.totalHeight, metrics.devicePixelRatio),
  );
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("failed to allocate the stitching canvas");
  }

  const originalScrollX = window.scrollX;
  const originalScrollY = window.scrollY;
  const dpr = metrics.devicePixelRatio;
  const deviceWidth = canvas.width;

  // Fixed/sticky elements (headers, navs, footers, chat widgets) stay pinned in
  // the viewport at every scroll step. Capture them on the first segment only,
  // then hide them so they are not stitched into every subsequent segment
  // (fixes the repeated-header bug).
  const pinned = collectPinnedElements();

  try {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      window.scrollTo(0, segment.scrollY);

      // After the first (top) segment, hide pinned elements so they appear
      // exactly once in the stitched image.
      if (i === 1) {
        pinned.hide();
      }

      // Wait for the browser to paint the new scroll position, then honor the
      // captureVisibleTab rate limit before requesting the capture.
      await sleep(PAINT_DELAY_MS);
      if (i > 0) {
        await sleep(CAPTURE_INTERVAL_MS);
      }

      const { dataUrl } = await request<void, CaptureVisibleResult>(
        ScreenshotMessageType.CAPTURE_VISIBLE,
        undefined as unknown as void,
      );
      const image = await loadImage(dataUrl);

      // Draw this segment's device-pixel source band into the composed canvas.
      // The captured image spans the full device-pixel viewport width; clamp the
      // destination width to the composed canvas width.
      ctx.drawImage(
        image,
        0,
        segment.deviceSourceY,
        Math.min(image.width, deviceWidth),
        segment.deviceSourceHeight,
        0,
        segment.deviceDestY,
        Math.min(image.width, deviceWidth),
        segment.deviceSourceHeight,
      );

      const fraction = (i + 1) / segments.length;
      progress.update(fraction);
      await checkpoint({
        opId,
        progress: fraction,
        state: { captured: i + 1, total: segments.length, dpr },
      });
    }
  } finally {
    // Always restore pinned elements and the page scroll position so the
    // capture is transparent to the user (Req 9.2 auto-scroll).
    pinned.restore();
    window.scrollTo(originalScrollX, originalScrollY);
  }

  return canvas;
}

/**
 * The {@link ToolId.FULL_PAGE_SCREENSHOT} run handler. Orchestrates the capture
 * (task 13.3) and the output/download (task 13.4). Any failure surfaces a single
 * `CAPTURE_FAILED` notification and starts NO download (Req 9.6).
 */
const runScreenshotTool: ToolRun = async (): Promise<void> => {
  const metrics = measurePage();
  const segments = computeSegments(
    metrics.totalHeight,
    metrics.viewportHeight,
    metrics.devicePixelRatio,
  );

  if (segments.length === 0) {
    notify({
      kind: "error",
      text: CAPTURE_FAILED_TEXT,
      code: ErrorCode.CAPTURE_FAILED,
    });
    return;
  }

  const opId = newOpId();
  const progress = showProgress();
  let canvas: HTMLCanvasElement;

  try {
    await checkpoint({ opId, progress: 0, state: { total: segments.length } });
    canvas = await captureAndStitch(metrics, segments, progress, opId);
  } catch {
    // Clear the checkpoint and report a single failure with no download.
    await checkpoint({ opId, done: true });
    progress.destroy();
    notify({
      kind: "error",
      text: CAPTURE_FAILED_TEXT,
      code: ErrorCode.CAPTURE_FAILED,
    });
    return;
  }

  // Capture done — hide progress before prompting for the output format.
  progress.destroy();

  const format = await promptOutputFormat();
  if (format === null) {
    // User dismissed the prompt: clear the checkpoint, start no download.
    await checkpoint({ opId, done: true });
    return;
  }

  try {
    const url =
      format === "pdf"
        ? canvasToPdfDataUrl(canvas)
        : canvasToPngDataUrl(canvas);
    await request<ScreenshotDownloadPayload, ScreenshotDownloadResult>(
      ScreenshotMessageType.DOWNLOAD,
      { url, filename: buildFilename(format) },
    );
    await checkpoint({ opId, done: true });
    notify({
      kind: "success",
      text: `Full page screenshot saved as ${format.toUpperCase()}`,
    });
  } catch {
    await checkpoint({ opId, done: true });
    notify({
      kind: "error",
      text: CAPTURE_FAILED_TEXT,
      code: ErrorCode.CAPTURE_FAILED,
    });
  }
};

/**
 * Install the real Full Page Screenshot behavior into the Options_Panel catalog,
 * replacing the placeholder stub (Req 9.1–9.7). Called from the content-script
 * orchestrator at init time alongside the other tool registrations.
 *
 * @returns `true` if the tool was registered (it always exists in the catalog).
 */
export function registerScreenshotTool(): boolean {
  return registerTool(ToolId.FULL_PAGE_SCREENSHOT, runScreenshotTool);
}
