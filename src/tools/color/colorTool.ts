/**
 * Alpha Cursor — Color Picker tool wiring (task 18.3).
 *
 * Wires Tool 9 (Color Picker, Req 14) into the Options_Panel tool catalog via
 * {@link registerTool}. The pure color helpers ({@link formatColor}) live in
 * `./color`; this module owns the *side-effecting* eyedropper behavior: entering
 * a sampling mode, reading the picked color, copying a paste-ready `#rrggbb`
 * token to the clipboard, and surfacing success/failure notifications.
 *
 * ## Two sampling strategies
 *
 * 1. **Native `EyeDropper` (preferred, Req 14.2/14.3).** When `window.EyeDropper`
 *    exists we call `await new EyeDropper().open()`, which hands control to the
 *    browser's screen-wide eyedropper (cursor-following, can sample *any* pixel
 *    on screen — the only way to truly satisfy Req 14.2/14.3 from a page). The
 *    promise resolves with `{ sRGBHex }` on click, or rejects with an
 *    `AbortError` `DOMException` when the user cancels (Escape) — which we treat
 *    as a silent deactivation with no clipboard write (Req 14.6).
 *
 * 2. **Canvas-sampled overlay (fallback).** A content script cannot read
 *    arbitrary *screen* pixels — there is no DOM API to rasterize the composited
 *    page from within the page, and `<canvas>` taints on cross-origin images.
 *    So the honest best-effort fallback overlays a full-viewport crosshair and,
 *    on click, reads the *effective* color of the element under the pointer via
 *    `document.elementFromPoint` + `getComputedStyle(...).backgroundColor`,
 *    walking up to the first ancestor with a non-transparent background. This
 *    samples real rendered element colors (not screenshots), which covers the
 *    common "grab this UI color" case. Transparent-everywhere → a sampling
 *    failure notification with no clipboard write (Req 14.4). Escape cancels the
 *    overlay without copying (Req 14.6).
 *
 * Either way the sampled color is normalized through {@link formatColor} into a
 * paste-ready lowercase `#rrggbb` token (Req 14.7) and copied via
 * `navigator.clipboard.writeText`; success shows "color copied successfully"
 * with the hex (Req 14.5).
 */

import { formatColor } from "./color";
import { notify } from "../../ui/notify";
import { createShadowHost } from "../../ui/shadowHost";
import { registerTool, ToolId, type ToolRun } from "../../content/tools";
import { ErrorCode } from "../../shared/messaging";

/** Message shown when a color is copied (Req 14.5). The hex is appended. */
const SUCCESS_TEXT = "color copied successfully";
/** Message shown when sampling fails or nothing could be sampled (Req 14.4). */
const SAMPLE_FAILED_TEXT = "could not sample color";

/**
 * Returns `true` when `err` is (or looks like) an `AbortError` `DOMException`,
 * i.e. the user cancelled the native eyedropper (Escape / click-away). Such a
 * cancellation must be silent: no clipboard write, no error toast (Req 14.6).
 */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === "AbortError";
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Copy a paste-ready `#rrggbb` token to the clipboard and notify success.
 * Returns `true` on success; on clipboard failure shows an error toast and
 * returns `false` (and, per Req 14.4 semantics, no success toast is shown).
 */
async function copyAndNotify(rawSample: string): Promise<boolean> {
  const hex = formatColor(rawSample);
  try {
    await navigator.clipboard.writeText(hex);
  } catch {
    notify({
      kind: "error",
      text: SAMPLE_FAILED_TEXT,
      code: ErrorCode.CLIPBOARD_FAILED,
    });
    return false;
  }
  notify({ kind: "success", text: `${SUCCESS_TEXT} ${hex}` });
  return true;
}

/** Notify a sampling failure WITHOUT touching the clipboard (Req 14.4). */
function notifySampleFailed(): void {
  notify({
    kind: "error",
    text: SAMPLE_FAILED_TEXT,
    code: ErrorCode.COLOR_SAMPLE_FAILED,
  });
}

/**
 * Run the native `EyeDropper` flow. Resolves once the interaction completes
 * (whether by copy, cancel, or failure) so the caller can treat it as the whole
 * activation. Returns `true` when the native API was available and handled the
 * interaction, `false` when it is unavailable (so the caller falls back).
 */
async function runNativeEyeDropper(): Promise<boolean> {
  const Ctor = (window as Window).EyeDropper;
  if (typeof Ctor !== "function") return false;

  try {
    const result = await new Ctor().open();
    await copyAndNotify(result.sRGBHex);
  } catch (err) {
    // Escape / click-away → silent deactivation, no clipboard write (Req 14.6).
    if (isAbortError(err)) return true;
    // Anything else is a genuine sampling/permission/display failure (Req 14.4).
    notifySampleFailed();
  }
  return true;
}

/**
 * Walk up from `element`, returning the first non-transparent computed
 * `background-color` as a CSS color string, or `null` when every ancestor up to
 * the document is transparent (so the caller can report a sampling failure).
 */
function effectiveBackgroundColor(element: Element | null): string | null {
  let node: Element | null = element;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && !isTransparent(bg)) return bg;
    node = node.parentElement;
  }
  return null;
}

/** Returns `true` for CSS colors that contribute no visible pixel (alpha 0). */
function isTransparent(color: string): boolean {
  const normalized = color.trim().toLowerCase();
  if (normalized === "transparent" || normalized === "") return true;
  // rgba()/hsla() with an explicit zero alpha.
  const alphaMatch = normalized.match(
    /^(?:rgba|hsla)\([^)]*,\s*(0|0?\.0+)\s*\)$/,
  );
  return alphaMatch !== null;
}

/**
 * Run the Canvas-sampled overlay fallback when the native API is unavailable.
 *
 * Overlays a full-viewport crosshair surface that captures a single click
 * (sample the element under the pointer) or Escape (cancel silently). Resolves
 * once the interaction completes. The overlay is always torn down.
 */
function runOverlayFallback(): Promise<void> {
  return new Promise<void>((resolve) => {
    const handle = createShadowHost({
      overlay: "full-viewport",
      surfaceId: "color-picker",
    });

    // A full-surface crosshair catcher that opts back into pointer events (the
    // host itself is pointer-events:none) so it can intercept the sample click.
    const catcher = document.createElement("div");
    catcher.setAttribute("role", "presentation");
    catcher.className = "fixed inset-0 pointer-events-auto cursor-crosshair";
    handle.mount(catcher);

    let settled = false;

    const cleanup = (): void => {
      window.removeEventListener("keydown", onKeyDown, true);
      handle.destroy();
    };

    /** Finish the interaction exactly once, tearing the overlay down. */
    const finish = (action: () => void | Promise<void>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      Promise.resolve(action()).finally(() => resolve());
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Escape deactivates without copying (Req 14.6).
      event.preventDefault();
      event.stopPropagation();
      finish(() => {});
    };

    const onClick = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      // Hide the overlay so elementFromPoint reads the page beneath it, then
      // sample the effective color under the pointer.
      const prevPointerEvents = handle.host.style.pointerEvents;
      handle.host.style.pointerEvents = "none";
      const target = document.elementFromPoint(event.clientX, event.clientY);
      handle.host.style.pointerEvents = prevPointerEvents;

      const sampled = effectiveBackgroundColor(target);
      if (sampled === null) {
        // Nothing visible to sample → failure, no clipboard write (Req 14.4).
        finish(() => notifySampleFailed());
        return;
      }
      finish(async () => {
        await copyAndNotify(sampled);
      });
    };

    catcher.addEventListener("click", onClick, true);
    // Capture Escape at the window level so it works regardless of focus.
    window.addEventListener("keydown", onKeyDown, true);
  });
}

/**
 * The Color Picker `run` handler installed into the tool catalog. Prefers the
 * native `EyeDropper`; otherwise runs the Canvas-sampled overlay fallback.
 */
export const runColorPicker: ToolRun = async (): Promise<void> => {
  const handledNatively = await runNativeEyeDropper();
  if (handledNatively) return;
  await runOverlayFallback();
};

/**
 * Register the Color Picker tool's real behavior in the Options_Panel catalog,
 * replacing the placeholder stub (Req 14.1–14.7). Called from the content-script
 * orchestrator at init time alongside the other tool registrations.
 *
 * @returns `true` if the tool was registered (it always exists in the catalog).
 */
export function registerColorTool(): boolean {
  return registerTool(ToolId.COLOR_PICKER, runColorPicker);
}
