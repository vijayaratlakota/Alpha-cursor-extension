/**
 * Alpha Cursor — Tool 8 "Media Downloader" wiring (task 17.3, Req 13 — honestly
 * scoped, best-effort).
 *
 * Registers the {@link ToolId.MEDIA_DOWNLOAD} handler in the content-script tool
 * catalog. The tool is only ever shown for the `video` context (see
 * `src/content/tools.ts`), so when invoked it:
 *
 *   1. Resolves the media element under the invocation point
 *      (`document.elementFromPoint`) and reads its `currentSrc`/`src`, DRM state
 *      (`video.mediaKeys != null`), and the page host — building a
 *      {@link MediaTarget} + {@link PageMeta}.
 *   2. Calls the PURE {@link classifyMediaTarget}. When the target is
 *      INFEASIBLE (YouTube/transcoding, DRM, login-gated social, signed URLs,
 *      adaptive manifests, bulk scrape, …), it surfaces an explanatory
 *      notification stating exactly WHY and attempts NO download — graceful
 *      degradation (Req 22.4) rather than a silent failure.
 *   3. When the target is FEASIBLE (a directly-downloadable file URL), it shows
 *      a one-time ToS notice BEFORE the FIRST ever download (Req 13.8),
 *      persisting a profile-scoped `mediaTosAccepted` flag once acknowledged so
 *      it never reappears. It then presents a small confirm menu (the source
 *      exposes a single format — a direct file — so no transcoding/quality
 *      choices are offered, which is infeasible client-side per the design's
 *      media delta) and, on confirm, asks the background to download via
 *      `chrome.downloads` (Req 13.2).
 *   4. Reports success with a notification, and per-item failure with a
 *      `MEDIA_FAILED` notification naming the item (Req 13.6, 13.7).
 *
 * The honest-feasibility decision and `isDirectlyDownloadable` live in
 * `classify.ts`; the ToS persistence uses the shared profile-scoped storage.
 */

import { createShadowHost, type ShadowHostHandle } from "../../ui/shadowHost";
import { joinClasses } from "../../ui/primitives/classNames";
import { notify } from "../../ui/notify";
import { createMessage, ErrorCode, isErr } from "../../shared/messaging";
import {
  getLocal,
  setLocal,
  scopedKey,
  StorageDomain,
} from "../../shared/storage";
import { getActiveProfileId } from "../../shared/identity";
import {
  registerTool,
  ToolId,
  type ToolInvocation,
} from "../../content/tools";
import {
  classifyMediaTarget,
  type MediaTarget,
  type PageMeta,
} from "./classify";
import {
  MediaMessageType,
  type MediaDownloadPayload,
  type MediaDownloadResult,
} from "../../background/mediaHandlers";

/**
 * Storage key segment under {@link StorageDomain.SETTINGS} that remembers the
 * one-time media ToS notice has been acknowledged for this profile (Req 13.8).
 */
export const MEDIA_TOS_ACCEPTED_KEY = "mediaTosAccepted";

/** Module-level handle to the currently open menu/dialog, if any. */
let activeOverlay: ShadowHostHandle | null = null;

/** Close any open media overlay (menu or ToS dialog). Idempotent. */
function closeOverlay(): void {
  if (activeOverlay) {
    activeOverlay.destroy();
    activeOverlay = null;
  }
}

/**
 * Find the `<video>`/`<audio>` (or other) media element under a viewport point.
 * Walks up from `elementFromPoint` so a click on an overlaid control still
 * resolves the nearest media ancestor.
 */
function resolveMediaElement(point: { x: number; y: number }): Element | null {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") {
    return null;
  }
  const hit = document.elementFromPoint(point.x, point.y);
  if (!hit) return null;

  let el: Element | null = hit;
  while (el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "video" || tag === "audio") {
      return el;
    }
    el = el.parentElement;
  }
  // Fall back to the hit element so the classifier can still read any src.
  return hit;
}

/**
 * True when a media element exposes Encrypted Media Extensions / DRM. Chrome
 * sets `HTMLMediaElement.mediaKeys` once a key system is attached, so a
 * non-null value means the stream is DRM-protected and cannot be downloaded
 * client-side (Req 13, design media delta).
 */
function detectDRM(el: Element): boolean {
  const media = el as Partial<HTMLMediaElement> & {
    mediaKeys?: unknown;
  };
  if (media.mediaKeys != null) {
    return true;
  }
  // A media element exposing `MediaKeys` machinery is treated as DRM-capable
  // only when keys are actually attached; absence of the API is not DRM.
  return false;
}

/** Build the {@link MediaTarget} descriptor from the resolved element. */
function buildTarget(el: Element | null): MediaTarget {
  const host = typeof location !== "undefined" ? location.host : undefined;
  const target: MediaTarget = { kind: "video", scope: "single" };
  if (host) {
    target.host = host;
  }
  if (!el) {
    return target;
  }
  const media = el as Partial<HTMLMediaElement> & {
    currentSrc?: string;
    src?: string;
  };
  target.tagName = el.tagName;
  if (typeof media.src === "string") {
    target.src = media.src;
  }
  if (typeof media.currentSrc === "string") {
    target.currentSrc = media.currentSrc;
  }
  target.isDRM = detectDRM(el);
  return target;
}

/**
 * Derive a reasonable download filename from a media URL. Falls back to a
 * generic name when the URL has no usable path segment (e.g. a `data:` URL).
 */
function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url, typeof location !== "undefined" ? location.href : undefined);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) {
      return decodeURIComponent(last);
    }
  } catch {
    /* fall through to default */
  }
  return "media-download";
}

/**
 * Read whether the one-time media ToS notice was already accepted for the
 * active profile (Req 13.8). Exported so the storage-backed gate can be unit
 * tested without driving the full DOM dialog (task 17.4). Resolves `false` when
 * no profile is established or the flag is unset/unreadable.
 */
export async function isMediaTosAccepted(): Promise<boolean> {
  const profileId = getActiveProfileId();
  if (!profileId) return false;
  try {
    const key = scopedKey(profileId, StorageDomain.SETTINGS, MEDIA_TOS_ACCEPTED_KEY);
    return (await getLocal<boolean>(key)) === true;
  } catch {
    return false;
  }
}

/**
 * Persist that the user acknowledged the one-time media ToS notice for the
 * active profile (Req 13.8). Exported so the gate flip can be unit tested
 * (task 17.4). Best-effort: a failed persist simply means the notice may show
 * again.
 */
export async function acceptMediaTos(): Promise<void> {
  const profileId = getActiveProfileId();
  if (!profileId) return;
  try {
    const key = scopedKey(profileId, StorageDomain.SETTINGS, MEDIA_TOS_ACCEPTED_KEY);
    await setLocal<boolean>(key, true);
  } catch {
    // Best-effort: a failed persist simply means the notice may show again.
  }
}

/**
 * Ask the background worker to download `url` as `filename` via
 * `chrome.downloads` (Req 13.2). Resolves to `true` only when the worker
 * reports the download started; any messaging/handler failure resolves `false`
 * so the caller reports a per-item failure (Req 13.7).
 */
async function requestDownload(url: string, filename: string): Promise<boolean> {
  const runtime = (chrome as { runtime?: typeof chrome.runtime }).runtime;
  if (!runtime || typeof runtime.sendMessage !== "function") {
    return false;
  }
  const message = createMessage<MediaDownloadPayload>(
    MediaMessageType.DOWNLOAD_REQUEST,
    { url, filename },
  );
  try {
    const response = await runtime.sendMessage(message);
    if (!response || typeof response !== "object") {
      return false;
    }
    if (isErr(response as never)) {
      return false;
    }
    const data = (response as { data?: MediaDownloadResult }).data;
    return data?.downloaded === true;
  } catch {
    return false;
  }
}

/**
 * Perform the actual download for a feasible target: request it from the
 * background and surface success / per-item failure notifications (Req 13.6,
 * 13.7).
 */
async function performDownload(url: string): Promise<void> {
  const filename = filenameFromUrl(url);
  const started = await requestDownload(url, filename);
  if (started) {
    notify({ kind: "success", text: `Downloading ${filename}` });
  } else {
    // Per-item failure naming the affected item (Req 13.7).
    notify({
      kind: "error",
      text: `Couldn't download ${filename}`,
      code: ErrorCode.MEDIA_FAILED,
    });
  }
}

/** Wire Escape + outside-click dismissal onto an overlay handle. */
function wireDismiss(handle: ShadowHostHandle): void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeOverlay();
    }
  };
  const onPointerDown = (event: MouseEvent): void => {
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];
    if (!path.includes(handle.host)) {
      closeOverlay();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  handle.onDestroy(() => window.removeEventListener("keydown", onKeyDown, true));
  setTimeout(() => {
    window.addEventListener("mousedown", onPointerDown, true);
    handle.onDestroy(() =>
      window.removeEventListener("mousedown", onPointerDown, true),
    );
  }, 0);
}

/**
 * Build the small confirm menu for a feasible, directly-downloadable file. The
 * source exposes a single format (the file as-is), so we intentionally do NOT
 * offer transcoding/quality choices — that needs a server and is infeasible
 * client-side (design media delta). Confirming triggers the download.
 */
function buildConfirmMenu(url: string): HTMLElement {
  const filename = filenameFromUrl(url);
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Download media");
  menu.className = joinClasses(
    "pointer-events-auto inline-flex min-w-[220px] max-w-[320px] flex-col gap-xs",
    "bg-surface text-ink font-sans rounded-xl p-md",
    "border border-hairline acx-elevated",
  );

  const heading = document.createElement("div");
  heading.className = "text-body-sm font-medium text-ink truncate";
  heading.textContent = `Download ${filename}`;
  heading.title = filename;
  menu.appendChild(heading);

  const note = document.createElement("div");
  note.className = "text-eyebrow text-ink-faint";
  note.textContent = "Saved as-is (the source provides a single format).";
  menu.appendChild(note);

  const download = document.createElement("button");
  download.type = "button";
  download.setAttribute("role", "menuitem");
  download.className = joinClasses(
    "w-full text-center cursor-pointer border-0 mt-xs",
    "bg-primary text-on-primary text-button rounded-full py-sm px-md",
    "hover:opacity-90 focus-visible:outline-2",
    "focus-visible:outline-offset-2 focus-visible:outline-primary",
  );
  download.textContent = "Download";
  download.addEventListener("click", () => {
    closeOverlay();
    void performDownload(url);
  });
  menu.appendChild(download);

  return menu;
}

/** Open the confirm menu near the cursor for a feasible target. */
function openConfirmMenu(url: string, point: { x: number; y: number }): void {
  closeOverlay();
  const handle = createShadowHost({
    overlay: "anchored",
    point,
    surfaceId: "media-menu",
  });
  activeOverlay = handle;
  handle.mount(buildConfirmMenu(url));
  wireDismiss(handle);
}

/**
 * Build the one-time ToS notice dialog (Req 13.8). Acknowledging it persists
 * the `mediaTosAccepted` flag and proceeds to the download confirm menu;
 * cancelling closes without downloading.
 */
function buildTosDialog(onAcknowledge: () => void): HTMLElement {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Media download notice");
  dialog.className = joinClasses(
    "pointer-events-auto inline-flex w-[320px] max-w-[90vw] flex-col gap-sm",
    "bg-surface text-ink font-sans rounded-xl p-lg",
    "border border-hairline acx-elevated",
  );

  const title = document.createElement("div");
  title.className = "text-body font-medium text-ink";
  title.textContent = "Before you download";
  dialog.appendChild(title);

  const body = document.createElement("p");
  body.className = "text-body-sm text-ink-muted m-0";
  body.textContent =
    "Downloading media from third-party platforms may be subject to those " +
    "platforms' Terms of Service. Only download media you have the right to " +
    "save. Alpha Cursor downloads directly-accessible files on your device " +
    "and never circumvents DRM or platform protections.";
  dialog.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "flex items-center justify-end gap-sm mt-xs";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = joinClasses(
    "cursor-pointer bg-surface text-ink text-button rounded-full",
    "border border-hairline px-md py-xs",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
  );
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => closeOverlay());
  actions.appendChild(cancel);

  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = joinClasses(
    "cursor-pointer bg-primary text-on-primary text-button rounded-full px-lg py-xs",
    "hover:opacity-90 focus-visible:outline-2",
    "focus-visible:outline-offset-2 focus-visible:outline-primary",
  );
  accept.textContent = "I understand";
  accept.addEventListener("click", () => {
    onAcknowledge();
  });
  actions.appendChild(accept);

  dialog.appendChild(actions);
  return dialog;
}

/**
 * Show the one-time ToS notice centered in the viewport. On acknowledgment it
 * persists acceptance and invokes `onProceed`; cancel just closes.
 */
function openTosDialog(onProceed: () => void): void {
  closeOverlay();
  const handle = createShadowHost({
    overlay: "full-viewport",
    surfaceId: "media-tos",
  });
  activeOverlay = handle;

  // Center the dialog within the full-viewport host with a dim backdrop.
  const backdrop = document.createElement("div");
  backdrop.className = joinClasses(
    "pointer-events-auto fixed inset-0 flex items-center justify-center",
    "bg-scrim",
  );
  backdrop.appendChild(
    buildTosDialog(() => {
      void acceptMediaTos();
      closeOverlay();
      onProceed();
    }),
  );
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) {
      closeOverlay();
    }
  });
  handle.mount(backdrop);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeOverlay();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  handle.onDestroy(() => window.removeEventListener("keydown", onKeyDown, true));
}

/**
 * The {@link ToolId.MEDIA_DOWNLOAD} run handler. Resolves the media element,
 * classifies it, and either explains why it cannot be downloaded (Req 22.4) or
 * walks the feasible path (one-time ToS notice → confirm → download).
 */
async function runMediaTool(invocation: ToolInvocation): Promise<void> {
  closeOverlay();

  const element = resolveMediaElement(invocation.point);
  const target = buildTarget(element);
  const host = typeof location !== "undefined" ? location.host : undefined;
  const pageMeta: PageMeta = {};
  if (host) {
    pageMeta.host = host;
  }

  const feasibility = classifyMediaTarget(target, pageMeta);

  if (!feasibility.feasible) {
    // Graceful degradation: explain WHY, attempt no download (Req 22.4).
    notify({
      kind: "info",
      text: feasibility.reason,
      code: ErrorCode.MEDIA_INFEASIBLE,
    });
    return;
  }

  const url = feasibility.url;

  // One-time ToS notice BEFORE the first download (Req 13.8).
  if (await isMediaTosAccepted()) {
    openConfirmMenu(url, invocation.point);
  } else {
    openTosDialog(() => openConfirmMenu(url, invocation.point));
  }
}

/**
 * Install the real "Download media" behavior into the tool catalog, replacing
 * the placeholder stub. Wired by the content-script orchestrator (not edited
 * here).
 *
 * @returns `true` if the tool was registered (always, unless the catalog id
 * changes).
 */
export function registerMediaTool(): boolean {
  return registerTool(ToolId.MEDIA_DOWNLOAD, runMediaTool);
}
