/**
 * Alpha Cursor — bundled tesseract.js asset resolution (Tool 10, Req 15, 22.2).
 *
 * MV3 forbids loading or executing remote code (Req 22.2). By default
 * `tesseract.js` fetches its worker script, its WASM core, and the language
 * `*.traineddata` file from the jsDelivr CDN — which is a remote-code load and
 * is therefore NOT allowed. This module pins every tesseract asset to a LOCAL,
 * bundled copy referenced through `chrome.runtime.getURL`, so the OCR engine is
 * 100% client-side and never contacts the network at runtime.
 *
 * ## Bundled assets (shipped under `public/tesseract/`, copied verbatim into the
 * packaged extension by crxjs/Vite):
 *
 *   - `tesseract/worker.min.js`                    (tesseract.js worker script)
 *   - `tesseract/tesseract-core-simd-lstm.wasm.js` (SIMD LSTM core loader)
 *   - `tesseract/tesseract-core-simd-lstm.wasm`    (SIMD LSTM core WASM)
 *   - `tesseract/tesseract-core-lstm.wasm.js`      (non-SIMD LSTM core loader)
 *   - `tesseract/tesseract-core-lstm.wasm`         (non-SIMD LSTM core WASM)
 *   - `tesseract/lang/eng.traineddata.gz`          (English LSTM trained data)
 *
 * `corePath` is given as the *directory* `tesseract/`; tesseract.js's worker
 * then appends the correct core file (`tesseract-core-simd-lstm.wasm.js` when
 * the device supports WASM SIMD, otherwise `tesseract-core-lstm.wasm.js`) and
 * each `.wasm.js` loader fetches its sibling `.wasm` from the same directory.
 * `langPath` is the directory `tesseract/lang/`; the worker appends
 * `eng.traineddata.gz` (gzip is the default and our file is gzipped).
 *
 * ## Bundle-size tradeoff (accepted, per design "Tool 10 — OCR" + Req 22.2):
 * the WASM cores (~2.8 MB each, two are shipped for SIMD/non-SIMD devices) plus
 * the English trained-data (~2.9 MB gzipped) add several MB to the package.
 * This is the cost of the hard "no server, no remote code" constraint — OCR
 * runs entirely on-device. Additional languages, if ever added, would likewise
 * be bundled locally (never fetched remotely).
 *
 * ## Runtime requirement (manifest):
 * the worker + WASM + trained-data are loaded by a Web Worker spawned from the
 * content script, so the `tesseract/*` files MUST be listed in the manifest's
 * `web_accessible_resources` (added in `manifest.config.ts`). The privileged
 * `captureVisibleTab` used to rasterize the selected region needs the `tabs`
 * permission + host access (finalized in task 26.3).
 */

/** Default OCR language. English LSTM trained data is bundled locally. */
export const DEFAULT_OCR_LANG = "eng";

/**
 * Resolve a packaged extension asset to an absolute `chrome-extension://` URL.
 * Falls back to a root-relative path when `chrome.runtime.getURL` is
 * unavailable (e.g. unit tests / non-extension contexts) so the module never
 * throws at import time.
 */
function runtimeUrl(path: string): string {
  const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
  if (runtime && typeof runtime.getURL === "function") {
    return runtime.getURL(path);
  }
  return `/${path}`;
}

/** Local URL of the tesseract.js worker script (`tesseract/worker.min.js`). */
export function workerScriptUrl(): string {
  return runtimeUrl("tesseract/worker.min.js");
}

/**
 * Local directory URL holding the WASM core loaders + `.wasm` files. Given as a
 * directory (no trailing file), tesseract.js picks the SIMD or non-SIMD LSTM
 * core automatically based on device capability.
 */
export function coreDirUrl(): string {
  return runtimeUrl("tesseract");
}

/**
 * Local directory URL holding `eng.traineddata.gz`. Given as a directory,
 * tesseract.js appends `<lang>.traineddata.gz`.
 */
export function langDirUrl(): string {
  return runtimeUrl("tesseract/lang");
}

/**
 * Build the `Partial<WorkerOptions>` for `createWorker` that pins every asset to
 * its local bundled copy (no remote code, Req 22.2). `gzip: true` matches the
 * bundled `eng.traineddata.gz`.
 *
 * `workerBlobURL: false` is REQUIRED: by default tesseract.js fetches the worker
 * script and re-spawns it from a `blob:` URL, which strict page CSPs (e.g.
 * YouTube's `script-src`/`worker-src`) forbid — "Creating a worker from
 * 'blob:…' violates the following Content Security Policy directive". Disabling
 * the blob wrapper makes tesseract load the worker DIRECTLY from `workerPath`
 * (our `chrome-extension://` web-accessible resource), which is allowed
 * regardless of the host page's CSP.
 */
export function localWorkerOptions(): {
  workerPath: string;
  corePath: string;
  langPath: string;
  gzip: boolean;
  workerBlobURL: boolean;
} {
  return {
    workerPath: workerScriptUrl(),
    corePath: coreDirUrl(),
    langPath: langDirUrl(),
    gzip: true,
    workerBlobURL: false,
  };
}
