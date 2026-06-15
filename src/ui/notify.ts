/**
 * Alpha Cursor — Notification (toast) system.
 *
 * A single API, {@link notify}, renders a transient Notion-styled toast inside
 * the content-script CLOSED Shadow DOM (Req 20.1). It is the one channel every
 * tool uses to report success/failure back to the user.
 *
 * Visual chrome follows the DESIGN.md `ex-toast` token: white `surface`
 * background, `rounded-xl` (16px) corners, `sm`/`md` padding, `body-sm`
 * typography, and the deeper Level-2 `shadow-elevated` layered shadow. The
 * chrome stays deliberately quiet — the only colour is a small decorative dot
 * per kind drawn from the sticker palette (green / orange / sky). We never
 * introduce a second *structural* accent alongside Notion blue (DESIGN.md
 * "Don't introduce a second structural accent").
 *
 * Motion (Req 20.6): entrance/exit fade + slide is gated behind
 * `prefers-reduced-motion`. When the user requests reduced motion, toasts
 * appear and disappear instantly with no transform/opacity transition.
 *
 * Accessibility: success/info toasts use `role="status"` + `aria-live="polite"`
 * so they are announced without interrupting; error toasts use `role="alert"` +
 * `aria-live="assertive"`.
 *
 * Multiple `notify()` calls stack neatly in a bottom-right column. The shared
 * shadow host is created lazily on the first toast and torn down automatically
 * once the last toast is dismissed, so no idle host element lingers in the page.
 */

import { createShadowHost, type ShadowHostHandle } from "./shadowHost";
import { joinClasses } from "./primitives/classNames";
import type { ErrorCode } from "../shared/messaging";

/** Severity of a toast, driving its decorative dot colour and ARIA semantics. */
export type NotifyKind = "success" | "error" | "info";

/** Options accepted by {@link notify}. */
export interface NotifyOptions {
  /** Severity. Defaults to `"info"`. */
  kind?: NotifyKind;
  /** The message text shown to the user. Rendered as plain text (never HTML). */
  text: string;
  /**
   * Optional {@link ErrorCode} accompanying a failure. Rendered as a quiet,
   * muted suffix so power users / bug reports can reference the exact code.
   */
  code?: ErrorCode;
  /**
   * Auto-dismiss delay in milliseconds. Defaults to {@link DEFAULT_DURATION_MS}.
   * Pass a non-finite or non-positive value to keep the toast until it is
   * dismissed manually via the returned handle.
   */
  durationMs?: number;
}

/** Handle returned by {@link notify} so callers can dismiss a toast early. */
export interface NotifyHandle {
  /** Dismisses this toast (idempotent), animating out unless reduced motion. */
  dismiss(): void;
}

/** Default auto-dismiss delay. */
export const DEFAULT_DURATION_MS = 3500;

/** Duration of the entrance/exit transition (skipped under reduced motion). */
const ANIMATION_MS = 180;

/** Decorative dot colour per kind (arcade palette — decoration only). */
const DOT_COLOR: Record<NotifyKind, string> = {
  success: "#2bb673", // green
  error: "#ff5a5f", // coral red
  info: "#ffd913", // brand yellow
};

/**
 * Module-level shared host + stack. Created lazily on the first toast and
 * destroyed once the last toast leaves, so the page carries no idle overlay.
 */
let hostHandle: ShadowHostHandle | null = null;
let stackEl: HTMLElement | null = null;
let liveCount = 0;

/** Returns `true` when the user has requested reduced motion (Req 20.6). */
function prefersReducedMotion(): boolean {
  const mm = (
    globalThis as { matchMedia?: (q: string) => MediaQueryList }
  ).matchMedia;
  if (typeof mm !== "function") return false;
  try {
    return mm("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/**
 * Ensures the shared shadow host and toast stack exist, creating them on first
 * use. The host is a full-viewport passthrough overlay (pointer-events none);
 * the stack pins itself to the bottom-right and re-enables pointer events on
 * individual toasts so they can be clicked away without blocking the page.
 */
function ensureStack(): HTMLElement {
  if (hostHandle && !hostHandle.destroyed && stackEl) return stackEl;

  hostHandle = createShadowHost({
    overlay: "full-viewport",
    surfaceId: "toast",
  });

  const stack = document.createElement("div");
  // Bottom-right column. `position: fixed` is viewport-relative inside the
  // full-viewport host. `pointer-events: none` keeps the gap between toasts
  // transparent to clicks; each toast opts back in.
  stack.className = joinClasses(
    "fixed bottom-md right-md flex flex-col items-end gap-xs",
    "max-w-[min(360px,calc(100vw-2rem))] pointer-events-none",
  );
  stack.setAttribute("role", "region");
  stack.setAttribute("aria-label", "Notifications");

  hostHandle.mount(stack);
  stackEl = stack;
  return stack;
}

/** Tears down the shared host once no toasts remain. */
function teardownIfEmpty(): void {
  if (liveCount > 0) return;
  hostHandle?.destroy();
  hostHandle = null;
  stackEl = null;
}

/** Builds the toast element for a given set of options. */
function buildToast(kind: NotifyKind, text: string, code?: ErrorCode): HTMLElement {
  const toast = document.createElement("div");
  // Wise dark toast chrome. Colors are fixed inline (not token classes) so the
  // toast reads as the brand's dark "ink + green" surface on ANY host page,
  // independent of the token cascade's resolved color scheme.
  toast.className = joinClasses(
    "pointer-events-auto inline-flex items-center gap-sm",
    "font-sans text-body-sm",
  );
  toast.style.background = "var(--acx-color-surface)";
  toast.style.color = "var(--acx-color-ink)";
  toast.style.border = "2px solid var(--acx-color-hairline)";
  toast.style.borderRadius = "4px";
  toast.style.padding = "8px 14px";
  toast.style.fontWeight = "400";
  toast.style.boxShadow = "var(--acx-shadow-soft)";

  // ARIA: errors interrupt (assertive/alert); success+info are polite/status.
  if (kind === "error") {
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "assertive");
  } else {
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
  }

  const dot = document.createElement("span");
  dot.setAttribute("aria-hidden", "true");
  dot.className = "shrink-0 size-2 rounded-full";
  dot.style.background = DOT_COLOR[kind];
  toast.appendChild(dot);

  const message = document.createElement("span");
  message.className = "min-w-0";
  message.textContent = text;
  toast.appendChild(message);

  if (code) {
    const codeEl = document.createElement("span");
    codeEl.className = "shrink-0 text-eyebrow font-sans";
    codeEl.style.color = "var(--acx-color-ink-muted)";
    codeEl.textContent = code;
    toast.appendChild(codeEl);
  }

  return toast;
}

/**
 * Renders a transient Notion-styled toast in the content-script Shadow DOM and
 * returns a {@link NotifyHandle} for early dismissal.
 *
 * @example
 * notify({ kind: "success", text: "Copied 12 items to the clipboard" });
 *
 * @example
 * const t = notify({ kind: "error", text: "Capture failed", code: ErrorCode.CAPTURE_FAILED });
 * // ...later, if the situation resolves:
 * t.dismiss();
 */
export function notify(options: NotifyOptions): NotifyHandle {
  const kind: NotifyKind = options.kind ?? "info";
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
  const reduceMotion = prefersReducedMotion();

  const stack = ensureStack();
  const toast = buildToast(kind, options.text, options.code);

  // Entrance: hidden-then-revealed only when motion is allowed; otherwise the
  // toast is fully visible from the first frame (Req 20.6).
  if (!reduceMotion) {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
    toast.style.transition = `opacity ${ANIMATION_MS}ms ease-out, transform ${ANIMATION_MS}ms ease-out`;
  }

  stack.appendChild(toast);
  liveCount += 1;

  if (!reduceMotion) {
    // Next frame, flip to the visible state so the transition runs.
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    });
  }

  let dismissed = false;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let autoTimer: ReturnType<typeof setTimeout> | undefined;

  const removeNow = (): void => {
    toast.remove();
    liveCount = Math.max(0, liveCount - 1);
    teardownIfEmpty();
  };

  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    if (autoTimer !== undefined) clearTimeout(autoTimer);

    if (reduceMotion) {
      removeNow();
      return;
    }

    // Exit transition, then remove. A fallback timer guards against a missed
    // `transitionend` (e.g. element detached or display:none mid-flight).
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
    const onEnd = (): void => {
      if (exitTimer !== undefined) clearTimeout(exitTimer);
      toast.removeEventListener("transitionend", onEnd);
      removeNow();
    };
    toast.addEventListener("transitionend", onEnd);
    exitTimer = setTimeout(onEnd, ANIMATION_MS + 50);
  };

  // Auto-dismiss unless a non-positive / non-finite duration was requested.
  if (Number.isFinite(durationMs) && durationMs > 0) {
    autoTimer = setTimeout(dismiss, durationMs);
  }

  return { dismiss };
}
