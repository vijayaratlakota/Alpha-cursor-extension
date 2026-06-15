/**
 * Alpha Cursor — arcade "video console" Options_Panel (alternative to the
 * radial panel).
 *
 * Renders the context-aware tool set as a retro gaming-console: a framed CRT
 * "screen" at the top that displays the currently focused tool's name (and, for
 * list tools like Tab Shifter / Open saved tabs, an interactive list rendered
 * INSIDE the screen), with a grid of circular feature buttons below. The whole
 * surface uses the SAME borders, colors and shadows as the popup console
 * (`.acx-arcade-console` / `.acx-arcade-screen`) so the two read identically.
 *
 * Interaction (Req 2.7–2.14):
 *   - Hover/focus a feature button → its full name shows on the screen.
 *   - Click, or keyboard Up/Down/Left/Right + Enter, activates the tool.
 *   - Escape closes the panel.
 *   - Tab Shifter and "Open saved tabs" render their items inside the screen;
 *     Up/Down + Enter (or click) select an item; Escape returns to the buttons.
 *
 * The panel mounts in a CLOSED Shadow DOM (via {@link createShadowHost}) so
 * host-page CSS cannot bleed in. It is fixed to the brand colors regardless of
 * the page theme, matching the console aesthetic.
 */

import { createShadowHost, type ShadowHostHandle } from "../ui/shadowHost";
import { joinClasses } from "../ui/primitives/classNames";
import { createToolIcon } from "../ui/icons";
import { resolveToolSet, ToolId, type Tool, type ToolInvocation } from "./tools";
import type { ContextType } from "./context";
import {
  createMessage,
  isOk,
  type Response,
} from "../shared/messaging";

/** A viewport-relative point in CSS pixels. */
interface Point {
  x: number;
  y: number;
}

/** Width of the console panel (CSS px). */
const PANEL_WIDTH = 340;

/** Module-level handle to the currently open console panel, if any. */
let activeHandle: ShadowHostHandle | null = null;

/** Close the console panel if open. Idempotent. */
export function closeConsolePanel(): void {
  if (activeHandle) {
    activeHandle.destroy();
    activeHandle = null;
  }
}

/** Returns `true` while a console panel is open. */
export function isConsolePanelOpen(): boolean {
  return activeHandle !== null && !activeHandle.destroyed;
}

// ---------------------------------------------------------------------------
// Background messaging (saved tabs + tab shifter lists rendered in-screen)
// ---------------------------------------------------------------------------

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

interface LightTab {
  id: number;
  title: string;
  favIconUrl?: string;
}

interface TabFolderSummary {
  id: string;
  name: string;
  count: number;
  savedAt: number;
}

// ---------------------------------------------------------------------------
// Styles — reuse the popup console look (same borders/colors/shadows)
// ---------------------------------------------------------------------------

function buildPanelStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `
    .acx-console {
      box-sizing: border-box;
      background: #ffffff;
      color: #0a0118;
      border: 4px solid #0a0118;
      border-radius: 22px;
      padding: 14px;
      box-shadow: #0a0118 6px 6px 0px 0px;
      font-family: var(--acx-font-sans, "VT323", monospace);
      max-height: calc(100vh - 24px);
      overflow-y: auto;
    }
    .acx-console-screen {
      box-sizing: border-box;
      background: #bff0d0;
      color: #1a2e22;
      border: 4px solid #0a0118;
      border-radius: 12px;
      min-height: 92px;
      padding: 10px 12px;
      margin-bottom: 12px;
      background-image: repeating-linear-gradient(
        to bottom,
        rgba(10, 1, 24, 0.12) 0px,
        rgba(10, 1, 24, 0.12) 1px,
        transparent 1px,
        transparent 3px
      );
    }
    .acx-console-title {
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      min-height: 72px;
      font-size: 24px;
      line-height: 1.2;
      letter-spacing: 0.5px;
    }
    .acx-console-hint {
      font-size: 14px;
      text-align: center;
      color: #4a6357;
      margin-top: 4px;
    }
    .acx-console-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 8px;
    }
    .acx-console-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      width: 100%;
      aspect-ratio: 1 / 1;
      border: 3px solid #0a0118;
      background: #ffffff;
      color: #0a0118;
      cursor: pointer;
      border-radius: 9999px;
      padding: 0;
      outline: none;
      box-shadow: #0a0118 3px 3px 0px 0px;
      transition: box-shadow 80ms steps(2, end), transform 80ms steps(2, end);
    }
    .acx-console-btn:hover {
      transform: translate(1px, 1px);
    }
    /* Active (keyboard/selected) button: a tight inset ring inside the button
     * (no outer circle around it). The colored fill + dark border still read. */
    .acx-console-btn.acx-active {
      transform: translate(1px, 1px);
      box-shadow: #0a0118 3px 3px 0px 0px, inset 0 0 0 3px #ffffff;
    }
    .acx-console-btn:active {
      box-shadow: 0 0 0 0 #0a0118;
      transform: translate(3px, 3px);
    }
    /* In-screen list (tab shifter / saved tabs) */
    .acx-console-list {
      list-style: none;
      margin: 0;
      padding: 2px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 260px;
      overflow-y: auto;
      overflow-x: hidden;
    }
    /* Visible, comfortable scrollbar so it's clear the list scrolls. */
    .acx-console-list::-webkit-scrollbar { width: 10px; }
    .acx-console-list::-webkit-scrollbar-track {
      background: rgba(10, 1, 24, 0.08);
      border-radius: 6px;
    }
    .acx-console-list::-webkit-scrollbar-thumb {
      background: #0a0118;
      border-radius: 6px;
      border: 2px solid #bff0d0;
    }
    .acx-console-row {
      display: flex;
      align-items: center;
      gap: 10px;
      box-sizing: border-box;
      width: 100%;
      padding: 8px 10px;
      border: 2px solid #0a0118;
      border-radius: 8px;
      /* SOLID white fill so the CRT scanlines never bleed through the text. */
      background: #ffffff;
      color: #0a0118;
      font-size: 16px;
      line-height: 1.25;
      cursor: pointer;
      box-shadow: #0a0118 2px 2px 0px 0px;
    }
    .acx-console-row.acx-active {
      background: #9747ff;
      color: #ffffff;
      border-color: #0a0118;
    }
    /* Favicon sits in its own clearly bordered square so it never collides
     * with the title text. */
    .acx-console-row img,
    .acx-console-row .acx-fav {
      width: 22px;
      height: 22px;
      flex: 0 0 22px;
      border-radius: 4px;
      object-fit: contain;
      background: #ffffff;
      border: 1px solid #0a0118;
      padding: 1px;
      box-sizing: border-box;
    }
    .acx-console-row .acx-rowtext {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .acx-console-empty {
      text-align: center;
      color: #4a6357;
      font-size: 16px;
      padding: 16px 0;
    }
    @media (prefers-reduced-motion: no-preference) {
      .acx-console { animation: acx-console-in 150ms steps(3, end) both; }
    }
    @keyframes acx-console-in {
      from { opacity: 0; transform: translate(-4px, -4px); }
      to   { opacity: 1; transform: translate(0, 0); }
    }

    /* ── DARK MODE ──────────────────────────────────────────────────────
     * When the user picks Dark, the shadow host carries data-acx-theme="dark".
     * The console body becomes warm charcoal, the screen a phosphor-green
     * terminal, borders use a refined hairline (not harsh white). Button fill
     * colors are intentionally left unchanged. */
    :host([data-acx-theme="dark"]) .acx-console {
      background: #20252f;
      color: #f4f6fa;
      border-color: #5a6473;
      box-shadow: rgba(0, 0, 0, 0.6) 6px 6px 0px 0px;
    }
    :host([data-acx-theme="dark"]) .acx-console-screen {
      background: #0a140d;
      color: #7cffb0;
      border-color: #5a6473;
      background-image: repeating-linear-gradient(
        to bottom,
        rgba(124, 255, 176, 0.07) 0px,
        rgba(124, 255, 176, 0.07) 1px,
        transparent 1px,
        transparent 3px
      );
    }
    :host([data-acx-theme="dark"]) .acx-console-title { color: #7cffb0; }
    :host([data-acx-theme="dark"]) .acx-console-hint { color: #5fbf85; }
    :host([data-acx-theme="dark"]) .acx-console-btn {
      border-color: #5a6473;
      box-shadow: rgba(0, 0, 0, 0.55) 3px 3px 0px 0px;
    }
    :host([data-acx-theme="dark"]) .acx-console-btn.acx-active {
      box-shadow: rgba(0, 0, 0, 0.55) 3px 3px 0px 0px, inset 0 0 0 3px #ffffff;
    }
    :host([data-acx-theme="dark"]) .acx-console-list::-webkit-scrollbar-track {
      background: rgba(124, 255, 176, 0.12);
    }
    :host([data-acx-theme="dark"]) .acx-console-list::-webkit-scrollbar-thumb {
      background: #5a6473;
      border-color: #0a140d;
    }
    :host([data-acx-theme="dark"]) .acx-console-row {
      background: #29303c;
      color: #f4f6fa;
      border-color: #5a6473;
      box-shadow: rgba(0, 0, 0, 0.5) 2px 2px 0px 0px;
    }
    :host([data-acx-theme="dark"]) .acx-console-row.acx-active {
      background: #9747ff;
      color: #ffffff;
      border-color: #c4a5ff;
    }
    :host([data-acx-theme="dark"]) .acx-console-row img,
    :host([data-acx-theme="dark"]) .acx-console-row .acx-fav {
      background: #ffffff;
      border-color: #5a6473;
    }
    :host([data-acx-theme="dark"]) .acx-console-empty { color: #5fbf85; }
  `;
  return style;
}

// ---------------------------------------------------------------------------
// Panel builder
// ---------------------------------------------------------------------------

/** Tools whose action is presented as an interactive list inside the screen. */
const LIST_TOOLS = new Set<string>([ToolId.TAB_SHIFTER, ToolId.RESTORE_TABS]);

/**
 * Rotating fill/icon colors for the console feature buttons so they read as
 * distinct arcade keys (instead of all white). Cycled by button index. Each
 * fill is paired with a legible icon color (dark ink on light/yellow/green
 * fills, white on the bold purple/red).
 */
const BUTTON_COLORS: { bg: string; fg: string }[] = [
  { bg: "#9747ff", fg: "#ffffff" }, // purple
  { bg: "#ff5555", fg: "#ffffff" }, // red
  { bg: "#fbd613", fg: "#0a0118" }, // yellow
  { bg: "#1fc11b", fg: "#0a0118" }, // green
];

function buildPanel(
  tools: Tool[],
  context: ContextType,
  point: Point,
  state: { inListMode: boolean },
): HTMLElement {
  const panel = document.createElement("div");
  panel.setAttribute("role", "menu");
  panel.setAttribute("aria-label", "Alpha Cursor options");
  panel.className = "acx-console pointer-events-auto";
  panel.style.width = `${PANEL_WIDTH}px`;
  panel.appendChild(buildPanelStyles());

  // ── Screen ──────────────────────────────────────────────────────────
  const screen = document.createElement("div");
  screen.className = "acx-console-screen";

  const titleEl = document.createElement("div");
  titleEl.className = "acx-console-title";
  titleEl.textContent = "Alpha Cursor";

  const hintEl = document.createElement("div");
  hintEl.className = "acx-console-hint";
  hintEl.textContent = "Hover or use ↑ ↓ • Enter to select";

  screen.append(titleEl, hintEl);
  panel.appendChild(screen);

  // ── Button grid ─────────────────────────────────────────────────────
  const grid = document.createElement("div");
  grid.className = "acx-console-grid";
  panel.appendChild(grid);

  const buttons: HTMLButtonElement[] = [];
  let activeIndex = 0;

  /** Default screen content: the focused tool's name (or the brand title). */
  const showToolName = (label: string | null): void => {
    titleEl.textContent = label ?? "Alpha Cursor";
    hintEl.style.display = "";
    hintEl.textContent = "Hover or use ↑ ↓ • Enter to select";
  };

  const setActive = (index: number, focus = true): void => {
    if (index < 0 || index >= buttons.length) return;
    activeIndex = index;
    buttons.forEach((b, i) => b.classList.toggle("acx-active", i === index));
    const tool = tools[index];
    showToolName(tool ? tool.label : null);
    if (focus) buttons[index]?.focus();
  };

  const invocation: ToolInvocation = { context, point };

  const activateTool = (tool: Tool): void => {
    if (LIST_TOOLS.has(tool.id)) {
      void openListMode(tool);
      return;
    }
    closeConsolePanel();
    void Promise.resolve(tool.run(invocation)).catch(() => {
      /* tool handlers surface their own failures via notify() */
    });
  };

  tools.forEach((tool, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "acx-console-btn";
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-label", tool.label);
    button.title = tool.label;
    // Rotate through the brand palette so each button reads as a distinct
    // arcade key. Each fill is paired with a legible icon color.
    const swatch = BUTTON_COLORS[index % BUTTON_COLORS.length];
    button.style.background = swatch.bg;
    button.style.color = swatch.fg;
    button.appendChild(createToolIcon(tool.id, 20));

    button.addEventListener("mouseenter", () => setActive(index, false));
    button.addEventListener("focus", () => setActive(index, false));
    button.addEventListener("click", () => activateTool(tool));

    buttons.push(button);
    grid.appendChild(button);
  });

  // ── In-screen list mode (Tab Shifter / Open saved tabs) ──────────────

  /** Render an interactive list inside the screen and wire keyboard nav. */
  async function openListMode(tool: Tool): Promise<void> {
    grid.style.display = "none";
    state.inListMode = true;
    titleEl.textContent = tool.label;
    hintEl.textContent = "Loading…";

    const items: { label: string; favIconUrl?: string; onSelect: () => void }[] = [];

    if (tool.id === ToolId.TAB_SHIFTER) {
      const response = await sendToBackground<undefined, LightTab[]>(
        "TABS_LIST_LIGHT",
        undefined,
      );
      if (isOk(response)) {
        for (const tab of response.data) {
          items.push({
            label: tab.title.trim() || "Untitled tab",
            favIconUrl: tab.favIconUrl,
            onSelect: () => {
              closeConsolePanel();
              void sendToBackground("TAB_ACTIVATE", { tabId: tab.id });
            },
          });
        }
      }
    } else if (tool.id === ToolId.RESTORE_TABS) {
      const response = await sendToBackground<undefined, TabFolderSummary[]>(
        "TABS_LIST",
        undefined,
      );
      if (isOk(response)) {
        for (const folder of response.data) {
          items.push({
            label: `${folder.name} (${folder.count})`,
            onSelect: () => {
              closeConsolePanel();
              void sendToBackground("TABS_RESTORE", { folderId: folder.id });
            },
          });
        }
      }
    }

    renderList(tool.label, items);
  }

  function renderList(
    label: string,
    items: { label: string; favIconUrl?: string; onSelect: () => void }[],
  ): void {
    titleEl.textContent = label;

    // Clear any previous list (keep title + hint).
    screen.querySelector(".acx-console-list")?.remove();
    screen.querySelector(".acx-console-empty")?.remove();

    if (items.length === 0) {
      hintEl.textContent = "Esc to go back";
      const empty = document.createElement("div");
      empty.className = "acx-console-empty";
      empty.textContent = "Nothing here yet.";
      screen.appendChild(empty);
      // Allow Escape to return to the button grid.
      listKeyHandler = (event: KeyboardEvent): boolean => {
        if (event.key === "Escape") {
          listKeyHandler = null;
          state.inListMode = false;
          empty.remove();
          grid.style.display = "";
          showToolName(tools[activeIndex]?.label ?? null);
          setActive(activeIndex);
          return true;
        }
        return false;
      };
      return;
    }

    hintEl.textContent = "↑ ↓ • Enter to open • Esc to go back";

    const list = document.createElement("ul");
    list.className = "acx-console-list";
    const rows: HTMLLIElement[] = [];
    let listIndex = 0;

    const setListActive = (index: number): void => {
      if (index < 0 || index >= rows.length) return;
      listIndex = index;
      rows.forEach((r, i) => r.classList.toggle("acx-active", i === index));
      rows[index]?.scrollIntoView({ block: "nearest" });
    };

    items.forEach((item, index) => {
      const row = document.createElement("li");
      row.className = "acx-console-row";
      row.setAttribute("role", "menuitem");

      // A favicon box is ALWAYS present so titles align in a clean column. When
      // a favicon URL exists we show it; otherwise (or on load error) a labelled
      // placeholder bearing the title's first letter keeps the row tidy.
      const makePlaceholder = (): HTMLElement => {
        const ph = document.createElement("span");
        ph.className = "acx-fav";
        ph.setAttribute("aria-hidden", "true");
        ph.style.display = "inline-flex";
        ph.style.alignItems = "center";
        ph.style.justifyContent = "center";
        ph.style.fontSize = "13px";
        ph.style.fontWeight = "600";
        ph.textContent = (item.label.trim().charAt(0) || "•").toUpperCase();
        return ph;
      };

      if (item.favIconUrl) {
        const img = document.createElement("img");
        img.src = item.favIconUrl;
        img.alt = "";
        img.addEventListener("error", () => img.replaceWith(makePlaceholder()));
        row.appendChild(img);
      } else {
        row.appendChild(makePlaceholder());
      }
      const text = document.createElement("span");
      text.className = "acx-rowtext";
      text.textContent = item.label;
      row.appendChild(text);

      row.addEventListener("mouseenter", () => setListActive(index));
      row.addEventListener("click", () => item.onSelect());
      rows.push(row);
      list.appendChild(row);
    });

    screen.appendChild(list);
    setListActive(0);

    // List-mode keyboard handler (added on top of the panel-level handler).
    listKeyHandler = (event: KeyboardEvent): boolean => {
      if (event.key === "ArrowDown") {
        setListActive(Math.min(listIndex + 1, rows.length - 1));
        return true;
      }
      if (event.key === "ArrowUp") {
        setListActive(Math.max(listIndex - 1, 0));
        return true;
      }
      if (event.key === "Enter") {
        items[listIndex]?.onSelect();
        return true;
      }
      if (event.key === "Escape") {
        // Leave list mode, restore the button grid.
        listKeyHandler = null;
        state.inListMode = false;
        list.remove();
        grid.style.display = "";
        showToolName(tools[activeIndex]?.label ?? null);
        setActive(activeIndex);
        return true;
      }
      return false;
    };
  }

  // ── Keyboard navigation over the button grid ─────────────────────────
  let listKeyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  const COLS = 5;

  panel.addEventListener("keydown", (event) => {
    // List mode takes precedence when active.
    if (listKeyHandler) {
      if (listKeyHandler(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const last = buttons.length - 1;
    switch (event.key) {
      case "ArrowRight":
        setActive(Math.min(activeIndex + 1, last));
        break;
      case "ArrowLeft":
        setActive(Math.max(activeIndex - 1, 0));
        break;
      case "ArrowDown":
        setActive(Math.min(activeIndex + COLS, last));
        break;
      case "ArrowUp":
        setActive(Math.max(activeIndex - COLS, 0));
        break;
      case "Enter":
      case " ": {
        const tool = tools[activeIndex];
        if (tool) activateTool(tool);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  });

  // Seed initial active button after mount (focus happens in openConsolePanel).
  queueMicrotask(() => setActive(0, false));

  return panel;
}

/**
 * Open the arcade console Options_Panel for a resolved context at a viewport
 * point. Mirrors the radial panel's open/close/escape/outside-click contract.
 */
export function openConsolePanel(context: ContextType, point: Point): void {
  closeConsolePanel();

  const handle = createShadowHost({
    overlay: "anchored",
    point,
    surfaceId: "console-panel",
  });
  activeHandle = handle;

  const tools = resolveToolSet(context);
  const state = { inListMode: false };
  const panel = buildPanel(tools, context, point, state);
  handle.mount(panel);

  // Focus the panel so keyboard navigation works immediately.
  queueMicrotask(() => {
    const first = handle.root.querySelector<HTMLButtonElement>(".acx-console-btn");
    first?.focus();
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      // In list mode, Escape is handled by the panel's own keydown listener
      // (returns to the button grid); only close the whole panel otherwise.
      if (state.inListMode) return;
      event.preventDefault();
      event.stopPropagation();
      closeConsolePanel();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  handle.onDestroy(() => window.removeEventListener("keydown", onKeyDown, true));

  const onPointerDown = (event: MouseEvent): void => {
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];
    if (!path.includes(handle.host)) {
      closeConsolePanel();
    }
  };
  setTimeout(() => {
    window.addEventListener("mousedown", onPointerDown, true);
    handle.onDestroy(() =>
      window.removeEventListener("mousedown", onPointerDown, true),
    );
  }, 0);
}
