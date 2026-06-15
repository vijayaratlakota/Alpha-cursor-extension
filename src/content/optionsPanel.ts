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
import { joinClasses } from "../ui/primitives/classNames";
import { createToolIcon } from "../ui/icons";
import { getCachedEnabled, getCachedPanelStyle } from "../shared/settings";
import { resolveContext, type ContextType } from "./context";
import { resolveToolSet, type Tool, type ToolInvocation } from "./tools";
import { openConsolePanel, closeConsolePanel } from "./consolePanel";

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
const PANEL_DIAMETER = 260;
/** Radius of the ring the tool buttons sit on. */
const RING_RADIUS = 90;
/** Size of each circular tool button. */
const BUTTON_SIZE = 42;
/** Edge length (CSS px) of the line icon inside each button. */
const ICON_SIZE = 20;
/** Gap (CSS px) between a button's outer edge and its tooltip. */
const TOOLTIP_GAP = 10;

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
 * Builds a Wise-styled tooltip for a tool button (Req 2.13, 2.14). The tooltip
 * carries the tool's full descriptive `label`, is rendered inside the same
 * closed Shadow DOM beside its button, and fades via an `ease-out` opacity
 * transition gated behind `prefers-reduced-motion` (handled in the panel
 * stylesheet) so reduced-motion users get an instant, motionless tooltip
 * (Req 20.6). It is `aria-hidden` because the button already exposes the same
 * text via `aria-label` (Req 20.7).
 *
 * Colors are fixed Wise-dark values (`.acx-tip`) so the label reads correctly
 * regardless of the host page's color scheme.
 */
function buildTooltip(label: string): HTMLElement {
  const tooltip = document.createElement("div");
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  tooltip.textContent = label;
  tooltip.className = "acx-tip";
  return tooltip;
}

/** Reveals a tooltip built by {@link buildTooltip}. */
function showTooltip(tooltip: HTMLElement): void {
  tooltip.classList.add("acx-tip-show");
}

/** Hides a tooltip built by {@link buildTooltip}. */
function hideTooltip(tooltip: HTMLElement): void {
  tooltip.classList.remove("acx-tip-show");
}

/**
 * One-time-per-panel `<style>` block carrying the dark Wise hub treatment, the
 * entrance keyframes, the per-button hover/focus state (icon turns lime-green),
 * and the beside-the-icon tooltip. Injected into the panel element so it lives
 * inside the closed Shadow DOM with FIXED dark color values — the panel renders
 * in the brand's "ink + green" dark moment regardless of the host page's or the
 * token cascade's color scheme (Req 20.8). Motion is disabled under
 * `prefers-reduced-motion` (Req 20.6, 2.14); only color changes remain.
 */
function buildPanelStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `
    .acx-radial {
      background: var(--acx-color-surface);
      border: 3px solid var(--acx-color-hairline);
      box-shadow: var(--acx-shadow-elevated);
    }
    .acx-hint {
      color: var(--acx-color-ink-muted);
    }
    .acx-tool {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      border: 3px solid var(--acx-color-hairline);
      background: var(--acx-color-surface);
      color: var(--acx-color-ink);
      cursor: pointer;
      border-radius: 9999px;
      padding: 0;
      outline: none;
      box-shadow: var(--acx-shadow-soft);
      transition: background-color 100ms steps(2, end), color 100ms steps(2, end),
        box-shadow 80ms steps(2, end), transform 80ms steps(2, end);
    }
    .acx-tool:hover,
    .acx-tool:focus-visible {
      background: var(--acx-color-primary);
      color: var(--acx-color-on-primary);
      transform: translate(1px, 1px);
    }
    .acx-tool:active {
      /* Press the coin into its shadow. */
      box-shadow: 0 0 0 0 var(--acx-color-hairline);
      transform: translate(var(--acx-press-offset, 3px), var(--acx-press-offset, 3px));
    }
    .acx-tip {
      position: absolute;
      z-index: 20;
      pointer-events: none;
      white-space: nowrap;
      border-radius: 2px;
      border: 2px solid var(--acx-color-hairline);
      background: var(--acx-color-surface);
      color: var(--acx-color-ink);
      padding: 4px 10px;
      font-family: var(--acx-font-sans, "VT323", monospace);
      font-size: 16px;
      font-weight: 400;
      line-height: 1.2;
      box-shadow: var(--acx-shadow-soft);
      opacity: 0;
    }
    .acx-tip-show { opacity: 1; }
    @media (prefers-reduced-motion: no-preference) {
      .acx-radial { animation: acx-radial-in 150ms steps(3, end) both; }
      .acx-tool {
        animation: acx-tool-in 180ms steps(3, end) both;
      }
      .acx-tip { transition: opacity 120ms steps(2, end); }
    }
    @keyframes acx-radial-in {
      from { opacity: 0; transform: scale(0.92); }
      to   { opacity: 1; transform: scale(1); }
    }
    @keyframes acx-tool-in {
      from { opacity: 0; transform: scale(0.6); }
      to   { opacity: 1; transform: scale(1); }
    }
  `;
  return style;
}

/**
 * Builds the radial panel element: an elevated dark Wise hub with the tools'
 * large circular line-icon buttons distributed evenly around a ring. Icons are
 * white by default and turn lime-green on hover/focus, with a styled tooltip
 * showing the tool's full name BESIDE the icon. Selecting a button closes the
 * panel and invokes the tool's `run` (Req 2.10, 2.11, 2.12, 2.13).
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
  // and lift it onto the page. `overflow-visible` lets the tooltips spill
  // outside the rounded hub.
  panel.className = joinClasses(
    "acx-radial pointer-events-auto relative box-border rounded-full overflow-visible",
  );
  panel.style.width = `${PANEL_DIAMETER}px`;
  panel.style.height = `${PANEL_DIAMETER}px`;
  panel.appendChild(buildPanelStyles());

  const center = PANEL_DIAMETER / 2;
  const count = tools.length;

  // Center hint label so the empty hub doesn't read as a dead zone. Decorative
  // (the tools carry the accessible names), so hidden from assistive tech.
  const hint = document.createElement("div");
  hint.setAttribute("aria-hidden", "true");
  hint.textContent = "Alpha Cursor";
  hint.className = joinClasses(
    "acx-hint absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
    "font-sans text-caption font-semibold tracking-wide select-none pointer-events-none",
  );
  panel.appendChild(hint);

  tools.forEach((tool, index) => {
    const invocation: ToolInvocation = { context, point };

    // Large circular line-icon button (Wise reference proportions). Built with
    // the shared `.acx-tool` class (defined in buildPanelStyles) so it carries
    // the white→green icon hover treatment and a large 56px hit area (Req 2.12).
    const button = document.createElement("button");
    button.type = "button";
    button.className = "acx-tool";
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-label", tool.label);
    button.style.position = "absolute";
    button.style.width = `${BUTTON_SIZE}px`;
    button.style.height = `${BUTTON_SIZE}px`;
    // Stagger each tool's entrance slightly for a friendly fan-in.
    button.style.animationDelay = `${40 + index * 22}ms`;

    button.appendChild(createToolIcon(tool.id, ICON_SIZE));

    button.addEventListener("click", () => {
      // Select → close, then invoke the tool (Req 2.10).
      closePanel();
      void Promise.resolve(tool.run(invocation)).catch(() => {
        /* tool handlers surface their own failures via notify() */
      });
    });

    // Evenly distribute around the ring, starting at the top (−90°).
    const angle = count === 0 ? 0 : (index / count) * Math.PI * 2 - Math.PI / 2;
    const cx = center + Math.cos(angle) * RING_RADIUS;
    const cy = center + Math.sin(angle) * RING_RADIUS;
    button.style.left = `${cx - BUTTON_SIZE / 2}px`;
    button.style.top = `${cy - BUTTON_SIZE / 2}px`;

    // Tooltip with the tool's full name placed BESIDE the icon (Req 2.13) —
    // to the right for buttons on the right half, to the left for the left half
    // — vertically centered on the button so it never sits on top of the icon.
    // Shown on hover AND keyboard focus / hidden on leave AND blur.
    const tooltip = buildTooltip(tool.label);
    const onRightHalf = cx >= center;
    tooltip.style.top = `${cy}px`;
    if (onRightHalf) {
      tooltip.style.left = `${cx + BUTTON_SIZE / 2 + TOOLTIP_GAP}px`;
      tooltip.style.transform = "translateY(-50%)";
    } else {
      tooltip.style.left = `${cx - BUTTON_SIZE / 2 - TOOLTIP_GAP}px`;
      tooltip.style.transform = "translate(-100%, -50%)";
    }

    const reveal = (): void => showTooltip(tooltip);
    const conceal = (): void => hideTooltip(tooltip);
    button.addEventListener("mouseenter", reveal);
    button.addEventListener("focus", reveal);
    button.addEventListener("mouseleave", conceal);
    button.addEventListener("blur", conceal);

    panel.appendChild(button);
    panel.appendChild(tooltip);
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
    const point = { x: event.clientX, y: event.clientY };
    // Dispatch to the user's chosen panel style (console is the default).
    if (getCachedPanelStyle() === "radial") {
      openPanel(context, point);
    } else {
      openConsolePanel(context, point);
    }
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
    closeConsolePanel();
  };
}
