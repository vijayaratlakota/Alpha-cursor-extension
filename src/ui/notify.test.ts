import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HOST_ATTRIBUTE } from "./shadowHost";
import { ErrorCode } from "../shared/messaging";

/**
 * Task 7.2 — Unit/snapshot test for the Notification (toast) system.
 *
 * _Requirements: 20.1 (transient Notion-styled toast rendered inside the
 * content-script Shadow DOM)._
 *
 * Approach & closed-shadow-root limitation
 * ----------------------------------------
 * `notify()` mounts its toast stack inside a CLOSED shadow root
 * (`attachShadow({ mode: "closed" })`). A closed root is intentionally NOT
 * reachable from the host element via `element.shadowRoot` (jsdom returns
 * `null`, matching real browsers). So we test two complementary layers:
 *
 *  1. Observable lifecycle — purely from the document: that a host element
 *     carrying `data-acx-ui="toast"` is appended on `notify()`, survives while
 *     any toast is live, and is torn down once the last toast leaves (manual
 *     `dismiss()` or auto-dismiss via fake timers).
 *
 *  2. Inner structure / ARIA roles / text (Req 20.1) — to read the closed
 *     root's content we capture the `ShadowRoot` returned by `attachShadow`
 *     using a prototype spy. This is the only sanctioned way to inspect closed
 *     shadow content; we do not rely on `host.shadowRoot` (which is null).
 *
 * Determinism: `window.matchMedia` is mocked (jsdom does not implement it).
 * Reduced motion is forced ON for lifecycle tests so dismissal is synchronous
 * and timer-based (no `requestAnimationFrame`/`transitionend` dependence),
 * keeping fake-timer advancement exact.
 */

// Fresh module state per test (the notify module keeps a module-level host +
// live-count). Imported dynamically in beforeEach after resetModules.
let notify: typeof import("./notify").notify;
let DEFAULT_DURATION_MS: number;

// Captured closed shadow roots, in creation order (latest = current toast host).
let capturedRoots: ShadowRoot[] = [];

// Toggle controlling the mocked `prefers-reduced-motion` result.
let reducedMotion = true;

function installMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: reducedMotion,
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

function hosts(): Element[] {
  return Array.from(document.querySelectorAll(`[${HOST_ATTRIBUTE}="toast"]`));
}

function currentRoot(): ShadowRoot {
  const root = capturedRoots[capturedRoots.length - 1];
  if (!root) throw new Error("no shadow root captured yet");
  return root;
}

/** Toast elements inside the current closed root (excludes the stack region). */
function toasts(): HTMLElement[] {
  return Array.from(
    currentRoot().querySelectorAll<HTMLElement>(
      '[role="status"], [role="alert"]',
    ),
  );
}

/** The single live toast; throws if there is not exactly one. */
function onlyToast(): HTMLElement {
  const list = toasts();
  if (list.length !== 1) {
    throw new Error(`expected exactly one toast, found ${list.length}`);
  }
  return list[0]!;
}

const realAttachShadow = Element.prototype.attachShadow;

beforeEach(async () => {
  vi.useFakeTimers();
  reducedMotion = true;
  capturedRoots = [];
  document.body.innerHTML = "";

  installMatchMedia();

  // Capture closed shadow roots so we can inspect toast content/roles.
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ): ShadowRoot {
    const root = realAttachShadow.call(this, init);
    capturedRoots.push(root);
    return root;
  });

  // Fresh module-level state (host/liveCount) for every test.
  vi.resetModules();
  const mod = await import("./notify");
  notify = mod.notify;
  DEFAULT_DURATION_MS = mod.DEFAULT_DURATION_MS;
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("notify() — host lifecycle (observable from the document)", () => {
  it("appends a single toast host (data-acx-ui=\"toast\") on the first notify()", () => {
    expect(hosts()).toHaveLength(0);

    notify({ kind: "info", text: "Hello" });

    expect(hosts()).toHaveLength(1);
  });

  it("auto-dismisses after DEFAULT_DURATION_MS, tearing the host down once empty", () => {
    notify({ text: "Auto goes away" });
    expect(hosts()).toHaveLength(1);

    // Just before the deadline the host is still present.
    vi.advanceTimersByTime(DEFAULT_DURATION_MS - 1);
    expect(hosts()).toHaveLength(1);

    // Crossing the deadline removes the toast; reduced motion makes removal
    // synchronous, so the now-empty host is torn down.
    vi.advanceTimersByTime(1);
    expect(hosts()).toHaveLength(0);
  });

  it("manual dismiss() removes the toast and tears the host down", () => {
    const handle = notify({ text: "Dismiss me", durationMs: 0 });
    expect(hosts()).toHaveLength(1);

    // durationMs <= 0 means no auto-dismiss timer; the toast stays until manual.
    vi.advanceTimersByTime(60_000);
    expect(hosts()).toHaveLength(1);

    handle.dismiss();
    expect(hosts()).toHaveLength(0);
  });

  it("dismiss() is idempotent", () => {
    const handle = notify({ text: "Once", durationMs: 0 });
    handle.dismiss();
    expect(hosts()).toHaveLength(0);

    // Second call must be a no-op (no throw, host stays gone).
    expect(() => handle.dismiss()).not.toThrow();
    expect(hosts()).toHaveLength(0);
  });

  it("keeps a single shared host while multiple toasts are live and removes it only when the last is dismissed", () => {
    const a = notify({ kind: "success", text: "First", durationMs: 0 });
    const b = notify({ kind: "error", text: "Second", durationMs: 0 });

    // Two toasts, but a single shared host.
    expect(hosts()).toHaveLength(1);
    expect(toasts()).toHaveLength(2);

    a.dismiss();
    expect(hosts()).toHaveLength(1); // one toast remains -> host stays

    b.dismiss();
    expect(hosts()).toHaveLength(0); // stack empty -> host torn down
  });
});

describe("notify() — toast structure and ARIA roles (Req 20.1, via captured closed root)", () => {
  it("renders success/info toasts with role=status and aria-live=polite", () => {
    notify({ kind: "success", text: "Saved", durationMs: 0 });

    const toast = onlyToast();
    expect(toast.getAttribute("role")).toBe("status");
    expect(toast.getAttribute("aria-live")).toBe("polite");
    expect(toast.textContent).toContain("Saved");
  });

  it("renders error toasts with role=alert and aria-live=assertive", () => {
    notify({ kind: "error", text: "It broke", durationMs: 0 });

    const toast = onlyToast();
    expect(toast.getAttribute("role")).toBe("alert");
    expect(toast.getAttribute("aria-live")).toBe("assertive");
  });

  it("defaults to the info kind (role=status) when no kind is given", () => {
    notify({ text: "Plain", durationMs: 0 });

    expect(onlyToast().getAttribute("role")).toBe("status");
  });

  it("renders the message text and an optional error code suffix", () => {
    notify({
      kind: "error",
      text: "Capture failed",
      code: ErrorCode.CAPTURE_FAILED,
      durationMs: 0,
    });

    const toast = onlyToast();
    expect(toast.textContent).toContain("Capture failed");
    expect(toast.textContent).toContain(ErrorCode.CAPTURE_FAILED);
  });

  it("mounts the toast inside a CLOSED shadow root not reachable via host.shadowRoot", () => {
    notify({ text: "Closed", durationMs: 0 });

    const host = hosts()[0]!;
    // Closed roots are hidden from the host element (jsdom + real browsers).
    expect(host.shadowRoot).toBeNull();
    // But the content lives in the captured closed root.
    expect(toasts()).toHaveLength(1);
  });
});

describe("notify() — reduced motion (Req 20.6, kept deterministic)", () => {
  it("under reduced motion the toast has no entrance transition styling", () => {
    reducedMotion = true;
    notify({ text: "No motion", durationMs: 0 });

    const toast = onlyToast();
    // The reduced-motion path skips the opacity/transform/transition setup.
    expect(toast.style.transition).toBe("");
    expect(toast.style.opacity).toBe("");
    expect(toast.style.transform).toBe("");
  });
});
