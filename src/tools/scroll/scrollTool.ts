/**
 * Alpha Cursor — Tool — Horizontal Scroll wiring (task 22.3).
 *
 * Wires the toggleable horizontal-scroll mode into the Options_Panel catalog
 * via {@link registerHorizontalScrollTool}. Selecting "Horizontal Scroll" from
 * the panel toggles the mode ON; selecting it again toggles it OFF (Req 18.1,
 * 18.4).
 *
 * ## Behavior
 * - A module-level {@link enabled} flag tracks whether horizontal-scroll mode
 *   is active. The tool's `run` handler flips it on each invocation.
 * - While ON, a `wheel` listener (registered with `passive: false` so it may
 *   `preventDefault`) intercepts mouse-wheel input. It resolves the nearest
 *   scrollable ancestor of the event target, translates the wheel deltas into a
 *   single horizontal delta via the pure {@link wheelToHorizontalDelta} helper
 *   (task 22.1), applies it as a horizontal scroll, and calls `preventDefault`
 *   so the page does not also scroll vertically (Req 18.2, 18.3).
 * - While ON, a small persistent Notion-styled badge ("Horizontal scroll on")
 *   is shown in a closed Shadow DOM host so the user can see the mode is active
 *   (Req 18.5).
 * - While OFF, the listener and indicator are torn down.
 *
 * The delta math lives in {@link wheelToHorizontalDelta} (property-tested in
 * task 22.2); this module owns only the side-effecting wiring: the toggle, the
 * DOM listener, the scroll-target resolution, and the indicator lifecycle.
 */

import { createShadowHost, type ShadowHostHandle } from "../../ui/shadowHost";
import { joinClasses } from "../../ui/primitives/classNames";
import { registerTool, ToolId } from "../../content/tools";
import { wheelToHorizontalDelta } from "./horizontalScroll";

/** Module-level mode flag: `true` while horizontal-scroll mode is active. */
let enabled = false;

/** Active wheel-listener target while ON, else `null`. */
let wheelTarget: (Window & typeof globalThis) | null = null;

/** The bound wheel handler installed while ON, else `null`. */
let wheelHandler: ((event: WheelEvent) => void) | null = null;

/** The shadow host backing the active-mode indicator while ON, else `null`. */
let indicatorHost: ShadowHostHandle | null = null;

/**
 * Returns `true` when `el` is a scrollable container along the horizontal axis:
 * its content is wider than its client box AND its computed `overflow-x` allows
 * scrolling (`auto`/`scroll`).
 */
function isHorizontallyScrollable(el: Element): boolean {
  if (el.scrollWidth <= el.clientWidth) return false;
  const overflowX = getComputedStyle(el).overflowX;
  return overflowX === "auto" || overflowX === "scroll";
}

/**
 * Resolves the element that should receive the horizontal scroll for a wheel
 * event: the nearest scrollable ancestor of `target` (per
 * {@link isHorizontallyScrollable}), falling back to `document.scrollingElement`
 * (or `documentElement`) so the page itself scrolls when no inner container
 * qualifies (Req 18.2).
 */
function resolveScrollTarget(target: EventTarget | null): Element {
  let node: Element | null =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;

  while (node) {
    if (isHorizontallyScrollable(node)) return node;
    node = node.parentElement;
  }

  return document.scrollingElement ?? document.documentElement;
}

/**
 * The wheel handler installed while horizontal-scroll mode is ON. Translates
 * the wheel deltas into a horizontal delta, applies it to the resolved target,
 * and suppresses the default (vertical) scroll (Req 18.2, 18.3).
 */
function handleWheel(event: WheelEvent): void {
  const delta = wheelToHorizontalDelta(event.deltaY, event.deltaX);
  if (delta === 0) return;

  const el = resolveScrollTarget(event.target);

  if (typeof el.scrollBy === "function") {
    el.scrollBy({ left: delta });
  } else {
    el.scrollLeft += delta;
  }

  // Suppress the browser's default vertical scroll for this wheel tick.
  event.preventDefault();
}

/**
 * Builds and mounts the persistent active-mode indicator badge inside a closed
 * Shadow DOM host pinned to the bottom-left of the viewport (Req 18.5). No-op
 * if an indicator already exists.
 */
function showIndicator(): void {
  if (indicatorHost && !indicatorHost.destroyed) return;

  const host = createShadowHost({
    overlay: "full-viewport",
    surfaceId: "horizontal-scroll-indicator",
  });

  const badge = document.createElement("div");
  // ex-toast-like chrome: surface bg, ink text, body-sm, pill, hairline edge,
  // elevated shadow. Pinned bottom-left so it does not collide with toasts
  // (which stack bottom-right). Decorative only — `aria-hidden`.
  badge.className = joinClasses(
    "fixed bottom-md left-md inline-flex items-center gap-xs",
    "bg-surface text-ink text-body-sm font-sans",
    "rounded-full py-xs px-md border border-hairline acx-elevated",
  );
  badge.setAttribute("aria-hidden", "true");

  const dot = document.createElement("span");
  dot.className = "shrink-0 size-2 rounded-full bg-accent-sky";
  badge.appendChild(dot);

  const label = document.createElement("span");
  label.textContent = "Horizontal scroll on";
  badge.appendChild(label);

  host.mount(badge);
  indicatorHost = host;
}

/** Tears down the active-mode indicator if present. */
function hideIndicator(): void {
  indicatorHost?.destroy();
  indicatorHost = null;
}

/** Installs the wheel listener if not already installed (Req 18.2, 18.3). */
function attachWheelListener(): void {
  if (wheelHandler) return;
  const target = window as Window & typeof globalThis;
  wheelHandler = handleWheel;
  wheelTarget = target;
  // `passive: false` is required so `preventDefault()` actually suppresses the
  // default vertical scroll.
  target.addEventListener("wheel", wheelHandler, { passive: false });
}

/** Removes the wheel listener if installed. */
function detachWheelListener(): void {
  if (wheelHandler && wheelTarget) {
    wheelTarget.removeEventListener("wheel", wheelHandler);
  }
  wheelHandler = null;
  wheelTarget = null;
}

/**
 * Enables horizontal-scroll mode: installs the wheel listener and shows the
 * active-mode indicator. Idempotent.
 */
function enable(): void {
  if (enabled) return;
  enabled = true;
  attachWheelListener();
  showIndicator();
}

/**
 * Disables horizontal-scroll mode: removes the wheel listener and indicator.
 * Idempotent.
 */
function disable(): void {
  if (!enabled) return;
  enabled = false;
  detachWheelListener();
  hideIndicator();
}

/**
 * Toggles horizontal-scroll mode ON/OFF. Selecting the tool while OFF enables
 * the mode; selecting it again while ON disables it (Req 18.1, 18.4).
 */
export function toggleHorizontalScroll(): void {
  if (enabled) {
    disable();
  } else {
    enable();
  }
}

/** Returns `true` while horizontal-scroll mode is active (for tests). */
export function isHorizontalScrollEnabled(): boolean {
  return enabled;
}

/**
 * Registers the real {@link ToolId.HORIZONTAL_SCROLL} `run` handler, replacing
 * the catalog placeholder. Called from the content-script bootstrap.
 *
 * @returns `true` if the tool was found and wired (matches {@link registerTool}).
 *
 * @example
 * registerHorizontalScrollTool();
 */
export function registerHorizontalScrollTool(): boolean {
  return registerTool(ToolId.HORIZONTAL_SCROLL, () => {
    toggleHorizontalScroll();
  });
}
