// Background handler for Tool 7 — Search Selected Text (Req 12), task 16.3.
//
// The "Search in" sub-menu lives in the content script (closed Shadow DOM near
// the cursor). Opening the chosen search URL in a NEW TAB is delegated to the
// background service worker via a single `SEARCH_OPEN { url }` message so it
// works reliably regardless of the page's user-gesture / popup-blocker state
// (a content-script `window.open` can be blocked).
//
// Silent failure (Req 12.5): if the tab cannot be opened for a technical reason
// (e.g. `chrome.tabs.create` rejects or the API is unavailable), the handler
// takes NO further action and does NOT surface a notification — it resolves
// normally so the router returns `ok`.

import { registerHandler } from "./router";

/** Message type for opening a search result in a new tab. */
export const SearchMessageType = {
  /** Open `{ url }` in a new browser tab. Resolves regardless of outcome. */
  OPEN: "SEARCH_OPEN",
} as const;

/** Payload accepted by the `SEARCH_OPEN` message. */
export interface SearchOpenPayload {
  /** The fully-built search URL (see `buildSearchUrl`). */
  url: string;
}

/** Result echoed back by the `SEARCH_OPEN` handler. */
export interface SearchOpenResult {
  /** `true` when a tab was created; `false` when opening failed silently. */
  opened: boolean;
}

/**
 * Open `url` in a new tab via `chrome.tabs.create`. Resolves to `false` rather
 * than throwing when the tab cannot be created, so the caller stays silent
 * (Req 12.5). Guards against a missing `chrome.tabs` API in non-extension
 * contexts / test shims.
 */
async function openInNewTab(url: string): Promise<boolean> {
  const tabs = (chrome as { tabs?: typeof chrome.tabs }).tabs;
  if (!tabs || typeof tabs.create !== "function") {
    return false;
  }
  try {
    await tabs.create({ url });
    return true;
  } catch {
    // Blocked / failed for a technical reason — take no further action and do
    // NOT notify (Req 12.5).
    return false;
  }
}

/**
 * Register the `SEARCH_OPEN` handler on the background router. Idempotent:
 * `registerHandler` overwrites any prior registration so re-running on
 * service-worker wake is safe. Call once on service-worker startup (wired by
 * `src/background/index.ts`).
 */
export function installSearch(): void {
  registerHandler<SearchOpenPayload, SearchOpenResult>(
    SearchMessageType.OPEN,
    async (payload) => {
      const url = typeof payload?.url === "string" ? payload.url : "";
      if (url === "") {
        return { opened: false };
      }
      const opened = await openInNewTab(url);
      return { opened };
    },
  );
}
