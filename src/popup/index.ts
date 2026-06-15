/**
 * Alpha Cursor — Popup surface (task 24.1).
 *
 * The toolbar popup is the primary home of the global ON/OFF Toggle (Req 1.1),
 * a compact Notepad view with a "Copy All" action (Req 6.1), and an entry point
 * to the full Options page (Req 19.1). It renders in the extension's main
 * document (not a content-script Shadow DOM), so the compiled Tailwind v4 + Notion
 * token stylesheet is imported directly below so `@tailwindcss/vite` includes it
 * for this HTML entry and the utility classes apply (Req 20.1).
 *
 * Data flow:
 *   - Toggle: reads `getEnabled()` on open, writes via `setEnabled()` on change,
 *     and reflects external changes (other tabs / options page) via
 *     `onEnabledChanged()` — all of which run fine in this extension-page context
 *     where `chrome.storage` is available.
 *   - Notepad: the popup messages the background router (`chrome.runtime.sendMessage`)
 *     for `NOTEPAD_LIST` (to render entries) and `NOTEPAD_COPY_ALL` (to get the
 *     joined string), then performs the actual `navigator.clipboard.writeText`
 *     here under the popup's user gesture (Req 6.2–6.5).
 *
 * Accessibility / motion (Req 20): the Toggle is a `role="switch"` control with
 * `aria-checked`, a visible focus-visible ring, and a `motion-safe:`-gated knob
 * transition so `prefers-reduced-motion` is honored (Req 20.5, 20.6). Copy All
 * feedback is announced through an `aria-live` status region.
 */

// Pull the compiled Tailwind + Notion-token stylesheet into the popup page so
// the utility classes used below resolve. (Content-script surfaces inject this
// into their Shadow DOM instead; the popup is a normal document.)
import "../ui/styles/tailwind.css";

import { createButton } from "../ui/primitives/button";
import { joinClasses } from "../ui/primitives/classNames";
import { applyThemeToDocument } from "../ui/applyTheme";
import {
  getEnabled,
  getCachedEnabled,
  setEnabled,
  onEnabledChanged,
} from "../shared/settings";
import {
  NotepadMessageType,
  type ClearNotepadResult,
  type NotepadCopyAllResult,
  type NotepadEntry,
} from "../tools/notepad/notepad";
import {
  createMessage,
  isOk,
  type Message,
  type Response,
} from "../shared/messaging";

// ---------------------------------------------------------------------------
// Background messaging helper
// ---------------------------------------------------------------------------

/**
 * Send a typed message to the background router and await its `Response`,
 * normalizing a missing channel / `lastError` into an error `Response` so the
 * popup never throws at the boundary.
 */
function sendToBackground<T, R>(
  type: NotepadMessageType,
  payload: T,
): Promise<Response<R>> {
  const message: Message<T> = createMessage(type, payload);
  return new Promise<Response<R>>((resolve) => {
    try {
      const maybePromise = chrome.runtime.sendMessage(message) as
        | Promise<Response<R>>
        | undefined;
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(
          (response) => resolve(normalizeResponse(response)),
          () => resolve(errorResponse("No response from background")),
        );
        return;
      }
    } catch {
      resolve(errorResponse("Messaging unavailable"));
      return;
    }
    resolve(errorResponse("No response from background"));
  });
}

function errorResponse<R>(message: string): Response<R> {
  return {
    ok: false,
    error: { code: "UNKNOWN", message, recoverable: true },
  };
}

function normalizeResponse<R>(response: Response<R> | undefined): Response<R> {
  if (response && typeof response === "object" && "ok" in response) {
    return response;
  }
  return errorResponse("Malformed background response");
}

// ---------------------------------------------------------------------------
// Status (aria-live) region
// ---------------------------------------------------------------------------

/** A small status line used to announce Copy All outcomes (Req 6.3–6.5). */
function createStatusRegion(): {
  el: HTMLElement;
  show(text: string, kind?: "info" | "success" | "error"): void;
} {
  const el = document.createElement("p");
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.className = joinClasses(
    "m-0 min-h-[1.43em] text-caption font-sans",
    "text-ink-muted",
  );

  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  const show = (text: string, kind: "info" | "success" | "error" = "info"): void => {
    if (clearTimer !== undefined) clearTimeout(clearTimer);
    el.textContent = text;
    el.className = joinClasses(
      "m-0 min-h-[1.43em] text-caption font-sans",
      kind === "error" ? "text-accent-orange-deep" : "text-ink-muted",
    );
    if (text) {
      clearTimer = setTimeout(() => {
        el.textContent = "";
      }, 4000);
    }
  };

  return { el, show };
}

// ---------------------------------------------------------------------------
// Global Toggle (role="switch") — Req 1.1
// ---------------------------------------------------------------------------

interface ToggleHandle {
  /** The row element to mount. */
  el: HTMLElement;
  /** Reflect an externally-changed state without firing the change handler. */
  setState(enabled: boolean): void;
}

/**
 * Build the global ON/OFF Toggle as an accessible two-state switch
 * (`role="switch"` + `aria-checked`). Clicking or pressing Space/Enter flips the
 * state and invokes `onChange`; `setState` reflects external changes (Req 1.1).
 */
function createToggle(onChange: (enabled: boolean) => void): ToggleHandle {
  const row = document.createElement("div");
  row.className = joinClasses(
    "flex items-center justify-between gap-md",
    "px-md py-sm rounded-lg bg-white border-2 border-[#0a0118]",
  );

  const labelWrap = document.createElement("div");
  labelWrap.className = "flex flex-col";

  const labelId = "acx-toggle-label";
  const title = document.createElement("span");
  title.id = labelId;
  title.className = "text-body-sm font-sans";
  title.style.color = "#0a0118";
  title.textContent = "Alpha Cursor";

  const stateText = document.createElement("span");
  stateText.className = "text-caption font-sans";
  stateText.style.color = "#4a3f6b";

  labelWrap.append(title, stateText);

  // The switch itself: a pill track with a sliding knob.
  const sw = document.createElement("button");
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-labelledby", labelId);
  sw.className = joinClasses(
    "relative inline-flex items-center shrink-0 cursor-pointer",
    "w-[46px] h-[26px] rounded-full border-2 border-[#0a0118] p-0",
    "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
    "motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out",
  );

  const knob = document.createElement("span");
  knob.setAttribute("aria-hidden", "true");
  knob.className = joinClasses(
    "absolute top-[1px] left-[1px] size-[20px] rounded-full bg-white border-2 border-[#0a0118]",
    "motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out",
  );
  sw.appendChild(knob);

  // Seed from the cached/default state (default-on) so the switch shows ON
  // immediately on open instead of flashing OFF before storage resolves.
  let current = getCachedEnabled();

  const paint = (enabled: boolean): void => {
    sw.setAttribute("aria-checked", String(enabled));
    // Track color: reserved primary when ON, neutral grey when OFF. Fixed
    // colors so the console reads the same on every background theme.
    sw.style.backgroundColor = enabled
      ? "var(--acx-color-primary)"
      : "#c9c2dd";
    knob.style.transform = enabled ? "translateX(18px)" : "translateX(0)";
    stateText.textContent = enabled ? "On" : "Off";
  };

  paint(current);

  sw.addEventListener("click", () => {
    current = !current;
    paint(current);
    onChange(current);
  });

  row.append(labelWrap, sw);

  return {
    el: row,
    setState(enabled: boolean): void {
      current = enabled;
      paint(enabled);
    },
  };
}

// ---------------------------------------------------------------------------
// Notepad view — Req 6.1
// ---------------------------------------------------------------------------

/** Render the notepad entries (most-recent first) or an empty state. */
function renderNotepadList(container: HTMLElement, entries: NotepadEntry[]): void {
  container.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = joinClasses(
      "flex items-center justify-center text-center",
      "acx-arcade-screen px-md py-lg",
      "text-caption font-sans",
    );
    empty.textContent = "No copied text yet. Copies are saved here automatically.";
    container.appendChild(empty);
    return;
  }

  const screen = document.createElement("div");
  screen.className = "acx-arcade-screen p-sm";

  const list = document.createElement("ul");
  list.className = joinClasses(
    "m-0 p-0 list-none flex flex-col gap-xs",
    // ONE scroller for the whole notepad: the list scrolls, entries do not.
    "max-h-[300px] overflow-y-auto pr-xxs",
  );

  // Most-recent first.
  for (const entry of [...entries].reverse()) {
    const item = document.createElement("li");
    item.className = joinClasses(
      // Show the FULL copied text (wrapped). No per-entry scrollbar — the
      // single list scroller above lets the user scroll through everything.
      "text-body-sm font-sans whitespace-pre-wrap break-words",
      "px-sm py-xs rounded-sm bg-white/70 border-2 border-[#0a0118]",
    );
    item.style.color = "#1a2e22";
    const text = entry.text.trim();
    item.textContent = text.length > 0 ? text : "(empty)";
    list.appendChild(item);
  }

  screen.appendChild(list);
  container.appendChild(screen);
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/** Build and mount the full popup UI into `root`. */
function mountPopup(root: HTMLElement): void {
  // The whole popup is a white retro gaming console (fixed colors so it looks
  // identical for every selected background color). No outer margin — the body
  // is painted the same white so the window's square corners vanish behind the
  // single rounded console frame.
  root.className = joinClasses(
    "w-[320px] box-border flex flex-col gap-md",
    "font-sans p-md acx-arcade-console",
  );

  // ── Header / wordmark ────────────────────────────────────────────────
  const header = document.createElement("header");
  header.className = "flex items-center justify-between";

  const wordmark = document.createElement("h1");
  wordmark.className = "m-0 text-title font-sans text-ink";
  wordmark.textContent = "Alpha Cursor";
  header.appendChild(wordmark);

  // ── Global Toggle ────────────────────────────────────────────────────
  const toggle = createToggle((enabled) => {
    void setEnabled(enabled);
  });

  // ── Notepad section ──────────────────────────────────────────────────
  const section = document.createElement("section");
  section.className = "flex flex-col gap-sm";
  section.setAttribute("aria-label", "Notepad");

  const sectionHead = document.createElement("div");
  sectionHead.className = "flex items-center justify-between gap-sm";

  const sectionTitle = document.createElement("h2");
  sectionTitle.className = "m-0 text-body-md font-sans text-ink";
  sectionTitle.textContent = "Notepad";

  const status = createStatusRegion();

  const copyAllBtn = createButton({
    variant: "secondary",
    label: "Copy All",
    ariaLabel: "Copy all notepad entries",
    className: "text-body-sm px-md py-xxs whitespace-nowrap",
    onClick: () => {
      void runCopyAll();
    },
  });
  // Brand fill: violet with white label.
  copyAllBtn.style.backgroundColor = "#9747ff";
  copyAllBtn.style.color = "#ffffff";

  const clearAllBtn = createButton({
    variant: "secondary",
    label: "Clear All",
    ariaLabel: "Clear all notepad entries",
    className: "text-body-sm px-md py-xxs whitespace-nowrap",
    onClick: () => {
      void runClearAll();
    },
  });
  // Brand fill: coral red with white label (the destructive action).
  clearAllBtn.style.backgroundColor = "#ff5555";
  clearAllBtn.style.color = "#ffffff";

  const headActions = document.createElement("div");
  headActions.className = "flex items-center gap-sm";
  headActions.append(clearAllBtn, copyAllBtn);

  sectionHead.append(sectionTitle, headActions);

  const listContainer = document.createElement("div");
  renderNotepadList(listContainer, []);

  section.append(sectionHead, listContainer, status.el);

  // ── Footer: open full Options page (Req 19.1) ────────────────────────
  const footer = document.createElement("footer");
  footer.className = "flex items-center justify-end pt-xs border-t-2 border-[#0a0118]";

  const optionsBtn = createButton({
    variant: "secondary",
    label: "Open Settings",
    ariaLabel: "Open the full settings page",
    className: "text-body-sm px-md py-xxs whitespace-nowrap",
    onClick: () => {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      }
    },
  });
  // Brand fill: indigo with white label.
  optionsBtn.style.backgroundColor = "#4503ff";
  optionsBtn.style.color = "#ffffff";
  footer.appendChild(optionsBtn);

  root.append(header, toggle.el, section, footer);

  // ── Wire up live data ────────────────────────────────────────────────

  // Toggle: seed from storage, then reflect external changes.
  void getEnabled().then((enabled) => toggle.setState(enabled));
  onEnabledChanged((enabled) => toggle.setState(enabled));

  // Notepad: load the current entries.
  void refreshNotepad(listContainer);

  /** Re-fetch and re-render the notepad list from the background. */
  async function refreshNotepad(target: HTMLElement): Promise<void> {
    const response = await sendToBackground<undefined, NotepadEntry[]>(
      NotepadMessageType.LIST,
      undefined,
    );
    if (isOk(response) && Array.isArray(response.data)) {
      renderNotepadList(target, response.data);
    }
  }

  /**
   * Copy All flow: ask the background to join entries, then write to the
   * clipboard here. Empty → "Notepad is empty" (no clipboard write, Req 6.4);
   * success → confirmation (Req 6.3); failure → error message (Req 6.5).
   */
  async function runCopyAll(): Promise<void> {
    const response = await sendToBackground<undefined, NotepadCopyAllResult>(
      NotepadMessageType.COPY_ALL,
      undefined,
    );

    if (!isOk(response)) {
      status.show("Couldn't read the notepad.", "error");
      return;
    }

    const { joined, count, empty } = response.data;
    if (empty) {
      status.show("Notepad is empty.", "info");
      return;
    }

    try {
      await navigator.clipboard.writeText(joined);
    } catch {
      status.show("Couldn't copy to the clipboard.", "error");
      return;
    }

    status.show(
      `Copied ${count} ${count === 1 ? "entry" : "entries"}.`,
      "success",
    );
  }

  /**
   * Clear All flow: ask the background to clear every notepad entry, then
   * re-render the (now empty) list. Reports the count cleared.
   */
  async function runClearAll(): Promise<void> {
    const response = await sendToBackground<undefined, ClearNotepadResult>(
      NotepadMessageType.CLEAR,
      undefined,
    );
    if (!isOk(response)) {
      status.show("Couldn't clear the notepad.", "error");
      return;
    }
    await refreshNotepad(listContainer);
    const n = response.data.entriesCleared;
    if (n === 0) {
      status.show("Notepad is already empty.", "info");
    } else {
      status.show(`Cleared ${n} ${n === 1 ? "entry" : "entries"}.`, "success");
    }
  }
}

const appRoot = document.getElementById("app");
if (appRoot) {
  applyThemeToDocument();
  mountPopup(appRoot);
}

export {};
