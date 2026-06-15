// Unit tests for the auto-copy-on-selection feature (autoCopy.ts).
//
// Verifies the drag-select → clipboard + notepad + notification flow, the green
// selection-style injection, and the Ctrl+Z undo of the last captured entry.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// notify renders into a closed Shadow DOM in production; spy on it here.
vi.mock("../../ui/notify", () => ({
  notify: vi.fn(() => ({ dismiss: () => {} })),
}));
import { notify } from "../../ui/notify";

// Control the Toggle's cached value used by the feature's gate.
vi.mock("../../shared/settings", () => ({
  getCachedEnabled: vi.fn(() => true),
  getCachedFeatureFlags: vi.fn(() => ({
    dragCopy: true,
    persistHighlight: true,
    notepadCapture: true,
    cookieRemoval: true,
  })),
}));
import { getCachedEnabled } from "../../shared/settings";

import { initAutoCopy } from "./autoCopy";
import { NotepadMessageType } from "../notepad/notepad";

/** Build a MouseEvent at a point. */
function mouse(type: string, x: number, y: number, button = 0): MouseEvent {
  return new MouseEvent(type, {
    button,
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
  });
}

/** Stub `getSelection().toString()` to return `text`. */
function setSelection(text: string): void {
  (globalThis as unknown as { getSelection: () => Selection }).getSelection =
    () => ({ toString: () => text }) as unknown as Selection;
}

let writeText: ReturnType<typeof vi.fn>;
let sendMessage: ReturnType<typeof vi.fn>;
/** Routes a sent message to a fake background response keyed by type. */
let appendId: string;

beforeEach(() => {
  vi.clearAllMocks();
  (getCachedEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
  writeText = vi.fn(() => Promise.resolve());
  Object.assign(navigator, { clipboard: { writeText } });
  setSelection("");
  appendId = "entry-1";

  sendMessage = vi.fn((message: { type: string }) => {
    if (message.type === NotepadMessageType.APPEND) {
      return Promise.resolve({
        ok: true,
        data: { entry: { id: appendId }, quotaExceeded: false },
      });
    }
    if (message.type === NotepadMessageType.REMOVE) {
      return Promise.resolve({ ok: true, data: { removed: true } });
    }
    return Promise.resolve({ ok: true, data: {} });
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: "test", sendMessage, lastError: undefined },
  };
  document.head.innerHTML = "";
});

afterEach(() => {
  setSelection("");
  document.head.innerHTML = "";
});

/** Flush a few microtasks so the async capture chain settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("auto-copy on drag selection", () => {
  it("injects the green ::selection style while active and removes it on detach", () => {
    const detach = initAutoCopy(document);
    const style = document.getElementById("acx-autocopy-selection-style");
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain("#ffd913");
    detach();
    expect(document.getElementById("acx-autocopy-selection-style")).toBeNull();
  });

  it("copies to clipboard AND appends to the notepad after a drag", async () => {
    const detach = initAutoCopy(document);
    setSelection("hello world");

    document.dispatchEvent(mouse("mousedown", 10, 10));
    document.dispatchEvent(mouse("mouseup", 80, 30));
    await flush();

    expect(writeText).toHaveBeenCalledWith("hello world");
    const sentTypes = sendMessage.mock.calls.map((c) => c[0].type);
    expect(sentTypes).toContain(NotepadMessageType.APPEND);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "success" }),
    );
    detach();
  });

  it("does NOT copy on a plain click (no pointer travel)", async () => {
    const detach = initAutoCopy(document);
    setSelection("lingering");

    document.dispatchEvent(mouse("mousedown", 10, 10));
    document.dispatchEvent(mouse("mouseup", 11, 11));
    await flush();

    expect(writeText).not.toHaveBeenCalled();
    detach();
  });

  it("does NOT copy when the selection is empty/whitespace", async () => {
    const detach = initAutoCopy(document);
    setSelection("   ");

    document.dispatchEvent(mouse("mousedown", 10, 10));
    document.dispatchEvent(mouse("mouseup", 90, 50));
    await flush();

    expect(writeText).not.toHaveBeenCalled();
    detach();
  });

  it("ignores non-left mouse buttons", async () => {
    const detach = initAutoCopy(document);
    setSelection("right drag");

    document.dispatchEvent(mouse("mousedown", 10, 10, 2));
    document.dispatchEvent(mouse("mouseup", 90, 50, 2));
    await flush();

    expect(writeText).not.toHaveBeenCalled();
    detach();
  });

  it("does nothing while the Toggle is OFF", async () => {
    (getCachedEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      false,
    );
    const detach = initAutoCopy(document);
    setSelection("disabled");

    document.dispatchEvent(mouse("mousedown", 10, 10));
    document.dispatchEvent(mouse("mouseup", 90, 50));
    await flush();

    expect(writeText).not.toHaveBeenCalled();
    detach();
  });

  it("Ctrl+Z after a capture removes the last notepad entry", async () => {
    const detach = initAutoCopy(document);
    setSelection("oops");

    document.dispatchEvent(mouse("mousedown", 10, 10));
    document.dispatchEvent(mouse("mouseup", 90, 50));
    await flush();

    // Undo while not editing a field.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
    );
    await flush();

    const removeCall = sendMessage.mock.calls.find(
      (c) => c[0].type === NotepadMessageType.REMOVE,
    );
    expect(removeCall).toBeDefined();
    expect(removeCall?.[0].payload).toEqual({ id: "entry-1" });
    detach();
  });

  it("Ctrl+Z does NOT undo when there is nothing captured yet", async () => {
    const detach = initAutoCopy(document);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
    );
    await flush();
    const removeCall = sendMessage.mock.calls.find(
      (c) => c[0].type === NotepadMessageType.REMOVE,
    );
    expect(removeCall).toBeUndefined();
    detach();
  });

  it("disposer removes the listeners (no copy after detach)", async () => {
    const detach = initAutoCopy(document);
    detach();
    setSelection("after detach");

    document.dispatchEvent(mouse("mousedown", 10, 10));
    document.dispatchEvent(mouse("mouseup", 90, 50));
    await flush();

    expect(writeText).not.toHaveBeenCalled();
  });
});
