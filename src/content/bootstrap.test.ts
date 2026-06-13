// Regression test for the middle-click panel not opening (crxjs bootstrap bug).
//
// The crxjs content-script loader does NOT rely on top-level module execution —
// it dynamically imports the content entry chunk and calls the exported
// `onExecute`. The content entry's bare top-level `bootstrapContent()` call is
// tree-shaken out of the production bundle (the module otherwise only has
// exports), so WITHOUT an `onExecute` export the content script loads but never
// wires up the middle-click trigger and the radial Options_Panel never opens.
//
// These tests lock in the crxjs contract:
//   1. `src/content/index.ts` exports an `onExecute` function (the loader hook).
//   2. Invoking `onExecute()` / `bootstrapContent()` is idempotent — the
//      middle-click trigger is attached exactly once even if both the loader
//      hook and a top-level evaluation run.
//
// We mock the heavy dependencies so importing the entry is cheap and
// side-effect-light, and spy on `attachPanelTrigger` (the function that wires
// the middle-click → openPanel handler) to assert it is wired exactly once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ----------------------------------------------------------------
// The panel module: spy on attachPanelTrigger so we can count how many times
// the middle-click trigger is wired.
const attachPanelTrigger = vi.hoisted(() => vi.fn(() => () => {}));
const closePanel = vi.hoisted(() => vi.fn());
vi.mock("./optionsPanel", () => ({
  attachPanelTrigger,
  closePanel,
}));

// Settings: enabled by default so bootstrap attaches the trigger.
vi.mock("../shared/settings", () => ({
  getEnabled: () => Promise.resolve(true),
  getCachedEnabled: () => true,
  onEnabledChanged: () => () => {},
}));

// Cookie removal: no-op.
vi.mock("../tools/cookies/cookieRemover", () => ({
  initCookieRemoval: vi.fn(),
  teardownCookieRemoval: vi.fn(),
}));

// Notepad capture: no-op disposer.
vi.mock("../tools/notepad/notepad", () => ({
  initNotepadCapture: vi.fn(() => () => {}),
  registerNotepadTool: vi.fn(),
}));

// Every other tool registration is a harmless no-op for this test.
vi.mock("./tabsTools", () => ({ registerTabsTools: vi.fn() }));
vi.mock("../tools/screenshot/screenshotTool", () => ({ registerScreenshotTool: vi.fn() }));
vi.mock("../tools/image/imageTool", () => ({ registerImageTool: vi.fn() }));
vi.mock("../tools/search/searchTool", () => ({ registerSearchTool: vi.fn() }));
vi.mock("../tools/media/mediaTool", () => ({ registerMediaTool: vi.fn() }));
vi.mock("../tools/color/colorTool", () => ({ registerColorTool: vi.fn() }));
vi.mock("../tools/ocr/ocrTool", () => ({ registerOcrTool: vi.fn() }));
vi.mock("../tools/voice/voiceTool", () => ({ registerVoiceTool: vi.fn() }));
vi.mock("../tools/tabs/tabShifterTool", () => ({ registerTabShifterTool: vi.fn() }));
vi.mock("../tools/scroll/scrollTool", () => ({ registerHorizontalScrollTool: vi.fn() }));

beforeEach(() => {
  attachPanelTrigger.mockClear();
  closePanel.mockClear();
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("content-script bootstrap (middle-click wiring regression)", () => {
  it("exports an `onExecute` hook for the crxjs content-script loader", async () => {
    const mod = await import("./index");
    expect(typeof mod.onExecute).toBe("function");
  });

  it("wires the middle-click trigger when the entry module is imported", async () => {
    await import("./index");
    // The top-level bootstrap (kept as a guaranteed side effect) attaches the
    // middle-click trigger exactly once.
    expect(attachPanelTrigger).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: calling onExecute after import does not re-attach the trigger", async () => {
    const mod = await import("./index");
    expect(attachPanelTrigger).toHaveBeenCalledTimes(1);

    // The crxjs loader calls onExecute(); it must NOT attach a second handler.
    mod.onExecute();
    mod.onExecute();
    expect(attachPanelTrigger).toHaveBeenCalledTimes(1);
  });
});
