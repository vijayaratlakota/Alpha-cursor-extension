/**
 * Alpha Cursor — Auto-copy on text selection (automatic content feature).
 *
 * When the user drag-selects text with the left mouse button and releases, the
 * highlighted text is:
 *   1. copied to the system clipboard,
 *   2. appended to the Notepad (the same store the "Copy All" tool reads), and
 *   3. confirmed with a "Text copied" Notification.
 *
 * Two UX refinements requested on top of the base feature:
 *   - **Green selection highlight.** While the feature is active the page's
 *     native text-selection color is overridden to the Wise lime-green so the
 *     user can tell at a glance that dragging will copy. Implemented by
 *     injecting a `::selection` rule into the document head (and removing it
 *     when the feature is disabled / detached).
 *   - **Undo with Ctrl+Z.** Because an accidental drag can capture unwanted
 *     text into the Notepad, pressing Ctrl/Cmd+Z right after an auto-copy
 *     removes that just-added Notepad entry (when the user is not typing in an
 *     editable field, so we never hijack a real text-undo).
 *
 * Like the notepad copy-capture and cookie-consent removal, this is an
 * AUTOMATIC feature (not an Options_Panel tool): it self-gates on the global
 * Toggle and is attached/detached by the content-script bootstrap when the
 * Toggle flips (Req 1.2, 1.3, 1.6).
 *
 * ## Why `mouseup` and not `selectionchange`
 * `selectionchange` fires continuously while dragging and also for keyboard /
 * programmatic selection, which would spam the clipboard. Gating on a
 * left-button `mousedown`→`mouseup` pair scopes the feature to an explicit
 * mouse drag-select, exactly as requested.
 */

import { getCachedEnabled, getCachedFeatureFlags } from "../../shared/settings";
import { notify } from "../../ui/notify";
import {
  ErrorCode,
  createMessage,
  isOk,
  type Response,
} from "../../shared/messaging";
import {
  NotepadMessageType,
  type NotepadAppendPayload,
  type NotepadAppendResult,
  type NotepadRemovePayload,
  type NotepadRemoveResult,
} from "../notepad/notepad";

/** Disposer returned by {@link initAutoCopy}. */
export type DetachAutoCopy = () => void;

/** Minimum pointer travel (CSS px) to treat a gesture as a drag, not a click. */
const DRAG_THRESHOLD_PX = 4;

/** Brand-yellow selection highlight. */
const SELECTION_GREEN = "#ffd913";
/** Dark ink for selected text on the yellow highlight (the brand contrast). */
const SELECTION_INK = "#0a0118";
/** Marker attribute on the injected `::selection` style element. */
const SELECTION_STYLE_ID = "acx-autocopy-selection-style";

/** Read the current document selection text, or `""` when nothing is selected. */
function readSelectionText(): string {
  const selection = (globalThis as { getSelection?: () => Selection | null })
    .getSelection?.();
  return selection ? selection.toString() : "";
}

/**
 * Send a typed message to the background router and resolve with its
 * `Response`. Normalizes a missing channel / thrown context into an error
 * branch so callers never reject.
 */
function sendToBackground<T, R>(type: string, payload: T): Promise<Response<R>> {
  return new Promise<Response<R>>((resolve) => {
    try {
      const maybe = chrome.runtime.sendMessage(createMessage(type, payload)) as
        | Promise<Response<R>>
        | undefined;
      if (maybe && typeof maybe.then === "function") {
        maybe.then(
          (response) =>
            resolve(
              response ?? {
                ok: false,
                error: {
                  code: ErrorCode.UNKNOWN,
                  message: "No response",
                  recoverable: true,
                },
              },
            ),
          (error) =>
            resolve({
              ok: false,
              error: {
                code: ErrorCode.UNKNOWN,
                message: error instanceof Error ? error.message : String(error),
                recoverable: true,
              },
            }),
        );
        return;
      }
      resolve({
        ok: false,
        error: {
          code: ErrorCode.UNKNOWN,
          message: "No response",
          recoverable: true,
        },
      });
    } catch (error) {
      resolve({
        ok: false,
        error: {
          code: ErrorCode.UNKNOWN,
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        },
      });
    }
  });
}

/**
 * Inject the green `::selection` override into the document head so the user
 * sees green-highlighted text (instead of the default blue) while the feature
 * is active. Idempotent. Returns nothing; pair with {@link removeSelectionStyle}.
 */
function installSelectionStyle(): void {
  if (document.getElementById(SELECTION_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = SELECTION_STYLE_ID;
  style.textContent = `
    ::selection { background: ${SELECTION_GREEN} !important; color: ${SELECTION_INK} !important; }
    ::-moz-selection { background: ${SELECTION_GREEN} !important; color: ${SELECTION_INK} !important; }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

/** Remove the injected green `::selection` override, if present. */
function removeSelectionStyle(): void {
  document.getElementById(SELECTION_STYLE_ID)?.remove();
}

// ---------------------------------------------------------------------------
// Persistent green highlight (CSS Custom Highlight API, until page refresh)
// ---------------------------------------------------------------------------

/** Name registered in the global `CSS.highlights` registry. */
const PERSIST_HIGHLIGHT_NAME = "acx-copied";
/** Marker id for the injected `::highlight()` style rule. */
const PERSIST_HIGHLIGHT_STYLE_ID = "acx-autocopy-highlight-style";

/**
 * Feature-detect the CSS Custom Highlight API. When available we can paint a
 * persistent highlight over arbitrary ranges WITHOUT mutating the page DOM, and
 * it survives the selection collapsing — exactly what "keep the highlight until
 * refresh" needs. (Chrome 105+.)
 */
function supportsHighlightApi(): boolean {
  return (
    typeof CSS !== "undefined" &&
    // `CSS.highlights` is a Map-like registry; `Highlight` is the range set.
    "highlights" in CSS &&
    typeof (globalThis as { Highlight?: unknown }).Highlight === "function"
  );
}

/** Ensure the `::highlight(acx-copied)` green style rule is in the document. */
function installHighlightStyle(): void {
  if (document.getElementById(PERSIST_HIGHLIGHT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = PERSIST_HIGHLIGHT_STYLE_ID;
  style.textContent = `
    ::highlight(${PERSIST_HIGHLIGHT_NAME}) {
      background: ${SELECTION_GREEN};
      color: ${SELECTION_INK};
    }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

/** The shared `Highlight` instance accumulating every copied range this page. */
let persistHighlight: Highlight | null = null;

/**
 * Persist a green highlight over `range` (a clone of the user's selection) so
 * it stays visible after the selection collapses, until the page is refreshed
 * or the highlight is cleared. No-op when the API is unsupported (the live
 * `::selection` green still gives immediate feedback during the drag).
 */
function addPersistentHighlight(range: Range): void {
  if (!supportsHighlightApi()) return;
  installHighlightStyle();
  const registry = (CSS as unknown as { highlights: Map<string, Highlight> })
    .highlights;
  if (!persistHighlight) {
    persistHighlight = new Highlight();
    registry.set(PERSIST_HIGHLIGHT_NAME, persistHighlight);
  }
  try {
    persistHighlight.add(range);
  } catch {
    /* a detached/invalid range is ignored */
  }
}

/** Clear every persistent copied-text highlight (used on feature teardown). */
function clearPersistentHighlights(): void {
  if (typeof CSS !== "undefined" && "highlights" in CSS) {
    const cssAny = CSS as unknown as { highlights?: Map<string, Highlight> };
    cssAny.highlights?.delete(PERSIST_HIGHLIGHT_NAME);
  }
  persistHighlight = null;
  document.getElementById(PERSIST_HIGHLIGHT_STYLE_ID)?.remove();
}

/**
 * Attach the drag-select → auto-copy listeners (only active while the Toggle is
 * ON, via `getCachedEnabled()`). Installs the green selection highlight and
 * wires Ctrl/Cmd+Z to undo the most recent auto-copy capture.
 *
 * @param target The event target to listen on. Defaults to `document`.
 * @returns A disposer that removes the listeners and the selection style.
 */
export function initAutoCopy(target: Document = document): DetachAutoCopy {
  let armed = false;
  let startX = 0;
  let startY = 0;
  /** Id of the most recent Notepad entry added by auto-copy (for undo). */
  let lastAppendedId: string | null = null;

  installSelectionStyle();

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return; // left button only
    armed = true;
    startX = event.clientX;
    startY = event.clientY;
  };

  const onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0 || !armed) return;
    armed = false;

    if (!getCachedEnabled()) return;

    // Require genuine pointer travel so a plain click (which can leave a
    // lingering selection) does not trigger a copy.
    const movedEnough =
      Math.abs(event.clientX - startX) >= DRAG_THRESHOLD_PX ||
      Math.abs(event.clientY - startY) >= DRAG_THRESHOLD_PX;
    if (!movedEnough) return;

    const text = readSelectionText();
    if (text.trim().length === 0) return;

    // Capture a clone of the selected range BEFORE it can collapse, so we can
    // paint a persistent highlight over it (when the feature flag is on).
    if (getCachedFeatureFlags().persistHighlight) {
      const selection = (
        globalThis as { getSelection?: () => Selection | null }
      ).getSelection?.();
      if (selection && selection.rangeCount > 0) {
        try {
          addPersistentHighlight(selection.getRangeAt(0).cloneRange());
        } catch {
          /* ignore an unusable range */
        }
      }
    }

    void handleCapture(text);
  };

  /** Copy to clipboard + append to the Notepad, then confirm (Req 4.1, 4.3). */
  async function handleCapture(text: string): Promise<void> {
    // 1) System clipboard (user-gesture context).
    let clipboardOk = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      clipboardOk = false;
    }

    // 2) Notepad append (so it joins the "Copy All" history). Remember the new
    //    entry id so Ctrl+Z can undo this specific capture.
    const sourceUrl =
      (globalThis as { location?: Location }).location?.href ?? undefined;
    const payload: NotepadAppendPayload = sourceUrl ? { text, sourceUrl } : { text };
    const response = await sendToBackground<
      NotepadAppendPayload,
      NotepadAppendResult
    >(NotepadMessageType.APPEND, payload);
    if (isOk(response)) {
      lastAppendedId = response.data.entry.id;
      if (response.data.quotaExceeded) {
        notify({
          kind: "error",
          text: "Storage limit reached; some copies may not be saved.",
          code: ErrorCode.QUOTA_EXCEEDED,
        });
      }
    }

    // 3) Confirm.
    if (clipboardOk) {
      notify({ kind: "success", text: "Text copied — press Ctrl+Z to undo" });
    } else {
      notify({
        kind: "error",
        text: "Couldn't copy to the clipboard.",
        code: ErrorCode.CLIPBOARD_FAILED,
      });
    }
  }

  /** True when focus is in an editable field (so we don't hijack text-undo). */
  function isEditingContext(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return true;
    }
    return el instanceof HTMLElement && el.isContentEditable;
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    // Undo the last auto-copy capture with Ctrl/Cmd+Z — but only when there is
    // something to undo and the user is NOT typing in a field (so a real
    // text-undo is never stolen).
    const isUndo =
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey &&
      (event.key === "z" || event.key === "Z");
    if (!isUndo) return;
    if (!getCachedEnabled()) return;
    if (lastAppendedId === null) return;
    if (isEditingContext()) return;

    event.preventDefault();
    event.stopPropagation();
    const id = lastAppendedId;
    lastAppendedId = null;
    void sendToBackground<NotepadRemovePayload, NotepadRemoveResult>(
      NotepadMessageType.REMOVE,
      { id },
    ).then((response) => {
      if (isOk(response) && response.data.removed) {
        notify({ kind: "info", text: "Removed the copied text from the notepad" });
      }
    });
  };

  target.addEventListener("mousedown", onMouseDown as EventListener, true);
  target.addEventListener("mouseup", onMouseUp as EventListener, true);
  target.addEventListener("keydown", onKeyDown as EventListener, true);

  return () => {
    target.removeEventListener("mousedown", onMouseDown as EventListener, true);
    target.removeEventListener("mouseup", onMouseUp as EventListener, true);
    target.removeEventListener("keydown", onKeyDown as EventListener, true);
    removeSelectionStyle();
    clearPersistentHighlights();
  };
}
