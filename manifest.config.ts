import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

// Finalized MV3 manifest for Alpha Cursor (task 26.3). The declared permission
// set is the MINIMAL set actually exercised by the implemented features
// (Req 21.1) — every entry below is justified by real `chrome.*` usage in
// `src/`. Nothing speculative is declared; capabilities the codebase does not
// call (e.g. `scripting`, `cookies`, `clipboardWrite`, `bookmarks`) are
// deliberately omitted.
//
// All executable assets (jsPDF, tesseract WASM + worker + trained-data) ship
// inside the package and are referenced via `chrome.runtime.getURL`; nothing is
// loaded as remote code (Req 22.2). The background is an ephemeral MV3 service
// worker, not a persistent page (Req 22.1). crxjs handles emitting bundled
// inputs and copying `public/` assets verbatim.
export default defineManifest({
  manifest_version: 3,
  name: "Alpha Cursor",
  version: pkg.version,
  description: pkg.description,

  // MV3 background is an ephemeral service worker (Req 22.1). crxjs rewrites this
  // TS entry into the bundled service worker output.
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },

  // Toolbar popup surface (global Toggle, compact notepad, Copy All).
  action: {
    default_title: "Alpha Cursor",
    default_popup: "src/popup/index.html",
  },

  // Full configuration + privacy statement surface.
  options_page: "src/options/index.html",

  // The content script owns all page-DOM/cursor concerns. Registered for all
  // pages so the middle-click Options_Panel is available everywhere.
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],

  // Minimal, finalized permission set (Req 21.1). Each is required by an
  // implemented feature:
  //   - "storage":   backs the Toggle, settings, local identity, notepad
  //                  metadata, tab folders, and operation checkpoints via
  //                  `chrome.storage.sync`/`chrome.storage.local` (Req 22.5).
  //   - "tabs":      backs Save/Restore/Shift tabs (`chrome.tabs.query`,
  //                  `chrome.tabs.update`, `chrome.tabs.create`) and the OCR
  //                  (Tool 10) + full-page screenshot (Tool 4)
  //                  `chrome.tabs.captureVisibleTab` rasterization.
  //   - "downloads": backs the automatic `chrome.downloads.download` used by the
  //                  Save-Image (Tool 5), Media Downloader (Tool 8), and
  //                  full-page screenshot (Tool 4) download bridges.
  // NOT declared: the microphone (Tool 11) is NOT a manifest permission — it is
  // a browser-managed runtime grant prompted at point of use via the Web Speech
  // API / `getUserMedia` (Req 21.2), and its denial is handled gracefully
  // (Req 21.3). `chrome.windows.update` (best-effort tab-shifter focus) needs no
  // permission. No `chrome.scripting` usage exists, so it is omitted.
  permissions: ["storage", "tabs", "downloads"],

  // Host permission for `chrome.tabs.captureVisibleTab` (Tool 4 screenshot,
  // Tool 10 OCR), which requires host access to the captured page, and for the
  // content script to operate on every page. The extension genuinely functions
  // across all sites, so `<all_urls>` is the honest, minimal host declaration
  // rather than a narrower set that would silently break capture on most pages.
  host_permissions: ["<all_urls>"],

  // Bundled tesseract.js OCR assets (Tool 10, Req 15) are loaded by a Web Worker
  // spawned from the content script and must be reachable via
  // `chrome.runtime.getURL`. They ship under `public/tesseract/` and are copied
  // verbatim into the package by crxjs/Vite. Exposing them locally keeps OCR
  // 100% client-side with no remote code (Req 22.2).
  web_accessible_resources: [
    {
      resources: ["tesseract/*"],
      matches: ["<all_urls>"],
    },
  ],

  icons: {},
});
