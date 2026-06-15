/**
 * Tasks 10.6 + 10.7 — tests for the radial Options_Panel (`optionsPanel.ts`).
 *
 * 10.6 — Property 3: Panel stays within the viewport (Req 2.8). Property-tests
 *   the PURE {@link repositionPanel} geometry across arbitrary points, panel
 *   sizes (including oversized), and viewports.
 *
 * 10.7 — Unit tests for open/close behavior (Req 1.3, 2.9, 2.10):
 *   middle-click opens only when the Toggle is enabled, Escape closes,
 *   outside-click closes, selecting a tool closes + invokes the tool, and
 *   non-middle buttons do not open.
 *
 * Closed-shadow-root limitation
 * -----------------------------
 * The panel mounts inside a CLOSED shadow root (`attachShadow({mode:"closed"})`)
 * on a host carrying `data-acx-ui="options-panel"`. A closed root is NOT
 * reachable via `host.shadowRoot` (it is `null`, matching real browsers), so:
 *   - host presence/absence is asserted from the document via
 *     `document.querySelector('[data-acx-ui="options-panel"]')`, and
 *   - to inspect the panel's inner buttons we capture the `ShadowRoot` returned
 *     by `attachShadow` with a prototype spy (the same technique as the notify
 *     test) rather than reading `host.shadowRoot`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import fc from "fast-check";

import { repositionPanel } from "./optionsPanel";

// ---------------------------------------------------------------------------
// Mock the Toggle gate. `optionsPanel.ts` imports `getCachedEnabled` from
// `../shared/settings`; we mock that single export so we don't need a chrome
// fake. The hoisted flag is flipped per-test to enable/disable the trigger.
// ---------------------------------------------------------------------------
const toggle = vi.hoisted(() => ({ enabled: true }));
vi.mock("../shared/settings", () => ({
  getCachedEnabled: () => toggle.enabled,
  // shadowHost (used by the panel) reads the theme preference.
  getCachedTheme: () => ({ mode: "light", background: "mint" }),
  getTheme: () => Promise.resolve({ mode: "light", background: "mint" }),
  onThemeChanged: () => () => {},
}));

// ===========================================================================
// Task 10.6 — Property 3
// ===========================================================================

// Feature: alpha-cursor-extension, Property 3: Panel stays within the viewport
describe("repositionPanel (Property 3)", () => {
  const pointArb = fc.record({
    x: fc.integer({ min: -500, max: 3000 }),
    y: fc.integer({ min: -500, max: 3000 }),
  });
  const sizeArb = fc.record({
    width: fc.integer({ min: 0, max: 3000 }),
    height: fc.integer({ min: 0, max: 3000 }),
  });
  // Viewport has at least 1px on each axis (a real viewport is never 0×0).
  const viewportArb = fc.record({
    width: fc.integer({ min: 1, max: 2000 }),
    height: fc.integer({ min: 1, max: 2000 }),
  });

  // Validates: Requirements 2.8
  it("keeps the panel within the viewport when it fits, and pins oversized axes to 0", () => {
    fc.assert(
      fc.property(pointArb, sizeArb, viewportArb, (point, size, viewport) => {
        const origin = repositionPanel(point, size, viewport);

        // The origin is always on-screen (non-negative on both axes).
        expect(origin.x).toBeGreaterThanOrEqual(0);
        expect(origin.y).toBeGreaterThanOrEqual(0);

        // X axis: when the panel fits, the far edge stays within the viewport;
        // when it is wider than the viewport (degenerate), it pins to 0.
        if (size.width <= viewport.width) {
          expect(origin.x + size.width).toBeLessThanOrEqual(viewport.width);
        } else {
          expect(origin.x).toBe(0);
        }

        // Y axis: same containment / pinning guarantee.
        if (size.height <= viewport.height) {
          expect(origin.y + size.height).toBeLessThanOrEqual(viewport.height);
        } else {
          expect(origin.y).toBe(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Task 10.7 — open/close unit tests (Req 1.3, 2.9, 2.10)
// ===========================================================================

describe("Options_Panel open/close (Req 1.3, 2.9, 2.10)", () => {
  const HOST_SELECTOR = '[data-acx-ui="options-panel"]';

  // Imported lazily after mocks/spies are installed so module-level state is
  // the genuine singleton from optionsPanel.ts.
  let openPanel: typeof import("./optionsPanel").openPanel;
  let closePanel: typeof import("./optionsPanel").closePanel;
  let isPanelOpen: typeof import("./optionsPanel").isPanelOpen;
  let attachPanelTrigger: typeof import("./optionsPanel").attachPanelTrigger;
  let registerTool: typeof import("./tools").registerTool;
  let getTool: typeof import("./tools").getTool;
  let ToolId: typeof import("./tools").ToolId;

  // Captured closed shadow roots, latest = the currently open panel's root.
  let capturedRoots: ShadowRoot[] = [];
  const realAttachShadow = Element.prototype.attachShadow;

  function host(): Element | null {
    return document.querySelector(HOST_SELECTOR);
  }

  function panelRoot(): ShadowRoot {
    const root = capturedRoots[capturedRoots.length - 1];
    if (!root) throw new Error("no panel shadow root captured");
    return root;
  }

  function installMatchMedia(): void {
    // jsdom lacks matchMedia; stub it so any notify() from a stub tool is safe.
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

  beforeEach(async () => {
    vi.useFakeTimers();
    toggle.enabled = true;
    capturedRoots = [];
    document.body.innerHTML = "";
    installMatchMedia();

    // Capture closed shadow roots so we can read the panel's inner buttons.
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
      this: Element,
      init: ShadowRootInit,
    ): ShadowRoot {
      const root = realAttachShadow.call(this, init);
      capturedRoots.push(root);
      return root;
    });

    const panelMod = await import("./optionsPanel");
    openPanel = panelMod.openPanel;
    closePanel = panelMod.closePanel;
    isPanelOpen = panelMod.isPanelOpen;
    attachPanelTrigger = panelMod.attachPanelTrigger;

    const toolsMod = await import("./tools");
    registerTool = toolsMod.registerTool;
    getTool = toolsMod.getTool;
    ToolId = toolsMod.ToolId;
  });

  afterEach(() => {
    closePanel();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  // -- middle-click open, gated by the Toggle (Req 1.3) ---------------------

  it("opens the panel on a middle-button mousedown ONLY when enabled (Req 1.3)", () => {
    toggle.enabled = true;
    const detach = attachPanelTrigger(window);

    window.dispatchEvent(
      new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true }),
    );

    expect(host()).not.toBeNull();
    expect(isPanelOpen()).toBe(true);

    detach();
  });

  it("does NOT open on middle-click while the Toggle is OFF (Req 1.2/1.3)", () => {
    toggle.enabled = false;
    const detach = attachPanelTrigger(window);

    window.dispatchEvent(
      new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true }),
    );

    expect(host()).toBeNull();
    expect(isPanelOpen()).toBe(false);

    detach();
  });

  it("does NOT open on a non-middle (left) button mousedown", () => {
    toggle.enabled = true;
    const detach = attachPanelTrigger(window);

    window.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }),
    );

    expect(host()).toBeNull();
    expect(isPanelOpen()).toBe(false);

    detach();
  });

  // -- Escape closes (Req 2.9) ----------------------------------------------

  it("closes the panel when Escape is pressed (Req 2.9)", () => {
    openPanel("generic-page", { x: 10, y: 10 });
    expect(host()).not.toBeNull();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(host()).toBeNull();
    expect(isPanelOpen()).toBe(false);
  });

  // -- outside-click closes (Req 2.9) ---------------------------------------

  it("closes the panel on an outside mousedown after the open click settles (Req 2.9)", () => {
    openPanel("generic-page", { x: 10, y: 10 });
    expect(host()).not.toBeNull();

    // The outside handler is attached via setTimeout(…, 0) so the opening click
    // doesn't immediately close it. Advance fake timers to register it.
    vi.advanceTimersByTime(0);

    // A mousedown whose composed path excludes the panel host is "outside".
    document.body.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, bubbles: true }),
    );

    expect(host()).toBeNull();
    expect(isPanelOpen()).toBe(false);
  });

  it("does NOT close on the same-tick opening click (outside handler deferred)", () => {
    openPanel("generic-page", { x: 10, y: 10 });

    // Before the deferred attach fires, an outside mousedown must not close it.
    document.body.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, bubbles: true }),
    );

    expect(host()).not.toBeNull();
    expect(isPanelOpen()).toBe(true);
  });

  // -- select a tool closes + invokes run (Req 2.10) ------------------------

  it("closes the panel and invokes the selected tool's run on click (Req 2.10)", () => {
    // NOTEPAD_COPY_ALL is context-independent, so it appears for generic-page.
    const id = ToolId.NOTEPAD_COPY_ALL;
    const original = getTool(id)!.run;
    const spyRun = vi.fn();
    registerTool(id, spyRun);

    try {
      openPanel("generic-page", { x: 10, y: 10 });
      expect(host()).not.toBeNull();

      // Find the "Copy All" tool button inside the captured closed root.
      const button = panelRoot().querySelector<HTMLButtonElement>(
        'button[aria-label="Copy All"]',
      );
      expect(button).not.toBeNull();

      button!.click();

      // Selecting closes the panel...
      expect(host()).toBeNull();
      expect(isPanelOpen()).toBe(false);
      // ...and invokes the tool's run with the resolved context + point.
      expect(spyRun).toHaveBeenCalledTimes(1);
      expect(spyRun.mock.calls[0]![0]).toMatchObject({
        context: "generic-page",
        point: { x: 10, y: 10 },
      });
    } finally {
      registerTool(id, original);
    }
  });

  // -- closed-shadow-root invariant -----------------------------------------

  it("mounts the panel in a CLOSED shadow root not reachable via host.shadowRoot", () => {
    openPanel("generic-page", { x: 10, y: 10 });

    const h = host()!;
    expect(h).not.toBeNull();
    // Closed roots are hidden from the host element (jsdom + real browsers).
    expect(h.shadowRoot).toBeNull();
    // But the panel content lives in the captured closed root.
    expect(panelRoot().querySelector('[role="menu"]')).not.toBeNull();
  });
});
