/**
 * Alpha Cursor — closed Shadow DOM host factory.
 *
 * The content-script UI (Options_Panel, OCR overlay, color picker, tab shifter,
 * notifications) must mount inside CLOSED Shadow DOM roots so host-page CSS
 * cannot bleed in and the extension's CSS cannot bleed out (Req 2.11, 20.1).
 *
 * This module provides {@link createShadowHost}, a framework-agnostic factory
 * (plain DOM, no React) that:
 *   - creates a host `<div>` appended to `document.documentElement`/`body`,
 *     styled as an overlay container that does not disturb the host page's
 *     layout,
 *   - attaches a CLOSED shadow root and adopts the shared Tailwind + Notion
 *     token stylesheet via {@link applySharedStyles},
 *   - returns a {@link ShadowHostHandle} so callers can mount their UI into the
 *     isolated root, reposition it, and tear everything down cleanly.
 *
 * Two overlay layouts are supported through {@link CreateShadowHostOptions}:
 *   - `overlay: "anchored"` (default) — a zero-size host positioned at a given
 *     viewport point, used for the radial Options_Panel near the cursor. The
 *     host itself ignores pointer events; mounted content re-enables them.
 *   - `overlay: "full-viewport"` — a host covering the whole viewport, used for
 *     full-surface interactions like the OCR drag-selection overlay.
 */

import { applySharedStyles } from "./styles/theme";

/** Distinctive attribute placed on every Alpha Cursor shadow host element. */
export const HOST_ATTRIBUTE = "data-acx-ui";

/** Overlay layout strategies for a shadow host. */
export type ShadowHostOverlay = "anchored" | "full-viewport";

/** A viewport-relative point (CSS pixels) used to anchor an overlay host. */
export interface ShadowHostPoint {
  x: number;
  y: number;
}

/** Options controlling how a shadow host is created and positioned. */
export interface CreateShadowHostOptions {
  /**
   * Overlay layout. `"anchored"` (default) creates a zero-size host positioned
   * at {@link CreateShadowHostOptions.point} for cursor-anchored surfaces such
   * as the radial Options_Panel. `"full-viewport"` creates a host that covers
   * the entire viewport for drag-selection surfaces such as OCR.
   */
  overlay?: ShadowHostOverlay;
  /**
   * Initial anchor point (viewport coordinates) for `"anchored"` overlays.
   * Ignored for `"full-viewport"` overlays. Defaults to `{ x: 0, y: 0 }`.
   */
  point?: ShadowHostPoint;
  /**
   * `z-index` applied to the host element. Defaults to a very high value so
   * extension UI renders above typical host-page content.
   */
  zIndex?: number;
  /**
   * Identifier recorded on the host's {@link HOST_ATTRIBUTE} so multiple
   * surfaces can coexist and be told apart (e.g. `"options-panel"`,
   * `"ocr-overlay"`, `"toast"`). Defaults to `"surface"`.
   */
  surfaceId?: string;
  /**
   * Parent node to append the host to. Defaults to `document.body` when ready,
   * otherwise `document.documentElement`.
   */
  container?: ParentNode;
}

/** Handle returned by {@link createShadowHost} for controlling a mounted host. */
export interface ShadowHostHandle {
  /** The host element appended to the document. */
  readonly host: HTMLDivElement;
  /** The CLOSED shadow root with shared styles applied. */
  readonly root: ShadowRoot;
  /** The surface identifier recorded on the host. */
  readonly surfaceId: string;
  /** `true` once {@link ShadowHostHandle.destroy} has run. */
  readonly destroyed: boolean;
  /**
   * Mounts a node into the isolated shadow root. Replaces any previously
   * mounted content. Returns the mounted node for convenience.
   */
  mount<T extends Node>(node: T): T;
  /** Removes any mounted content from the shadow root without destroying the host. */
  unmount(): void;
  /**
   * Repositions an `"anchored"` overlay host to a new viewport point. No-op for
   * `"full-viewport"` hosts.
   */
  reposition(point: ShadowHostPoint): void;
  /**
   * Registers a teardown callback (e.g. an event-listener remover) to be run on
   * {@link ShadowHostHandle.destroy}. Returns a function that unregisters it.
   */
  onDestroy(cleanup: () => void): () => void;
  /**
   * Removes the host element from the document, clears mounted content, and
   * runs all registered teardown callbacks. Idempotent.
   */
  destroy(): void;
}

const DEFAULT_Z_INDEX = 2147483646;

/**
 * Resolves the parent node to attach the host to, tolerating the case where
 * `document.body` is not yet available (e.g. a content script running at
 * `document_start`). Falls back to `document.documentElement`.
 */
function resolveContainer(container: ParentNode | undefined): ParentNode {
  if (container) return container;
  return document.body ?? document.documentElement;
}

/**
 * Applies the base overlay styles to the host element. The host is positioned
 * with `fixed` so it is viewport-relative and removed from normal document
 * flow, ensuring it never shifts host-page layout.
 */
function applyHostStyles(
  host: HTMLDivElement,
  overlay: ShadowHostOverlay,
  point: ShadowHostPoint,
  zIndex: number,
): void {
  const style = host.style;
  style.position = "fixed";
  style.margin = "0";
  style.padding = "0";
  style.border = "0";
  style.background = "transparent";
  style.zIndex = String(zIndex);
  // The host is a passthrough container; mounted UI opts back into pointer
  // events as needed so the rest of the page stays interactive.
  style.pointerEvents = "none";

  if (overlay === "full-viewport") {
    style.top = "0";
    style.left = "0";
    style.width = "100vw";
    style.height = "100vh";
  } else {
    // Anchored: a zero-size point so it never affects layout; mounted content
    // is positioned relative to this point by the caller.
    style.top = `${point.y}px`;
    style.left = `${point.x}px`;
    style.width = "0";
    style.height = "0";
  }
}

/**
 * Creates a closed Shadow DOM host for a content-script UI surface.
 *
 * @example
 * // Radial Options_Panel anchored near the cursor:
 * const handle = createShadowHost({
 *   overlay: "anchored",
 *   point: { x: event.clientX, y: event.clientY },
 *   surfaceId: "options-panel",
 * });
 * handle.mount(buildPanelElement());
 * // ...later
 * handle.destroy();
 *
 * @example
 * // Full-viewport OCR drag-selection overlay:
 * const handle = createShadowHost({ overlay: "full-viewport", surfaceId: "ocr-overlay" });
 */
export function createShadowHost(
  options: CreateShadowHostOptions = {},
): ShadowHostHandle {
  const overlay: ShadowHostOverlay = options.overlay ?? "anchored";
  const point: ShadowHostPoint = options.point ?? { x: 0, y: 0 };
  const zIndex = options.zIndex ?? DEFAULT_Z_INDEX;
  const surfaceId = options.surfaceId ?? "surface";

  const host = document.createElement("div");
  host.setAttribute(HOST_ATTRIBUTE, surfaceId);
  applyHostStyles(host, overlay, point, zIndex);

  const root = host.attachShadow({ mode: "closed" });
  applySharedStyles(root);

  resolveContainer(options.container).appendChild(host);

  const cleanups = new Set<() => void>();
  let mounted: Node | null = null;
  let destroyed = false;

  const handle: ShadowHostHandle = {
    host,
    root,
    surfaceId,
    get destroyed() {
      return destroyed;
    },
    mount<T extends Node>(node: T): T {
      if (destroyed) {
        throw new Error(
          `createShadowHost: cannot mount into destroyed host "${surfaceId}"`,
        );
      }
      if (mounted && mounted.parentNode === root) {
        root.removeChild(mounted);
      }
      root.appendChild(node);
      mounted = node;
      return node;
    },
    unmount(): void {
      if (mounted && mounted.parentNode === root) {
        root.removeChild(mounted);
      }
      mounted = null;
    },
    reposition(next: ShadowHostPoint): void {
      if (destroyed || overlay !== "anchored") return;
      host.style.top = `${next.y}px`;
      host.style.left = `${next.x}px`;
    },
    onDestroy(cleanup: () => void): () => void {
      if (destroyed) {
        // Host already gone; run immediately so callers don't leak.
        cleanup();
        return () => {};
      }
      cleanups.add(cleanup);
      return () => cleanups.delete(cleanup);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // Teardown callbacks must not block the rest of destruction.
        }
      }
      cleanups.clear();
      this.unmount();
      host.parentNode?.removeChild(host);
    },
  };

  return handle;
}
