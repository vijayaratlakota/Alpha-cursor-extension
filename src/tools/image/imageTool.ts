/**
 * Alpha Cursor — Tool 5 "Save image with enhancement" wiring (task 14.3, Req 10).
 *
 * Registers the {@link ToolId.SAVE_IMAGE} handler in the content-script tool
 * catalog. The tool is only ever shown for the `image` context (see
 * `src/content/tools.ts`), i.e. when the middle-click landed on an `<img>` or a
 * CSS `background-image` element.
 *
 * This module is the *content-side* half of the Save-Image pipeline; the
 * privileged half (`chrome.downloads`) lives in
 * `src/background/imageHandlers.ts` and is reached via a `SAVE_IMAGE_DOWNLOAD`
 * message. The pure format/encoder decisions live in `./format`.
 *
 * ## Flow (Req 10.1–10.6)
 *
 * On invoke the content script:
 *   1. Resolves the source image URL from the element under the invocation point
 *      via `document.elementFromPoint`: an `<img>`'s `currentSrc`/`src`, or the
 *      first `url(...)` of an element's CSS `background-image`. If none can be
 *      found it surfaces an `IMAGE_DECODE_FAILED` notification and stops, with NO
 *      menu and NO download (Req 10.5).
 *   2. Shows a Notion-styled options menu offering PNG, JPG, PDF plus the
 *      "Enhanced PNG" / "Enhanced JPG" variants (Req 10.1).
 *   3. On choosing an option it fetches the image, decodes it via
 *      `createImageBitmap` (which decodes WebP too, Req 10.4), draws it to a
 *      canvas, optionally enhances it (high-quality smoothing + a sharpen /
 *      contrast convolution pass and a 2× upscale — this is *filter-based*
 *      enhancement, NOT ML super-resolution, consistent with the no-server
 *      design), then converts to PNG/JPG via `canvas.toBlob` (using
 *      {@link chooseEncoder}) or renders into a `jsPDF` page for PDF.
 *   4. The artifact is serialized to a self-contained `data:` URL and handed to
 *      the background `SAVE_IMAGE_DOWNLOAD` handler, which starts the automatic
 *      download (Req 10.2, 10.3). Success → a notification naming the chosen
 *      format (Req 10.6); any retrieval/decode/encode/download failure →
 *      `IMAGE_DECODE_FAILED` notification and NO download (Req 10.5).
 *
 * ## Cross-origin honesty
 *
 * Fetching a cross-origin image from a content script can be blocked by CORS. We
 * try `fetch(url)` first (the most reliable path, and the only one that yields a
 * clean, non-tainted canvas for arbitrary origins served with permissive CORS).
 * If `fetch` fails we fall back to drawing the already-loaded `<img>` element
 * directly. That fallback can TAINT the canvas for cross-origin images loaded
 * without a `crossorigin` attribute, in which case `canvas.toBlob` /
 * `createImageBitmap` throws a `SecurityError`; we treat that as an
 * `IMAGE_DECODE_FAILED` and show the failure notification (best-effort, honest
 * about the platform limitation).
 */

import jsPDF from "jspdf";
import {
  chooseEncoder,
  formatToExtension,
  type ImageFormat,
} from "./format";
import { notify } from "../../ui/notify";
import { createShadowHost, type ShadowHostHandle } from "../../ui/shadowHost";
import { joinClasses } from "../../ui/primitives/classNames";
import { createMessage, ErrorCode } from "../../shared/messaging";
import {
  registerTool,
  ToolId,
  type ToolInvocation,
} from "../../content/tools";
import {
  ImageMessageType,
  type ImageDownloadPayload,
  type ImageDownloadResult,
} from "../../background/imageHandlers";

/** Notification text shown when the source can't be retrieved/decoded (Req 10.5). */
const DECODE_FAILED_TEXT = "Could not save the image";

/** Upscale factor applied to enhanced variants (filter-based, not ML). */
const ENHANCE_SCALE = 2;

/**
 * A single choice in the Save-Image menu: a base {@link ImageFormat} plus
 * whether the enhancement pass should run before conversion (Req 10.1).
 */
interface SaveOption {
  /** Display label rendered in the menu row. */
  label: string;
  /** Target output format. */
  format: ImageFormat;
  /** When `true`, apply the filter-based enhancement pass (Req 10.3). */
  enhanced: boolean;
}

/**
 * The five options the panel presents for an image context (Req 10.1): the
 * three base formats plus enhanced PNG / JPG variants.
 */
const SAVE_OPTIONS: SaveOption[] = [
  { label: "PNG", format: "png", enhanced: false },
  { label: "JPG", format: "jpg", enhanced: false },
  { label: "PDF", format: "pdf", enhanced: false },
  { label: "Enhanced PNG", format: "png", enhanced: true },
  { label: "Enhanced JPG", format: "jpg", enhanced: true },
];

/** Module-level handle to the currently open options menu, if any. */
let activeMenu: ShadowHostHandle | null = null;

/**
 * Extract the first `url(...)` target from a CSS `background-image` value, or
 * `null` when the value has none (e.g. `none`, a gradient). Strips optional
 * quotes around the URL.
 */
function backgroundImageUrl(backgroundImage: string): string | null {
  if (typeof backgroundImage !== "string" || backgroundImage === "") {
    return null;
  }
  const match = backgroundImage.match(/url\(\s*(['"]?)([^'")]+)\1\s*\)/i);
  const url = match?.[2]?.trim();
  return url && url !== "" ? url : null;
}

/**
 * Resolve the source image URL for the element under `point`, walking up a few
 * ancestors so a click that lands on a child of a background-image "hero"
 * element still resolves. Returns the absolute URL string, or `null` when no
 * image source can be found.
 */
function resolveImageUrl(point: { x: number; y: number }): string | null {
  const start = document.elementFromPoint(point.x, point.y);
  let node: Element | null = start;
  let depth = 0;

  while (node && depth < 5) {
    if (node instanceof HTMLImageElement) {
      const src = node.currentSrc || node.src;
      if (src) return src;
    }
    const getComputed = (
      globalThis as { getComputedStyle?: (e: Element) => CSSStyleDeclaration }
    ).getComputedStyle;
    if (typeof getComputed === "function") {
      try {
        const bg = getComputed.call(globalThis, node).backgroundImage;
        const url = backgroundImageUrl(bg);
        if (url) {
          // Resolve relative URLs against the document base.
          try {
            return new URL(url, document.baseURI).href;
          } catch {
            return url;
          }
        }
      } catch {
        /* getComputedStyle can throw on detached nodes; keep walking */
      }
    }
    node = node.parentElement;
    depth += 1;
  }
  return null;
}

/** Close the Save-Image options menu if open. Idempotent. */
function closeMenu(): void {
  if (activeMenu) {
    activeMenu.destroy();
    activeMenu = null;
  }
}

/**
 * Resolve the `chrome.runtime` messaging endpoint, or `null` when unavailable
 * (e.g. unit tests outside an extension context).
 */
function runtime(): typeof chrome.runtime | null {
  const rt = (chrome as { runtime?: typeof chrome.runtime }).runtime;
  return rt && typeof rt.sendMessage === "function" ? rt : null;
}

/**
 * Decode the source image into an `ImageBitmap`. Prefers `fetch(url)` → `blob`
 * → `createImageBitmap` (decodes WebP too, Req 10.4) which yields a clean,
 * non-tainted bitmap for any origin that allows the fetch. Falls back to drawing
 * the already-loaded `<img>` under the cursor when the fetch is blocked (CORS) —
 * that path may taint the canvas for cross-origin images, surfacing later as a
 * `SecurityError` on encode (handled by the caller as a decode failure).
 *
 * @throws when neither path can produce a decodable bitmap.
 */
async function decodeSource(
  url: string,
  point: { x: number; y: number },
): Promise<ImageBitmap> {
  // Primary path: fetch → blob → createImageBitmap.
  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit" });
    if (response.ok) {
      const blob = await response.blob();
      return await createImageBitmap(blob);
    }
  } catch {
    /* fall through to the element fallback below */
  }

  // Fallback: decode the already-loaded <img> element directly. createImageBitmap
  // accepts an HTMLImageElement; this can throw a SecurityError if the element is
  // cross-origin and tainted, which the caller maps to IMAGE_DECODE_FAILED.
  const el = document.elementFromPoint(point.x, point.y);
  if (el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0) {
    return await createImageBitmap(el);
  }

  throw new Error("source image could not be retrieved or decoded");
}

/**
 * Draw `bitmap` into a 2D canvas at the given scale. When `enhanced` is true the
 * draw uses high-quality smoothing and a 2× upscale, then applies a
 * sharpen/contrast convolution pass on an OffscreenCanvas (filter-based, not
 * ML). Returns the populated canvas.
 *
 * @throws when a 2D context cannot be created.
 */
function renderToCanvas(bitmap: ImageBitmap, enhanced: boolean): HTMLCanvasElement {
  const scale = enhanced ? ENHANCE_SCALE : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("failed to allocate an image canvas");
  }

  if (enhanced) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
  }
  ctx.drawImage(bitmap, 0, 0, width, height);

  if (enhanced) {
    applyEnhancement(ctx, width, height);
  }
  return canvas;
}

/**
 * Apply a filter-based enhancement pass in-place: a 3×3 sharpen convolution
 * followed by a mild contrast stretch. This is deliberately lightweight and
 * runs entirely client-side (no model, no server) — honest "enhancement", not
 * super-resolution. Best-effort: if `getImageData` is unavailable (tainted
 * canvas) it throws, which the caller treats as a decode/processing failure.
 */
function applyEnhancement(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  const source = ctx.getImageData(0, 0, width, height);
  const src = source.data;
  const out = new Uint8ClampedArray(src.length);

  // 3×3 sharpen kernel (centre 5, edge -1). Applied per RGB channel; alpha is
  // copied through unchanged.
  const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];
  const idx = (x: number, y: number): number => (y * width + x) * 4;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = idx(x, y);
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let k = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const sx = Math.min(width - 1, Math.max(0, x + kx));
            const sy = Math.min(height - 1, Math.max(0, y + ky));
            sum += src[idx(sx, sy) + c]! * kernel[k]!;
            k += 1;
          }
        }
        // Mild contrast stretch around mid-grey (factor 1.08).
        const contrasted = (sum - 128) * 1.08 + 128;
        out[o + c] = contrasted;
      }
      out[o + 3] = src[o + 3]!; // preserve alpha
    }
  }

  ctx.putImageData(new ImageData(out, width, height), 0, 0);
}

/**
 * Promisified `canvas.toBlob`. Resolves with the encoded blob, or rejects when
 * encoding fails (e.g. a tainted canvas → `null` blob).
 */
function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("failed to encode image"));
      },
      mime,
      quality,
    );
  });
}

/** Read a `Blob` as a `data:` URL (resolvable from the background worker). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("failed to read encoded image"));
    };
    reader.onerror = () => reject(new Error("failed to read encoded image"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Render the canvas into a single-page PDF sized to the image and return it as a
 * `data:application/pdf` URL. Orientation follows the image aspect ratio so the
 * full image fits one page at native pixel size (Req 10.2/10.3). Throws on
 * failure (e.g. a tainted canvas → `toDataURL` SecurityError).
 */
function canvasToPdfDataUrl(canvas: HTMLCanvasElement): string {
  const widthPx = canvas.width;
  const heightPx = canvas.height;
  if (widthPx <= 0 || heightPx <= 0) {
    throw new Error("cannot build a PDF from an empty image");
  }
  const orientation = widthPx >= heightPx ? "landscape" : "portrait";
  const pdf = new jsPDF({
    orientation,
    unit: "px",
    format: [widthPx, heightPx],
    compress: true,
  });
  pdf.addImage(
    canvas.toDataURL("image/png"),
    "PNG",
    0,
    0,
    widthPx,
    heightPx,
  );
  return pdf.output("datauristring");
}

/**
 * Convert the rendered canvas to a `data:` URL for the chosen format. PNG/JPG go
 * through `canvas.toBlob` (per the {@link chooseEncoder} descriptor) → data URL;
 * PDF is rendered via jsPDF. Throws on any encode failure.
 */
async function canvasToDataUrl(
  canvas: HTMLCanvasElement,
  format: ImageFormat,
): Promise<string> {
  const descriptor = chooseEncoder(format);
  if (descriptor.via === "jspdf") {
    return canvasToPdfDataUrl(canvas);
  }
  const blob = await canvasToBlob(canvas, descriptor.mime, descriptor.quality);
  return blobToDataUrl(blob);
}

/**
 * Build a timestamped download filename for the chosen format, e.g.
 * `alpha-cursor-image-2024-01-02T03-04-05.png`.
 */
function buildFilename(format: ImageFormat): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  return `alpha-cursor-image-${stamp}.${formatToExtension(format)}`;
}

/**
 * Ask the background worker to download `url` as `filename`. Throws when
 * messaging is unavailable, the channel rejects, or the handler returns an error
 * response — the caller maps this into the single decode-failure notification
 * (Req 10.5).
 */
async function requestDownload(url: string, filename: string): Promise<void> {
  const rt = runtime();
  if (!rt) {
    throw new Error("extension messaging is unavailable");
  }
  const response = (await rt.sendMessage(
    createMessage<ImageDownloadPayload>(ImageMessageType.DOWNLOAD, {
      url,
      filename,
    }),
  )) as
    | { ok: true; data: ImageDownloadResult }
    | { ok: false; error: { message: string } }
    | undefined;
  if (!response) {
    throw new Error("no response from background");
  }
  if (response.ok === false) {
    throw new Error(response.error?.message ?? "download failed");
  }
}

/** Notify a retrieval/decode/encode/download failure WITHOUT any download (Req 10.5). */
function notifyFailure(): void {
  notify({
    kind: "error",
    text: DECODE_FAILED_TEXT,
    code: ErrorCode.IMAGE_DECODE_FAILED,
  });
}

/**
 * Perform the full save for one chosen option: decode → (enhance) → convert →
 * download → notify. Any failure surfaces a single decode-failure notification
 * and starts NO download (Req 10.5); success notifies with the chosen format
 * (Req 10.6).
 */
async function performSave(
  url: string,
  option: SaveOption,
  point: { x: number; y: number },
): Promise<void> {
  try {
    const bitmap = await decodeSource(url, point);
    let canvas: HTMLCanvasElement;
    try {
      canvas = renderToCanvas(bitmap, option.enhanced);
    } finally {
      // Release the decoded bitmap promptly.
      if (typeof bitmap.close === "function") bitmap.close();
    }
    const dataUrl = await canvasToDataUrl(canvas, option.format);
    await requestDownload(dataUrl, buildFilename(option.format));
    notify({
      kind: "success",
      text: `Image saved as ${option.label}`,
    });
  } catch {
    notifyFailure();
  }
}

/**
 * Build the options menu element: an elevated white Notion surface listing the
 * five save options as full-width rows. Choosing a row closes the menu and runs
 * the save for that option.
 */
function buildMenu(url: string, point: { x: number; y: number }): HTMLElement {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Save image");
  menu.className = joinClasses(
    "pointer-events-auto inline-flex min-w-[200px] flex-col gap-px",
    "bg-surface text-ink font-sans rounded-xl p-xs",
    "border border-hairline acx-elevated",
  );

  for (const option of SAVE_OPTIONS) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.className = joinClasses(
      "w-full text-left cursor-pointer border-0 bg-transparent",
      "text-ink text-body-sm rounded-md py-sm px-md",
      "hover:bg-fill-hover focus-visible:outline-2",
      "focus-visible:outline-offset-2 focus-visible:outline-primary",
    );
    item.textContent = option.label;
    item.addEventListener("click", () => {
      closeMenu();
      void performSave(url, option, point);
    });
    menu.appendChild(item);
  }

  return menu;
}

/**
 * Open the Save-Image options menu near the cursor. Closes any menu already
 * open, wires outside-click + Escape to dismiss, and mounts the option list into
 * a closed shadow host (Req 2.11, 20.1).
 */
function openMenu(url: string, point: { x: number; y: number }): void {
  closeMenu();

  const handle = createShadowHost({
    overlay: "anchored",
    point,
    surfaceId: "save-image-menu",
  });
  activeMenu = handle;
  handle.mount(buildMenu(url, point));

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    }
  };
  const onPointerDown = (event: MouseEvent): void => {
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];
    if (!path.includes(handle.host)) {
      closeMenu();
    }
  };

  window.addEventListener("keydown", onKeyDown, true);
  handle.onDestroy(() => window.removeEventListener("keydown", onKeyDown, true));

  // Defer outside-click wiring one tick so the click that opened the menu is
  // not treated as an outside dismissal.
  setTimeout(() => {
    window.addEventListener("mousedown", onPointerDown, true);
    handle.onDestroy(() =>
      window.removeEventListener("mousedown", onPointerDown, true),
    );
  }, 0);
}

/**
 * The {@link ToolId.SAVE_IMAGE} run handler. Resolves the source image URL under
 * the invocation point; if none is found it notifies `IMAGE_DECODE_FAILED` and
 * opens NO menu (Req 10.5). Otherwise it opens the format options menu (Req 10.1).
 */
function runImageTool(invocation: ToolInvocation): void {
  const url = resolveImageUrl(invocation.point);
  if (!url) {
    notifyFailure();
    return;
  }
  openMenu(url, invocation.point);
}

/**
 * Install the real Save-Image behavior into the Options_Panel catalog, replacing
 * the placeholder stub (Req 10.1–10.6). Called from the content-script
 * orchestrator at init time alongside the other tool registrations.
 *
 * @returns `true` if the tool was registered (it always exists in the catalog).
 */
export function registerImageTool(): boolean {
  return registerTool(ToolId.SAVE_IMAGE, runImageTool);
}
