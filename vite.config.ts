import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

// Absolute path to the OCR offscreen document HTML. It is not referenced by any
// manifest field (offscreen docs are created at runtime via chrome.offscreen),
// so it must be declared as an explicit Rollup input to be built + emitted.
const offscreenHtml = fileURLToPath(
  new URL("./src/offscreen/index.html", import.meta.url),
);

// Build config for the Alpha Cursor MV3 extension.
//
// - `@crxjs/vite-plugin` (crx) consumes the MV3 manifest and wires the bundled
//   inputs: the background service worker, content script, popup, and options
//   entry points are all declared in `manifest.config.ts` and emitted into the
//   packaged extension. crxjs rewrites TS entries to their built outputs and
//   keeps all executable assets local (no remote code, Req 22.2).
// - `@tailwindcss/vite` provides Tailwind v4 processing for the UI surfaces.
// - `fileURLToPath(new URL(...))` keeps path resolution correct even though the
//   workspace folder name contains a space ("Alpha cursor extension").
export default defineConfig({
  plugins: [tailwindcss(), crx({ manifest })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // Bundled libraries (jsPDF, tesseract.js WASM + worker + trained-data) add
    // multiple MB; raise the warning threshold so expected large local assets
    // don't surface as build noise. They are still shipped locally, never remote.
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      // The OCR offscreen document is created at runtime (chrome.offscreen) and
      // isn't a manifest entry, so declare it explicitly so Vite builds it.
      input: {
        offscreen: offscreenHtml,
      },
    },
  },
});
