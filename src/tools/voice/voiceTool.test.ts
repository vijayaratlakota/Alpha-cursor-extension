/**
 * Task 20.2 — example tests for the Voice to Text tool (Tool 11, Req 16).
 *
 * The `SpeechRecognition` session itself is a browser-platform integration that
 * cannot be driven for real in jsdom, so this suite focuses on:
 *
 *   - the PURE-ish exported helpers {@link captureFocusedEditable} and
 *     {@link insertTranscript}, which are fully exercisable against the DOM, and
 *   - the permission-denied branch of {@link runVoiceToText} (Req 16.5): a fake
 *     `window.SpeechRecognition` whose `start()` either throws or fires
 *     `onerror({ error: "not-allowed" })` must surface a `MIC_DENIED`
 *     notification and tear the panel down without capturing.
 *
 * `../../ui/notify` is mocked with a hoisted `vi.fn()` so we can assert the
 * notification code, and `window.matchMedia` is stubbed (jsdom lacks it) so any
 * real notify path stays safe. The voice panel mounts in a CLOSED shadow root
 * on a host carrying `data-acx-ui="voice-to-text"`; we assert teardown from the
 * document via that host attribute (a closed root is not reachable via
 * `host.shadowRoot`).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// --- Mock the notification channel so we can assert the MIC_DENIED branch. --
const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("../../ui/notify", () => ({ notify: notifyMock }));

import {
  captureFocusedEditable,
  insertTranscript,
  registerVoiceTool,
  runVoiceToText,
} from "./voiceTool";
import { getTool, ToolId, type Tool } from "../../content/tools";
import { ErrorCode } from "../../shared/messaging";

// ---------------------------------------------------------------------------
// Environment shims.
// ---------------------------------------------------------------------------

const HOST_SELECTOR = '[data-acx-ui="voice-to-text"]';

function installMatchMedia(): void {
  // jsdom lacks matchMedia; stub it so any real notify() path stays safe.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  });
}

/**
 * A controllable fake `SpeechRecognition`. Each instance records the latest
 * created instance so a test can reach in and invoke `onerror`/`onend`, and its
 * `start()` behaviour is governed by the module-level {@link startBehaviour}.
 */
let lastRecognition: FakeRecognition | null = null;
let startBehaviour: "throw" | "error-not-allowed" | "noop" = "noop";

class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((ev: SpeechRecognitionEvent) => unknown) | null = null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => unknown) | null = null;
  onend: ((ev: Event) => unknown) | null = null;
  onstart: ((ev: Event) => unknown) | null = null;
  aborted = false;

  constructor() {
    lastRecognition = this;
  }

  start(): void {
    if (startBehaviour === "throw") {
      throw new Error("start failed (insecure context)");
    }
    if (startBehaviour === "error-not-allowed") {
      // Simulate the browser denying microphone access asynchronously.
      this.onerror?.({ error: "not-allowed" } as SpeechRecognitionErrorEvent);
    }
    // "noop": leave the session open (no result/error yet).
  }

  stop(): void {}

  abort(): void {
    this.aborted = true;
  }
}

function installSpeechRecognition(): void {
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition =
    FakeRecognition as unknown as SpeechRecognitionConstructor;
  // Ensure the webkit-prefixed fallback is not present so we use the standard.
  delete (window as unknown as { webkitSpeechRecognition?: unknown })
    .webkitSpeechRecognition;
}

function hostPresent(): boolean {
  return document.querySelector(HOST_SELECTOR) !== null;
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  notifyMock.mockClear();
  document.body.innerHTML = "";
  lastRecognition = null;
  startBehaviour = "noop";
  installMatchMedia();
  installSpeechRecognition();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (window as unknown as { SpeechRecognition?: unknown })
    .SpeechRecognition;
  delete (window as unknown as { webkitSpeechRecognition?: unknown })
    .webkitSpeechRecognition;
});

// ===========================================================================
// captureFocusedEditable() — snapshot the focused editable target (Req 16.6).
// ===========================================================================

describe("captureFocusedEditable (Req 16.6)", () => {
  it("returns an input target for a focused textual <input>", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();

    const target = captureFocusedEditable();
    expect(target).not.toBeNull();
    expect(target?.kind).toBe("input");
    expect(target?.element).toBe(input);
  });

  it("returns a textarea target for a focused <textarea>", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();

    const target = captureFocusedEditable();
    expect(target?.kind).toBe("textarea");
    expect(target?.element).toBe(textarea);
  });

  it("returns a contenteditable target for a focused contenteditable host", () => {
    const div = document.createElement("div");
    div.contentEditable = "true";
    // jsdom does not derive `isContentEditable` from the attribute, so define it.
    Object.defineProperty(div, "isContentEditable", {
      configurable: true,
      value: true,
    });
    // A bare <div> is not focusable in jsdom, so a focus() call leaves
    // activeElement on <body>. tabIndex makes it focusable like a real
    // contenteditable host.
    div.tabIndex = 0;
    document.body.appendChild(div);
    div.focus();

    const target = captureFocusedEditable();
    expect(target?.kind).toBe("contenteditable");
    expect(target?.element).toBe(div);
  });

  it("returns null for a non-text input (checkbox)", () => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    document.body.appendChild(checkbox);
    checkbox.focus();

    expect(captureFocusedEditable()).toBeNull();
  });

  it("returns null when nothing editable is focused", () => {
    // No focus → activeElement is <body>, which is not editable.
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    expect(captureFocusedEditable()).toBeNull();
  });
});

// ===========================================================================
// insertTranscript() — splice/insert the transcript into a target (Req 16.6).
// ===========================================================================

describe("insertTranscript (Req 16.6)", () => {
  it("splices text at the caret of an <input> and dispatches input", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = "Hello world";
    document.body.appendChild(input);
    input.focus();
    // Caret between "Hello " and "world" (index 6).
    input.setSelectionRange(6, 6);

    const inputSpy = vi.fn();
    input.addEventListener("input", inputSpy);

    insertTranscript({ kind: "input", element: input }, "brave ");

    expect(input.value).toBe("Hello brave world");
    expect(input.value).toContain("brave");
    // Caret moved to just after the inserted text.
    expect(input.selectionStart).toBe(6 + "brave ".length);
    expect(inputSpy).toHaveBeenCalledTimes(1);
  });

  it("splices text at the caret of a <textarea> and dispatches input", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "ab";
    document.body.appendChild(textarea);
    textarea.focus();
    // Caret at the end.
    textarea.setSelectionRange(2, 2);

    const inputSpy = vi.fn();
    textarea.addEventListener("input", inputSpy);

    insertTranscript({ kind: "textarea", element: textarea }, "XYZ");

    expect(textarea.value).toBe("abXYZ");
    expect(textarea.value).toContain("XYZ");
    expect(inputSpy).toHaveBeenCalledTimes(1);
  });

  it("inserts text into a contenteditable host and dispatches input", () => {
    const div = document.createElement("div");
    div.contentEditable = "true";
    Object.defineProperty(div, "isContentEditable", {
      configurable: true,
      value: true,
    });
    document.body.appendChild(div);

    const inputSpy = vi.fn();
    div.addEventListener("input", inputSpy);

    insertTranscript({ kind: "contenteditable", element: div }, "dictated text");

    expect(div.textContent).toContain("dictated text");
    expect(inputSpy).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// runVoiceToText() — permission-denied path (Req 16.5).
// ===========================================================================

describe("runVoiceToText microphone permission denied (Req 16.5)", () => {
  it("notifies MIC_DENIED and tears the panel down when start() fires not-allowed", () => {
    startBehaviour = "error-not-allowed";

    runVoiceToText({ context: "generic-page", point: { x: 10, y: 10 } });

    // A recognition instance was created and onerror drove the denial branch.
    expect(lastRecognition).not.toBeNull();

    const denied = notifyMock.mock.calls.find(
      (call) => (call[0] as { code?: ErrorCode }).code === ErrorCode.MIC_DENIED,
    );
    expect(denied).toBeDefined();

    // The panel was torn down (no host left in the document) and recognition
    // was aborted so nothing is captured (Req 16.5).
    expect(hostPresent()).toBe(false);
    expect(lastRecognition?.aborted).toBe(true);
  });

  it("notifies MIC_DENIED and tears the panel down when start() throws", () => {
    startBehaviour = "throw";

    runVoiceToText({ context: "generic-page", point: { x: 10, y: 10 } });

    const denied = notifyMock.mock.calls.find(
      (call) => (call[0] as { code?: ErrorCode }).code === ErrorCode.MIC_DENIED,
    );
    expect(denied).toBeDefined();
    expect(hostPresent()).toBe(false);
  });
});

// ===========================================================================
// registerVoiceTool() — installs the real handler in the catalog.
// ===========================================================================

describe("registerVoiceTool", () => {
  let original: Tool["run"];

  beforeEach(() => {
    original = getTool(ToolId.VOICE_TO_TEXT)!.run;
  });

  afterEach(() => {
    getTool(ToolId.VOICE_TO_TEXT)!.run = original;
  });

  it("replaces the placeholder stub with the real run handler", () => {
    expect(registerVoiceTool()).toBe(true);
    expect(getTool(ToolId.VOICE_TO_TEXT)!.run).toBe(runVoiceToText);
  });
});
