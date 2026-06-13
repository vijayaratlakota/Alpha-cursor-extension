/**
 * Alpha Cursor — Tool 12 "Tab Shifter" content wiring (task 21.1, Req 17).
 *
 * Registers the {@link ToolId.TAB_SHIFTER} handler in the content-script tool
 * catalog. The tool is only ever shown for the `generic-page` context (see
 * `src/content/tools.ts`), so when invoked it:
 *
 *   1. Asks the background worker for the current window's tabs via the
 *      `TABS_LIST_LIGHT` message (the background owns `chrome.tabs.*`). Each tab
 *      is projected to `{ id, title, favIconUrl }` (Req 17.2, 17.3).
 *   2. Renders a radial panel AROUND the cursor inside a CLOSED Shadow DOM
 *      anchored at the invocation point, with one circular button per open tab
 *      arranged evenly on a ring (Req 17.2) — mirroring the Options_Panel ring.
 *   3. Each button shows the tab's favicon and title; a missing/blank favicon
 *      falls back to a Notion-styled placeholder (a neutral circle bearing the
 *      first letter of the title) (Req 17.3, 17.5).
 *   4. Clicking a tab sends `TAB_ACTIVATE { tabId }` so the background activates
 *      it, then closes the panel (Req 17.4).
 *   5. Escape closes the panel WITHOUT switching tabs (Req 17.6); an
 *      outside-click likewise dismisses it without switching.
 *
 * The privileged tab enumeration/activation lives in
 * `src/background/tabShifterHandlers.ts`; this module is purely the content-side
 * UI + messaging front end. Styling uses the shared Notion tokens via the
 * closed-shadow stylesheet so host-page CSS cannot bleed in (Req 2.11, 20.1).
 */

import { createShadowHost, type ShadowHostHandle } from "../../ui/shadowHost";
import { joinClasses } from "../../ui/primitives/classNames";
import { notify } from "../../ui/notify";
import { createMessage, isOk, type Response } from "../../shared/messaging";
import {
  registerTool,
  ToolId,
  type ToolInvocation,
} from "../../content/tools";
import {
  TabShifterMessageType,
  type LightTab,
  type TabActivatePayload,
  type TabActivateResult,
} from "../../background/tabShifterHandlers";

/** Diameter (CSS px) of the radial tab panel — matches the Options_Panel hub. */
const PANEL_DIAMETER = 280;
/** Radius of the ring the tab buttons sit on. */
const RING_RADIUS = 104;
/** Diameter of each circular tab button. */
const BUTTON_SIZE = 44;

/** Module-level handle to the currently open tab-shifter panel, if any. */
let activePanel: ShadowHostHandle | null = null;

/**
 * Send a typed message to the background router and resolve with its
 * `Response<R>`. Wraps `chrome.runtime.sendMessage` in a promise and normalizes
 * a missing/duplicate response into an error branch so callers always get a
 * discriminated `Response`.
 */
function sendToBackground<T, R>(type: string, payload: T): Promise<Response<R>> {
  return new Promise<Response<R>>((resolve) => {
    try {
      chrome.runtime.sendMessage(
        createMessage(type, payload),
        (response: Response<R>) => {
          const lastError = chrome.runtime?.lastError;
          if (lastError || !response) {
            resolve({
              ok: false,
              error: {
                code: "UNKNOWN",
                message: lastError?.message ?? "No response from background.",
                recoverable: true,
              },
            });
            return;
          }
          resolve(response);
        },
      );
    } catch (cause) {
      resolve({
        ok: false,
        error: {
          code: "UNKNOWN",
          message: cause instanceof Error ? cause.message : String(cause),
          recoverable: true,
        },
      });
    }
  });
}

/** Close the tab-shifter panel if open. Idempotent (Req 17.6). */
function closePanel(): void {
  if (activePanel) {
    activePanel.destroy();
    activePanel = null;
  }
}

/** Returns `true` while the tab-shifter panel is open. */
export function isTabShifterOpen(): boolean {
  return activePanel !== null && !activePanel.destroyed;
}

/**
 * Derive the single-letter glyph for a favicon placeholder from a tab title.
 * Falls back to a bullet when the title has no usable leading character so the
 * placeholder is never blank (Req 17.5).
 */
function placeholderGlyph(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) return "•";
  return trimmed.charAt(0).toUpperCase();
}

/**
 * Build the favicon visual for a tab: an `<img>` of the favicon when one is
 * available, otherwise a Notion-styled placeholder circle bearing the title's
 * first letter (Req 17.3, 17.5). If the favicon image fails to load at runtime
 * it is swapped for the same placeholder so a broken URL never shows a missing
 * image.
 */
function buildFavicon(tab: LightTab): HTMLElement {
  const makePlaceholder = (): HTMLElement => {
    const placeholder = document.createElement("span");
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.className = joinClasses(
      "inline-flex items-center justify-center size-5 rounded-full",
      "bg-fill-subtle text-ink-muted text-eyebrow font-sans font-semibold",
    );
    placeholder.textContent = placeholderGlyph(tab.title);
    return placeholder;
  };

  if (tab.favIconUrl) {
    const img = document.createElement("img");
    img.src = tab.favIconUrl;
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    img.className = "size-5 rounded-sm object-contain";
    // Swap to the placeholder if the favicon fails to load (Req 17.5).
    img.addEventListener("error", () => {
      img.replaceWith(makePlaceholder());
    });
    return img;
  }

  return makePlaceholder();
}

/** Activate a tab via the background worker, then close the panel (Req 17.4). */
async function activateTab(tabId: number): Promise<void> {
  const response = await sendToBackground<TabActivatePayload, TabActivateResult>(
    TabShifterMessageType.ACTIVATE,
    { tabId },
  );
  if (!isOk(response) || response.data.activated !== true) {
    const message = isOk(response)
      ? "That tab could not be activated."
      : response.error.message;
    notify({ kind: "error", text: message });
  }
}

/**
 * Build a single circular tab button: the favicon (or placeholder) with the
 * tab's title as both the accessible label and a native tooltip (Req 17.3).
 * Clicking it activates the tab and closes the panel (Req 17.4).
 */
function buildTabButton(tab: LightTab): HTMLElement {
  const label = tab.title.trim() === "" ? "Untitled tab" : tab.title;

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.setAttribute("aria-label", label);
  button.title = label;
  button.className = joinClasses(
    "absolute inline-flex items-center justify-center",
    "bg-surface border border-hairline rounded-full shadow-soft cursor-pointer",
    "hover:bg-fill-hover focus-visible:outline-2",
    "focus-visible:outline-offset-2 focus-visible:outline-primary",
    "motion-safe:transition-transform motion-safe:duration-150 motion-safe:active:scale-90",
  );
  button.style.width = `${BUTTON_SIZE}px`;
  button.style.height = `${BUTTON_SIZE}px`;
  button.style.padding = "0";

  button.appendChild(buildFavicon(tab));

  button.addEventListener("click", () => {
    closePanel();
    void activateTab(tab.id);
  });

  return button;
}

/**
 * Build the radial panel element: an elevated Notion surface with one circular
 * tab button distributed evenly around a ring (Req 17.2). With no tabs to show
 * a quiet "No tabs" label is centered instead.
 */
function buildPanel(tabs: LightTab[]): HTMLElement {
  const panel = document.createElement("div");
  panel.setAttribute("role", "menu");
  panel.setAttribute("aria-label", "Switch tab");
  panel.className = joinClasses(
    "pointer-events-auto relative box-border rounded-full",
    "bg-surface border border-hairline acx-elevated",
  );
  panel.style.width = `${PANEL_DIAMETER}px`;
  panel.style.height = `${PANEL_DIAMETER}px`;

  const center = PANEL_DIAMETER / 2;

  if (tabs.length === 0) {
    const empty = document.createElement("span");
    empty.className = joinClasses(
      "absolute -translate-x-1/2 -translate-y-1/2",
      "text-ink-muted text-body-sm font-sans",
    );
    empty.style.left = `${center}px`;
    empty.style.top = `${center}px`;
    empty.textContent = "No tabs";
    panel.appendChild(empty);
    return panel;
  }

  const count = tabs.length;
  tabs.forEach((tab, index) => {
    const button = buildTabButton(tab);
    // Evenly distribute around the ring, starting at the top (−90°).
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    const cx = center + Math.cos(angle) * RING_RADIUS;
    const cy = center + Math.sin(angle) * RING_RADIUS;
    button.style.left = `${cx - BUTTON_SIZE / 2}px`;
    button.style.top = `${cy - BUTTON_SIZE / 2}px`;
    panel.appendChild(button);
  });

  return panel;
}

/**
 * Open the radial tab-shifter panel anchored at `point`. Closes any panel
 * already open, mounts the tab ring inside a closed shadow host, and wires
 * Escape + outside-click to dismiss WITHOUT switching tabs (Req 17.6).
 */
function openPanel(tabs: LightTab[], point: { x: number; y: number }): void {
  closePanel();

  const handle = createShadowHost({
    overlay: "anchored",
    point,
    surfaceId: "tab-shifter",
  });
  activePanel = handle;
  handle.mount(buildPanel(tabs));

  // Escape closes without switching (Req 17.6). Capture phase so it wins over
  // page handlers.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  handle.onDestroy(() => window.removeEventListener("keydown", onKeyDown, true));

  // Outside-click closes (without switching). Deferred one tick so the click
  // that opened the panel is not treated as an outside dismissal.
  const onPointerDown = (event: MouseEvent): void => {
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];
    if (!path.includes(handle.host)) {
      closePanel();
    }
  };
  setTimeout(() => {
    window.addEventListener("mousedown", onPointerDown, true);
    handle.onDestroy(() =>
      window.removeEventListener("mousedown", onPointerDown, true),
    );
  }, 0);
}

/**
 * The {@link ToolId.TAB_SHIFTER} run handler. Requests the current window's
 * tabs from the background (Req 17.2, 17.3) and opens the radial panel near the
 * cursor. A failed enumeration surfaces a notification and opens no panel.
 */
async function runTabShifter(invocation: ToolInvocation): Promise<void> {
  const response = await sendToBackground<void, LightTab[]>(
    TabShifterMessageType.LIST_LIGHT,
    undefined,
  );
  if (!isOk(response)) {
    notify({
      kind: "error",
      text: response.error.message,
      code: response.error.code,
    });
    return;
  }
  openPanel(response.data, invocation.point);
}

/**
 * Install the real "Tab shifter" behavior into the tool catalog, replacing the
 * placeholder stub. Wired by the content-script orchestrator (not edited here).
 *
 * @returns `true` if the tool was registered (always, unless the catalog id
 * changes).
 */
export function registerTabShifterTool(): boolean {
  return registerTool(ToolId.TAB_SHIFTER, runTabShifter);
}
