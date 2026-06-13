// Unit/snapshot tests for the popup global Toggle (task 24.2, Req 1.1).
//
// The popup (`src/popup/index.ts`) auto-mounts on import via
// `document.getElementById("app")`, so each test prepares an `#app` element and
// the surrounding `chrome.*` / settings mocks BEFORE dynamically importing the
// module (with `vi.resetModules()` so the import side effect re-runs against a
// fresh seed). `mountPopup` is not exported, so the import side effect is the
// only way to drive it — which is exactly how the popup behaves in the browser.
//
// We mock:
//   - "../shared/settings": `getEnabled` resolves a controllable value,
//     `setEnabled` is a spy, `onEnabledChanged` stores the callback so the test
//     can fire an external change.
//   - chrome.runtime.sendMessage: returns an empty NOTEPAD_LIST so the notepad
//     section renders without touching the background.
//   - window.matchMedia: jsdom doesn't implement it.
//   - "../ui/styles/tailwind.css": stubbed so the CSS import never reaches the
//     esbuild/Tailwind pipeline under the jsdom test environment.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module mocks (hoisted by vitest) --------------------------------------

// The compiled stylesheet is irrelevant to behavior and importing it through
// the Vite/Tailwind pipeline is unnecessary for a DOM unit test.
vi.mock("../ui/styles/tailwind.css", () => ({}));

// Controllable settings layer. `enabledSeed` is mutated per-test before import.
const settingsState: {
  enabledSeed: boolean;
  onEnabledChangedCb: ((enabled: boolean) => void) | null;
  setEnabled: ReturnType<typeof vi.fn>;
} = {
  enabledSeed: true,
  onEnabledChangedCb: null,
  setEnabled: vi.fn(),
};

vi.mock("../shared/settings", () => ({
  getEnabled: vi.fn(() => Promise.resolve(settingsState.enabledSeed)),
  getCachedEnabled: () => settingsState.enabledSeed,
  setEnabled: (...args: unknown[]) => settingsState.setEnabled(...args),
  onEnabledChanged: (cb: (enabled: boolean) => void) => {
    settingsState.onEnabledChangedCb = cb;
    return () => {
      settingsState.onEnabledChangedCb = null;
    };
  },
}));

// --- Test harness ----------------------------------------------------------

/** Install an `#app` mount point + the chrome/matchMedia ambient surface. */
function installPopupEnvironment(): void {
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      // The popup only sends NOTEPAD_LIST on mount; resolve an empty list.
      sendMessage: vi.fn(() => Promise.resolve({ ok: true, data: [] })),
      openOptionsPage: vi.fn(),
    },
  };

  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }
}

/**
 * Import the popup module fresh so its auto-mount side effect runs against the
 * current `#app` + mocks, then wait a microtask for the `getEnabled()` seed.
 */
async function mountFreshPopup(): Promise<void> {
  vi.resetModules();
  await import("./index");
  // Let the `void getEnabled().then(...)` seed resolve.
  await Promise.resolve();
  await Promise.resolve();
}

function getSwitch(): HTMLElement {
  const sw = document.querySelector('[role="switch"]');
  if (!sw) throw new Error("role=switch element not found in popup");
  return sw as HTMLElement;
}

beforeEach(() => {
  settingsState.enabledSeed = true;
  settingsState.onEnabledChangedCb = null;
  settingsState.setEnabled = vi.fn(() => Promise.resolve());
  installPopupEnvironment();
});

afterEach(() => {
  document.body.innerHTML = "";
  settingsState.onEnabledChangedCb = null;
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("popup global Toggle (Req 1.1)", () => {
  it("renders a role=switch control", async () => {
    await mountFreshPopup();
    const sw = getSwitch();
    expect(sw).toBeTruthy();
    expect(sw.getAttribute("role")).toBe("switch");
  });

  it("reflects enabled=true as aria-checked 'true' after seeding", async () => {
    settingsState.enabledSeed = true;
    await mountFreshPopup();
    expect(getSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("reflects enabled=false as aria-checked 'false' after seeding", async () => {
    settingsState.enabledSeed = false;
    await mountFreshPopup();
    expect(getSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("clicking the switch flips aria-checked and calls setEnabled with the new value", async () => {
    settingsState.enabledSeed = true;
    await mountFreshPopup();

    const sw = getSwitch();
    expect(sw.getAttribute("aria-checked")).toBe("true");

    sw.click();

    // Flipped from true -> false, persisted via setEnabled(false).
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(settingsState.setEnabled).toHaveBeenCalledTimes(1);
    expect(settingsState.setEnabled).toHaveBeenCalledWith(false);

    sw.click();
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(settingsState.setEnabled).toHaveBeenLastCalledWith(true);
  });

  it("updates the switch state when onEnabledChanged fires (external change)", async () => {
    settingsState.enabledSeed = true;
    await mountFreshPopup();
    const sw = getSwitch();
    expect(sw.getAttribute("aria-checked")).toBe("true");

    // Simulate another context turning the Toggle OFF.
    expect(settingsState.onEnabledChangedCb).toBeTypeOf("function");
    settingsState.onEnabledChangedCb?.(false);

    expect(sw.getAttribute("aria-checked")).toBe("false");
    // External reflection must NOT re-persist (no setEnabled call from setState).
    expect(settingsState.setEnabled).not.toHaveBeenCalled();
  });

  it("matches the two-state structural snapshot of the switch", async () => {
    settingsState.enabledSeed = false;
    await mountFreshPopup();
    const sw = getSwitch();

    expect({
      role: sw.getAttribute("role"),
      ariaChecked: sw.getAttribute("aria-checked"),
      type: (sw as HTMLButtonElement).type,
      hasLabelledBy: sw.hasAttribute("aria-labelledby"),
    }).toMatchInlineSnapshot(`
      {
        "ariaChecked": "false",
        "hasLabelledBy": true,
        "role": "switch",
        "type": "button",
      }
    `);
  });
});
