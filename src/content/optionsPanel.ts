/**
 * Alpha Cursor — radial Options_Panel (task 10.5).
 *
 * Renders the context-aware radial menu inside a CLOSED Shadow DOM at the
 * middle-click point, repositioning so the whole panel stays within the
 * viewport, closing on outside-click / Escape, and dispatching the chosen
 * tool's `run` on select (Req 2.7–2.11).
 *
 * Responsibilities:
 *   - {@link repositionPanel} — PURE geometry: clamps a panel of a given size,
 *     centered on a point, fully inside the viewport (Req 2.8, Property 3).
 *     Exported for property testing (task 10.6).
 *   - {@link openPanel} / {@link closePanel} — create/tear down a closed shadow
 *     host, render the resolved tools radially with Notion tokens, wire
 *     outside-click + Escape close (Req 2.9) and select → close + run (Req 2.10).
 *   - {@link attachPanelTrigger} — content-script entry: wires the middle mouse
 *     button to `resolveContext` + `openPanel`, ONLY when the Toggle is enabled
 *     (Req 1.3), and prevents the browser's default middle-click while open
 *     (Req 1.2 leaves default behavior intact when OFF).
 *
 * Styling uses the Notion tokens via the shared Shadow-DOM stylesheet: an
 * elevated white `feature-card`-style hub plus circular icon buttons arranged
 * on a ring (Req 2.11, 20).
 */

import { createShadowHost, type ShadowHostHandle } from "../ui/shadowHost";
import { createButton } from "../ui/primitives/button";
import { joinClasses } from "../ui/primitives/classNames";
import { getCachedEnabled } from "../shared/settings";
import { resolveContext, type ContextType } from "./context";
import { resolveToolSet, type Tool, type ToolInvocation } from "./tools";

/** A 2-D size in CSS pixels. */
export interface PanelSize {
  width: number;
  height: number;
}

/** Viewport dimensions in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/** A viewport-relative point in CSS pixels. */
export interface Point {
  x: number;
  y: number;
}

/**
 * PURE viewport-edge repositioning (Property 3, Req 2.8).
 *
 * Given the cursor `point` (the desired panel CENTER), the panel's `panelSize`,
 * and the `viewport` dimensions, returns the panel's top-left `{x, y}` such that
 * the entire panel rectangle lies within `[0, viewport.width] × [0,
 * viewport.height]`.
 *
 * The panel is first centered on the point, then clamped against each edge. When
 * the panel is larger than the viewport along an axis (degenerate case), it is
 * pinned to the top/left so the origin stays on-screen — the best-effort
 * containment guarantee the property expects.
 *
 * Exported for property testing (task 10.6).
 */
export function repositionPanel(
  point: Point,
  panelSize: PanelSize,
  viewport: Viewport,
): Point {
  const clampAxis = (
    center: number,
    size: number,
    bound: number,
  ): number => {
    // Desired top-left so the panel is centered on the point.
    const desired = center - size / 2;
    // Largest top-left that still keeps the far edge within the viewport.
    const max = bound - size;
    if (max <= 0) {
      // Panel doesn't fit on this axis — pin to the origin (best effort).
      return 0;
    }
    return Math.max(0, Math.min(desired, max));
  };

  return {
    x: clampAxis(point.x, panelSize.width, viewport.width),
    y: clampAxis(point.y, panelSize.height, viewport.height),
  };
}

/** Default panel diameter (CSS px) used to estimate size for repositioning. */
const PANEL_DIAMETER = 280;
/** Radius of the ring the tool buttons sit on. */
const RING_RADIUS = 96;
/** Size of each circular tool button (matches the icon-circular `size-9`). */
const BUTTON_SIZE = 36;

/** Module-level handle to the currently open panel, if any. */
let activeHandle: ShadowHostHandle | null = null;

/** Reads the current viewport size, tolerating non-DOM contexts. */
function currentViewport(): Viewport {
  return {
    width: typeof window !== "undefined" ? window.innerWidth : 0,
    height: typeof window !== "undefined" ? window.innerHeight : 0,
  };
}

/**
 * Builds the radial panel element: an elevated Notion surface with the tools'
 * circular icon buttons distributed evenly around a ring. Selecting a button
 * closes the panel and invokes the tool's `run` (Req 2.10).
 */
function buildPanel(
  tools: Tool[],
  context: ContextType,
  point: Point,
): HTMLElement {
  const panel = document.createElement("div");
  panel.setAttribute("role", "menu");
  panel.setAttribute("aria-label", "Alpha Cursor options");
  // Re-enable pointer events (the host is passthrough), size the radial area,
  // and lift it onto the page with the Notion elevated surface treatment.
  panel.className = joinClasses(
    "pointer-events-auto relative box-border rounded-full",
    "bg-surface border border-hairline acx-elevated",
  );
  panel.style.width = `${PANEL_DIAMETER}px`;
  panel.style.height = `${PANEL_DIAMETER}px`;

  const center = PANEL_DIAMETER / 2;
  const count = tools.length;

  tools.forEach((tool, index) => {
    const invocation: ToolInvocation = { context, point };
    const button = createButton({
      variant: "icon-circular",
      icon: tool.icon ?? tool.label.charAt(0),
      ariaLabel: tool.label,
      onClick: () => {
        // Select → close, then invoke the tool (Req 2.10).
        closePanel();
        void Promise.resolve(tool.run(invocation)).catch(() => {
          /* tool handlers surface their own failures via notify() */
        });
      },
    });
    button.setAttribute("role", "menuitem");
    button.setAttribute("title", tool.label);
    button.style.position = "absolute";

    // Evenly distribute around the ring, starting at the top (−90°).
    const angle = count === 0 ? 0 : (index / count) * Math.PI * 2 - Math.PI / 2;
    const cx = center + Math.cos(angle) * RING_RADIUS;
    const cy = center + Math.sin(angle) * RING_RADIUS;
    button.style.left = `${cx - BUTTON_SIZE / 2}px`;
    button.style.top = `${cy - BUTTON_SIZE / 2}px`;

    panel.appendChild(button);
  });

  return panel;
}

/**
 * Opens the radial Options_Panel for a resolved {@link ContextType} at a
 * viewport point. Closes any panel already open. Renders the tools applicable
 * to the context (via {@link resolveToolSet}) inside a closed shadow host,
 * repositions the host so the panel stays fully on-screen (Req 2.8), and wires
 * outside-click + Escape to close (Req 2.9).
 */
export function openPanel(context: ContextType, point: Point): void {
  closePanel();

  const size: PanelSize = { width: PANEL_DIAMETER, height: PANEL_DIAMETER };
  const origin = repositionPanel(point, size, currentViewport());

  const handle = createShadowHost({
    overlay: "anchored",
    point: origin,
    surfaceId: "options-panel",
  });
  activeHandle = handle;

  const tools = resolveToolSet(context);
  handle.mount(buildPanel(tools, context, point));

  // Escape closes (Req 2.9). Capture phase so it wins over page handlers.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    }
  };

  // Outside-click closes (Req 2.9). The panel itself lives in a closed shadow
  // root, so any click whose composed path does not include the host element is
  // "outside". Registered on the next tick so the opening click doesn't
  // immediately close it.
  const onPointerDown = (event: MouseEvent): void => {
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];
    if (!path.includes(handle.host)) {
      closePanel();
    }
  };

  window.addEventListener("keydown", onKeyDown, true);
  handle.onDestroy(() => window.removeEventListener("keydown", onKeyDown, true));

  const attachOutside = (): void => {
    window.addEventListener("mousedown", onPointerDown, true);
    handle.onDestroy(() =>
      window.removeEventListener("mousedown", onPointerDown, true),
    );
  };
  // Defer one frame/tick so the triggering click is not treated as outside.
  setTimeout(attachOutside, 0);
}

/** Closes the Options_Panel if open. Idempotent (Req 2.9, 2.10). */
export function closePanel(): void {
  if (activeHandle) {
    activeHandle.destroy();
    activeHandle = null;
  }
}

/** Returns `true` while an Options_Panel is open. */
export function isPanelOpen(): boolean {
  return activeHandle !== null && !activeHandle.destroyed;
}

/** Disposer returned by {@link attachPanelTrigger} to unwire the trigger. */
export type DetachPanelTrigger = () => void;

/**
 * Wire the middle mouse button to open the Options_Panel (content-script
 * entry). On `mousedown` with `button === 1` (middle), and ONLY while the
 * Toggle is enabled (Req 1.3), this resolves the context and opens the panel,
 * preventing the browser's default middle-click (autoscroll/paste) so it does
 * not compete with the panel. While the Toggle is OFF the handler does nothing,
 * leaving default middle-click behavior intact (Req 1.2).
 *
 * The companion `auxclick` handler suppresses the default action for the same
 * middle button while enabled, since `mousedown` alone does not cancel
 * autoscroll on every platform.
 *
 * @returns a disposer that removes the listeners (used when the Toggle flips
 * OFF — see {@link bootstrapContent} in `content/index.ts`).
 */
export function attachPanelTrigger(
  target: Window | HTMLElement = window,
): DetachPanelTrigger {
  // Diagnostic: confirms the trigger was wired on this page.
  console.debug("[Alpha Cursor] middle-click trigger attached");

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 1) return; // middle button only
    console.debug("[Alpha Cursor] middle mousedown detected", {
      enabled: getCachedEnabled(),
    });
    if (!getCachedEnabled()) return; // Req 1.2/1.3 — OFF: leave default behavior
    event.preventDefault();
    event.stopPropagation();
    const context = resolveContext(event);
    openPanel(context, { x: event.clientX, y: event.clientY });
  };

  const onAuxClick = (event: MouseEvent): void => {
    if (event.button !== 1) return;
    if (!getCachedEnabled()) return;
    // Suppress the default middle-click action while enabled.
    event.preventDefault();
  };

  target.addEventListener("mousedown", onMouseDown as EventListener, true);
  target.addEventListener("auxclick", onAuxClick as EventListener, true);

  return () => {
    target.removeEventListener("mousedown", onMouseDown as EventListener, true);
    target.removeEventListener("auxclick", onAuxClick as EventListener, true);
    closePanel();
  };
}
