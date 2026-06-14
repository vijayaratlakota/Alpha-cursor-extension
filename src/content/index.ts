// Content script entry point. Owns page-DOM/cursor concerns: middle-click
// interception, context resolution, the Shadow-DOM Options_Panel, copy capture,
// cookie-popup removal, OCR, color picking, horizontal scroll, and voice UI.
//
// On load it (1) registers every tool's real `run` handler into the
// Options_Panel catalog (replacing the "coming soon" stubs), (2) arms the
// always-on, automatic features (notepad copy capture + cookie-consent removal)
// which self-gate on the Toggle, and (3) wires the middle-click trigger that
// opens the radial Options_Panel — attached when the Toggle is ON and detached
// when it flips OFF so the browser's default middle-click proceeds (Req 1.2,
// 1.3, 1.6). The Toggle is read on load and observed via `onEnabledChanged`.

import {
  getEnabled,
  getCachedEnabled,
  onEnabledChanged,
  getFeatureFlags,
  getCachedFeatureFlags,
  onFeatureFlagsChanged,
} from "../shared/settings";
import {
  attachPanelTrigger,
  closePanel,
  type DetachPanelTrigger,
} from "./optionsPanel";

// Tool registrations (middle-click Options_Panel entries).
import {
  initNotepadCapture,
  registerNotepadTool,
  type DetachNotepadCapture,
} from "../tools/notepad/notepad";
// Automatic content feature: copy text to the clipboard on left-drag selection.
import { initAutoCopy, type DetachAutoCopy } from "../tools/autocopy/autoCopy";
import { registerTabsTools } from "./tabsTools";
import { registerScreenshotTool } from "../tools/screenshot/screenshotTool";
import { registerImageTool } from "../tools/image/imageTool";
import { registerSearchTool } from "../tools/search/searchTool";
import { registerMediaTool } from "../tools/media/mediaTool";
import { registerColorTool } from "../tools/color/colorTool";
import { registerOcrTool } from "../tools/ocr/ocrTool";
import { registerVoiceTool } from "../tools/voice/voiceTool";
import { registerTabShifterTool } from "../tools/tabs/tabShifterTool";
import { registerHorizontalScrollTool } from "../tools/scroll/scrollTool";

// Automatic (non-panel) feature: cookie-consent popup removal.
import {
  initCookieRemoval,
  teardownCookieRemoval,
} from "../tools/cookies/cookieRemover";

/** Current panel-trigger disposer while attached, else null. */
let detachTrigger: DetachPanelTrigger | null = null;
/** Current notepad copy-capture disposer while attached, else null. */
let detachNotepadCapture: DetachNotepadCapture | null = null;
/** Current auto-copy-on-selection disposer while attached, else null. */
let detachAutoCopy: DetachAutoCopy | null = null;

/**
 * Register every tool's real behavior into the Options_Panel catalog. Each
 * `registerTool` call replaces that tool's placeholder stub. Runs once on load;
 * the panel reads the current handler at open time, so registering eagerly is
 * safe regardless of Toggle state.
 */
function registerAllTools(): void {
  registerNotepadTool(); // Tool 1 — Copy All
  registerTabsTools(); // Tools 2 & 3 — Save / Restore tabs
  registerScreenshotTool(); // Tool 4 — Full page screenshot
  registerImageTool(); // Tool 5 — Save image with enhancement
  // Tool 6 (cookie removal) is automatic, not a panel entry.
  registerSearchTool(); // Tool 7 — Search selected text
  registerMediaTool(); // Tool 8 — Media downloader
  registerColorTool(); // Tool 9 — Color picker
  registerOcrTool(); // Tool 10 — OCR text extraction
  registerVoiceTool(); // Tool 11 — Voice to text
  registerTabShifterTool(); // Tool 12 — Tab shifter
  registerHorizontalScrollTool(); // Horizontal scroll
}

/** Attach the middle-click trigger + per-feature automatic captures. */
function enableActive(): void {
  if (!detachTrigger) {
    detachTrigger = attachPanelTrigger(window);
  }
  reconcileFeatures();
}

/** Detach the middle-click trigger + all automatic captures (close any panel). */
function disableActive(): void {
  if (detachTrigger) {
    detachTrigger();
    detachTrigger = null;
    closePanel();
  }
  if (detachNotepadCapture) {
    detachNotepadCapture();
    detachNotepadCapture = null;
  }
  if (detachAutoCopy) {
    detachAutoCopy();
    detachAutoCopy = null;
  }
}

/**
 * Attach/detach each AUTOMATIC content feature according to its per-feature
 * flag (only meaningful while the global Toggle is ON). Idempotent: re-running
 * on a flag change attaches newly-enabled features and detaches disabled ones.
 */
function reconcileFeatures(): void {
  if (!getCachedEnabled()) return;
  const flags = getCachedFeatureFlags();

  // Notepad copy-capture (Ctrl+C → notepad history).
  if (flags.notepadCapture && !detachNotepadCapture) {
    detachNotepadCapture = initNotepadCapture();
  } else if (!flags.notepadCapture && detachNotepadCapture) {
    detachNotepadCapture();
    detachNotepadCapture = null;
  }

  // Drag-to-copy (highlight → clipboard + notepad).
  if (flags.dragCopy && !detachAutoCopy) {
    detachAutoCopy = initAutoCopy();
  } else if (!flags.dragCopy && detachAutoCopy) {
    detachAutoCopy();
    detachAutoCopy = null;
  }
}

/** Reconcile Toggle-gated active features with the current enabled state. */
function applyEnabled(enabled: boolean): void {
  if (enabled) {
    enableActive();
  } else {
    disableActive();
  }
}

/**
 * Content-script bootstrap. Registers all tool handlers, arms the automatic
 * cookie-consent removal (which self-gates on the Toggle), reconciles the
 * Toggle-gated active features, and subscribes to cross-context Toggle changes
 * so every tab reacts within one event loop (Req 1.2, 1.3, 1.6).
 */
/** Guard so the content script bootstraps exactly once per page. */
let bootstrapped = false;

export function bootstrapContent(): void {
  // Idempotent: crxjs's content-script loader calls the exported `onExecute`
  // (below) AND some contexts run the top-level call, so guard against a
  // double bootstrap which would attach the middle-click trigger twice.
  if (bootstrapped) return;
  bootstrapped = true;

  console.debug("[Alpha Cursor] content script bootstrapped");

  registerAllTools();

  // Cookie removal manages its own Toggle subscription internally.
  initCookieRemoval();

  // Reconcile immediately from the cache so features are live without waiting
  // on storage, then refine once the persisted value resolves.
  applyEnabled(getCachedEnabled());
  void getEnabled()
    .then(applyEnabled)
    .catch(() => {
      /* default-enabled cache already applied; storage errors surface elsewhere */
    });

  // Load per-feature flags and re-reconcile the automatic features once known,
  // then react to any later flag change (Options page toggles).
  void getFeatureFlags()
    .then(() => reconcileFeatures())
    .catch(() => {
      /* default all-on cache already applied */
    });
  onFeatureFlagsChanged(() => reconcileFeatures());

  onEnabledChanged(applyEnabled);
}

/**
 * crxjs content-script entry hook. The generated content-script loader
 * dynamically imports this module and invokes the exported `onExecute`, so the
 * bootstrap MUST run from here — a bare top-level `bootstrapContent()` call is
 * tree-shaken out of the production bundle because the module only has exports.
 * Keeping bootstrap behind `onExecute` is the crxjs contract that guarantees
 * the middle-click trigger and automatic features actually wire up on every page.
 */
export function onExecute(): void {
  bootstrapContent();
}

// Also run on direct module evaluation (non-crxjs contexts: tests, manual
// injection). Idempotency makes this safe alongside the `onExecute` call.
bootstrapContent();

// Re-export teardown so future cleanup paths / tests can fully detach the
// content script's automatic features.
export { teardownCookieRemoval };
