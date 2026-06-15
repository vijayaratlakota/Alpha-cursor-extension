/**
 * Alpha Cursor — Voice to Text tool (Tool 11, Req 16).
 *
 * Wires the "Voice to text" Options_Panel entry into the tool catalog via
 * {@link registerTool}. On invocation it renders a Notion-styled microphone
 * control panel inside a CLOSED Shadow DOM host, drives the browser-native
 * Web Speech API `SpeechRecognition`, streams interim + final transcripts live,
 * and on stop exposes the final transcript with **Copy** and (when an editable
 * field was focused at the start) **Insert** actions.
 *
 * ## Web Speech API nuance (privacy)
 * Chrome's `SpeechRecognition` implementation may stream the captured audio to a
 * Google speech service internally as part of the browser platform — this is
 * browser-native behavior entirely outside the extension's control. The
 * *extension itself* adds **no server** and makes no such network call directly.
 * This nuance is surfaced to the user in the privacy statement (task 26.2).
 *
 * ## Flow (Req 16.1–16.6)
 * 1. Capture the editable element focused *at start* so the transcript can be
 *    inserted there later (Req 16.6). This snapshot is taken before any panel
 *    UI steals focus.
 * 2. Show a mic control panel with a live transcript area (Req 16.1, 16.2).
 * 3. Start recognition — which implicitly triggers the browser microphone
 *    permission prompt. `interimResults = true` streams not-yet-final
 *    hypotheses so the transcript updates live (Req 16.3).
 * 4. If permission is denied (`error === "not-allowed"` /
 *    `"service-not-allowed"`, or a `getUserMedia` rejection), notify
 *    `MIC_DENIED` and do NOT capture (Req 16.5).
 * 5. On stop (user clicks Stop, or recognition ends), expose the final
 *    transcript with Copy / Insert (Req 16.4, 16.6).
 *
 * The Web Speech API, the closed Shadow DOM UI, and the clipboard/insert side
 * effects are all integration concerns, so this module is exercised by example
 * tests (task 20.2) rather than property tests.
 */

import { notify } from "../../ui/notify";
import { createShadowHost, type ShadowHostHandle } from "../../ui/shadowHost";
import { createButton, createCard, joinClasses } from "../../ui/primitives";
import {
  registerTool,
  ToolId,
  type ToolInvocation,
  type ToolRun,
} from "../../content/tools";
import { ErrorCode } from "../../shared/messaging";

/** Message shown when the browser lacks the Web Speech API (Req 16.2). */
const UNSUPPORTED_TEXT = "voice input isn't supported in this browser";
/** Message shown when microphone access is denied (Req 16.5). */
const MIC_DENIED_TEXT = "microphone access is required";
/** Message shown after the transcript is copied to the clipboard (Req 16.4). */
const COPIED_TEXT = "transcript copied successfully";
/** Message shown after the transcript is inserted into the focused field (Req 16.6). */
const INSERTED_TEXT = "transcript inserted";
/** Message shown when copying the transcript fails. */
const COPY_FAILED_TEXT = "could not copy transcript";

/**
 * An editable target captured at the start of dictation. A discriminated union
 * so {@link insertTranscript} can branch on the precise insertion strategy:
 * value/selection splicing for `<input>`/`<textarea>`, or text insertion for a
 * `contenteditable` host.
 */
type EditableTarget =
  | { kind: "input"; element: HTMLInputElement }
  | { kind: "textarea"; element: HTMLTextAreaElement }
  | { kind: "contenteditable"; element: HTMLElement };

/**
 * `<input>` types that hold free text we can splice a transcript into. We avoid
 * non-text types (checkbox, range, color, file, …) where inserting a string is
 * meaningless or impossible.
 */
const TEXTUAL_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "",
]);

/**
 * Snapshot the currently focused editable element, if any (Req 16.6). Recognizes
 * textual `<input>`s, `<textarea>`s, and `contenteditable` hosts. Returns `null`
 * when nothing editable is focused, in which case the panel offers Copy only.
 *
 * Called *before* the panel mounts so the user's original focus target is what
 * gets captured (the panel UI is non-focusable text, but we snapshot eagerly to
 * be safe).
 */
export function captureFocusedEditable(): EditableTarget | null {
  const active = document.activeElement;
  if (!active) return null;

  if (active instanceof HTMLInputElement) {
    const type = (active.type || "").toLowerCase();
    if (TEXTUAL_INPUT_TYPES.has(type)) {
      return { kind: "input", element: active };
    }
    return null;
  }

  if (active instanceof HTMLTextAreaElement) {
    return { kind: "textarea", element: active };
  }

  if (active instanceof HTMLElement && active.isContentEditable) {
    return { kind: "contenteditable", element: active };
  }

  return null;
}

/**
 * Insert `text` into a previously captured {@link EditableTarget} (Req 16.6).
 *
 * For `<input>`/`<textarea>` we splice the text into the current selection range
 * (falling back to the end of the value), move the caret after the inserted
 * text, and dispatch an `input` event so host-page frameworks observe the
 * change. For a `contenteditable` host we focus it and insert at the current
 * selection, preferring the Selection/Range API and falling back to appending.
 */
export function insertTranscript(target: EditableTarget, text: string): void {
  if (target.kind === "input" || target.kind === "textarea") {
    const el = target.element;
    const value = el.value;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    el.value = value.slice(0, start) + text + value.slice(end);
    const caret = start + text.length;
    try {
      el.setSelectionRange(caret, caret);
    } catch {
      // `number` inputs (and some others) reject setSelectionRange; ignore.
    }
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  // contenteditable
  const host = target.element;
  host.focus();
  const selection = window.getSelection();
  if (
    selection &&
    selection.rangeCount > 0 &&
    host.contains(selection.anchorNode)
  ) {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    // Move the caret to just after the inserted text.
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    host.appendChild(document.createTextNode(text));
  }
  host.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Resolve the Web Speech API constructor, preferring the standard
 * `SpeechRecognition` and falling back to the `webkit`-prefixed name used by
 * Chromium. Returns `undefined` when neither exists (Req 16.2 unsupported path).
 */
function resolveRecognitionCtor(): SpeechRecognitionConstructor | undefined {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

/**
 * Assemble the live transcript string from a recognition results list. Final
 * results are concatenated as settled text; the trailing interim hypotheses are
 * appended so the user sees words appear as they speak (Req 16.3).
 */
function buildTranscript(results: SpeechRecognitionResultList): {
  finalText: string;
  interimText: string;
} {
  let finalText = "";
  let interimText = "";
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (!result) continue;
    const alternative = result[0];
    if (!alternative) continue;
    if (result.isFinal) {
      finalText += alternative.transcript;
    } else {
      interimText += alternative.transcript;
    }
  }
  return { finalText, interimText };
}

/** UI handles the panel exposes so the recognition callbacks can drive it. */
interface VoicePanel {
  readonly handle: ShadowHostHandle;
  /** Update the live transcript display (final settled text + interim tail). */
  showTranscript(finalText: string, interimText: string): void;
  /** Switch the panel into the "stopped" state with Copy/Insert actions. */
  showResult(transcript: string): void;
  /** Replace the mic button's handler/label (used to flip Start↔Stop). */
  setStopHandler(onStop: () => void): void;
  /** Wire the Backspace button (removes the last spoken word). */
  setBackspaceHandler(onBackspace: () => void): void;
}

/**
 * Build the Notion-styled mic control panel inside an anchored closed Shadow DOM
 * host (Req 16.1, 16.2). Renders a title, a live transcript area, and a control
 * row (mic/stop + close). The result actions (Copy / Insert) are added later by
 * {@link VoicePanel.showResult} once dictation stops.
 */
function createVoicePanel(
  invocation: ToolInvocation,
  target: EditableTarget | null,
  onClose: () => void,
): VoicePanel {
  const handle = createShadowHost({
    overlay: "anchored",
    point: invocation.point,
    surfaceId: "voice-to-text",
  });

  const title = document.createElement("div");
  title.className = "text-body-md font-sans text-ink font-medium";
  title.textContent = "Voice to text";

  const status = document.createElement("div");
  status.className = "text-body-sm font-sans text-ink-faint";
  status.textContent = "Listening…";

  // Live transcript area. `aria-live=polite` announces updates without
  // interrupting; `whitespace-pre-wrap` keeps spacing as recognized. The screen
  // sets a theme-appropriate text color (dark on the light CRT, light on the
  // dark CRT) so the dictated input is always clearly readable.
  const transcriptEl = document.createElement("div");
  transcriptEl.className = joinClasses(
    "acx-screen",
    "min-h-[3.5rem] max-h-40 overflow-auto",
    "text-body-sm font-sans whitespace-pre-wrap",
  );
  transcriptEl.setAttribute("role", "status");
  transcriptEl.setAttribute("aria-live", "polite");

  // Control row: the mic/stop toggle plus a close affordance.
  const controls = document.createElement("div");
  controls.className = "flex items-center gap-xs flex-wrap";

  // Compact button sizing so the controls stay small (not the oversized pills).
  const SMALL_BTN = "text-caption px-md py-xxs whitespace-nowrap";

  let micButton = createButton({
    variant: "primary",
    label: "Stop",
    icon: "⏹",
    ariaLabel: "Stop dictation",
    className: SMALL_BTN,
  });

  // Backspace: removes the last spoken word so the user can correct a mistake
  // and keep speaking (handler wired by the recognition driver).
  const backspaceButton = createButton({
    variant: "secondary",
    label: "Backspace",
    icon: "⌫",
    ariaLabel: "Delete the last spoken word",
    className: SMALL_BTN,
  });

  controls.appendChild(micButton);
  controls.appendChild(backspaceButton);

  const card = createCard({
    variant: "elevated",
    className: joinClasses(
      "pointer-events-auto flex flex-col gap-sm",
      "w-[min(20rem,calc(100vw-2rem))]",
    ),
    children: [title, status, transcriptEl, controls],
  });

  handle.mount(card);

  // Close on Escape or outside-click (replaces the removed ✕ button). Capture
  // phase so it wins over page handlers; deferred outside-click so the opening
  // click is not treated as a dismissal.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  handle.onDestroy(() => window.removeEventListener("keydown", onKeyDown, true));

  const onPointerDown = (event: MouseEvent): void => {
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];
    if (!path.includes(handle.host)) {
      onClose();
    }
  };
  setTimeout(() => {
    window.addEventListener("mousedown", onPointerDown, true);
    handle.onDestroy(() =>
      window.removeEventListener("mousedown", onPointerDown, true),
    );
  }, 0);

  const showTranscript = (finalText: string, interimText: string): void => {
    // Settled text in full ink, interim hypotheses in a faint tail (Req 16.3).
    transcriptEl.textContent = "";
    if (finalText) {
      const finalSpan = document.createElement("span");
      finalSpan.textContent = finalText;
      transcriptEl.appendChild(finalSpan);
    }
    if (interimText) {
      const interimSpan = document.createElement("span");
      interimSpan.className = "text-ink-faint";
      interimSpan.textContent = interimText;
      transcriptEl.appendChild(interimSpan);
    }
    if (!finalText && !interimText) {
      transcriptEl.textContent = "";
    }
  };

  const setStopHandler = (onStop: () => void): void => {
    const next = createButton({
      variant: "primary",
      label: "Stop",
      icon: "⏹",
      ariaLabel: "Stop dictation",
      className: SMALL_BTN,
      onClick: onStop,
    });
    micButton.replaceWith(next);
    micButton = next;
  };

  const setBackspaceHandler = (onBackspace: () => void): void => {
    backspaceButton.addEventListener("click", onBackspace);
  };

  const showResult = (transcript: string): void => {
    status.textContent = transcript
      ? "Dictation finished"
      : "No speech was recognized";

    // Replace the Stop button with the result actions: Copy always, Insert only
    // when an editable field was focused at start (Req 16.4, 16.6).
    const actions = document.createElement("div");
    actions.className = "flex items-center gap-sm";

    const copyButton = createButton({
      variant: target ? "secondary" : "primary",
      label: "Copy",
      icon: "⎘",
      ariaLabel: "Copy transcript",
      className: SMALL_BTN,
      disabled: transcript.length === 0,
      onClick: () => {
        void copyTranscript(transcript, onClose);
      },
    });
    actions.appendChild(copyButton);

    if (target) {
      const insertButton = createButton({
        variant: "primary",
        label: "Insert",
        icon: "↵",
        ariaLabel: "Insert transcript into field",
        className: SMALL_BTN,
        disabled: transcript.length === 0,
        onClick: () => {
          insertTranscript(target, transcript);
          notify({ kind: "success", text: INSERTED_TEXT });
          onClose();
        },
      });
      actions.appendChild(insertButton);
    }

    micButton.replaceWith(actions);
  };

  return { handle, showTranscript, showResult, setStopHandler, setBackspaceHandler };
}

/** Copy the transcript to the clipboard, notifying success/failure (Req 16.4). */
async function copyTranscript(
  transcript: string,
  onDone: () => void,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(transcript);
  } catch {
    notify({
      kind: "error",
      text: COPY_FAILED_TEXT,
      code: ErrorCode.CLIPBOARD_FAILED,
    });
    return;
  }
  notify({ kind: "success", text: COPIED_TEXT });
  onDone();
}

/** Returns `true` for recognition error codes that mean permission was denied. */
function isPermissionError(code: SpeechRecognitionErrorCode): boolean {
  return code === "not-allowed" || code === "service-not-allowed";
}

/**
 * Module-level teardown for the single active voice session. Clicking "Voice to
 * text" again (or invoking it while one is open) must REPLACE the existing
 * panel, not stack a new one on top (fixes the duplicate-panels bug). We keep a
 * single disposer and run it before starting a new session.
 */
let activeVoiceTeardown: (() => void) | null = null;

/**
 * The Voice to Text `run` handler installed into the Options_Panel catalog.
 *
 * Captures the editable target focused at start, mounts the mic panel, and
 * drives a `SpeechRecognition` session: streaming interim + final transcripts
 * live, surfacing a `MIC_DENIED` notification (and tearing down without
 * capturing) when permission is refused, and exposing Copy/Insert on stop.
 */
export const runVoiceToText: ToolRun = (
  invocation: ToolInvocation,
): void => {
  // Replace any voice panel already open so repeated clicks never stack panels.
  if (activeVoiceTeardown) {
    activeVoiceTeardown();
    activeVoiceTeardown = null;
  }

  const RecognitionCtor = resolveRecognitionCtor();
  if (!RecognitionCtor) {
    // No Web Speech API in this browser — notify and stop (Req 16.2).
    notify({ kind: "error", text: UNSUPPORTED_TEXT });
    return;
  }

  // Snapshot the focused editable BEFORE the panel mounts (Req 16.6).
  const target = captureFocusedEditable();

  const recognition = new RecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true; // stream interim hypotheses (Req 16.3)
  recognition.lang = document.documentElement.lang || navigator.language || "en-US";

  let finalTranscript = "";
  // The engine's last-reported settled text (raw, unedited). Used purely as the
  // baseline to compute the delta of newly recognized words. User edits like
  // Backspace touch `finalTranscript` only, never this baseline, so deletions
  // are never re-added when the next result arrives.
  let engineFinalRaw = "";
  let stopped = false;
  let permissionDenied = false;

  let panel: VoicePanel | null = null;

  /** Strip a trailing word (and its preceding whitespace) from `text`. */
  const removeLastWord = (text: string): string => {
    const trimmedEnd = text.replace(/\s+$/, "");
    const lastSpace = trimmedEnd.search(/\s\S*$/);
    return lastSpace === -1 ? "" : trimmedEnd.slice(0, lastSpace);
  };

  const teardown = (): void => {
    try {
      recognition.abort();
    } catch {
      // Aborting an already-stopped recognition can throw; ignore.
    }
    panel?.handle.destroy();
    if (activeVoiceTeardown === teardown) {
      activeVoiceTeardown = null;
    }
  };
  activeVoiceTeardown = teardown;

  panel = createVoicePanel(invocation, target, teardown);

  // Stop on user request. The `end` event (fired after stop()) finalizes the UI.
  const requestStop = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      recognition.stop();
    } catch {
      // If stop() throws (e.g. never started), finalize immediately.
      finalizeResult();
    }
  };
  panel.setStopHandler(requestStop);

  // Backspace removes the last spoken word from the running transcript so the
  // user can correct a mistake and keep dictating. It edits only the displayed
  // transcript — the engine baseline (`engineFinalRaw`) is left untouched so the
  // next recognized words still append correctly after the edit.
  panel.setBackspaceHandler(() => {
    finalTranscript = removeLastWord(finalTranscript);
    panel?.showTranscript(finalTranscript, "");
  });

  const finalizeResult = (): void => {
    if (permissionDenied) return; // denial already handled (no result UI)
    panel?.showResult(finalTranscript.trim());
  };

  recognition.onresult = (event: SpeechRecognitionEvent): void => {
    const { finalText, interimText } = buildTranscript(event.results);
    // Append only the NEWLY settled words (the delta beyond the engine's prior
    // settled text) so earlier user edits (Backspace) are preserved.
    if (finalText.length >= engineFinalRaw.length && finalText.startsWith(engineFinalRaw)) {
      const delta = finalText.slice(engineFinalRaw.length);
      if (delta) finalTranscript += delta;
    } else if (finalText !== engineFinalRaw) {
      // The engine revised earlier text (rare): fall back to its full version.
      finalTranscript = finalText;
    }
    engineFinalRaw = finalText;
    panel?.showTranscript(finalTranscript, interimText);
  };

  recognition.onerror = (event: SpeechRecognitionErrorEvent): void => {
    if (isPermissionError(event.error)) {
      // Permission denied: notify MIC_DENIED and do NOT capture (Req 16.5).
      permissionDenied = true;
      stopped = true;
      notify({
        kind: "error",
        text: MIC_DENIED_TEXT,
        code: ErrorCode.MIC_DENIED,
      });
      teardown();
    }
    // Other errors (no-speech, network, …) let the `end` event finalize.
  };

  recognition.onend = (): void => {
    if (permissionDenied) return;
    stopped = true;
    finalizeResult();
  };

  // Starting recognition implicitly requests microphone permission (Req 16.2).
  // A synchronous throw here (e.g. already started, or insecure context) is
  // treated as a denial so the user is never left with a dead panel.
  try {
    recognition.start();
  } catch {
    permissionDenied = true;
    notify({
      kind: "error",
      text: MIC_DENIED_TEXT,
      code: ErrorCode.MIC_DENIED,
    });
    teardown();
  }
};

/**
 * Register the Voice to Text tool's real behavior in the Options_Panel catalog,
 * replacing the placeholder stub (Req 16.1–16.6). Called from the content-script
 * orchestrator at init time alongside the other tool registrations.
 *
 * @returns `true` if the tool was registered (it always exists in the catalog).
 */
export function registerVoiceTool(): boolean {
  return registerTool(ToolId.VOICE_TO_TEXT, runVoiceToText);
}
