// Background handlers for Tool 12 — Tab Shifter (Req 17), task 21.1.
//
// The service worker owns `chrome.tabs.*` because content scripts cannot
// enumerate tabs across the window or activate another tab. These handlers
// register on the shared background router and expose two lightweight
// operations used by the radial tab-shifter panel rendered in the content
// script (`src/tools/tabshifter/tabShifterTool.ts`):
//
//   - TABS_LIST_LIGHT  -> LightTab[]            (Req 17.2, 17.3)
//   - TAB_ACTIVATE     { tabId } -> { activated }(Req 17.4)
//
// DISTINCT message type strings (`TABS_LIST_LIGHT`, `TAB_ACTIVATE`) and a
// SEPARATE install function (`installTabShifter`) are used deliberately so this
// module never collides with the Save/Restore tab handlers in
// `src/background/tabsHandlers.ts` (which own `TABS_SAVE` / `TABS_LIST` / …).
//
// Permissions: enumerating and activating tabs requires the `"tabs"` permission
// (and `windows`-level focus is best-effort via `chrome.windows.update`). The
// manifest permission set is finalized in task 26.3; this module only needs
// `chrome.tabs.query` + `chrome.tabs.update`.
//
// Design reference: "Tool 12 — Tab Shifter (Req 17)".

import { registerHandler } from "./router";

// ---------------------------------------------------------------------------
// Message types + payload / result shapes
// ---------------------------------------------------------------------------

/** Message type strings for the tab-shifter handlers (distinct from TABS_*). */
export const TabShifterMessageType = {
  /** List the current window's tabs as {@link LightTab}[] (Req 17.2, 17.3). */
  LIST_LIGHT: "TABS_LIST_LIGHT",
  /** Activate a tab by id: payload {@link TabActivatePayload} (Req 17.4). */
  ACTIVATE: "TAB_ACTIVATE",
} as const;

/**
 * Lightweight projection of a tab for the radial shifter panel. Only the three
 * fields the panel renders/uses are carried across the message boundary
 * (Req 17.2, 17.3) — never the full `chrome.tabs.Tab`.
 */
export interface LightTab {
  /** The Chrome tab id used to activate it (Req 17.4). May be undefined-ish. */
  id: number;
  /** The tab's title (Req 17.3). Empty string when Chrome reports none. */
  title: string;
  /**
   * The tab's favicon URL (Req 17.3). `undefined` when the tab has none, in
   * which case the panel renders a Notion placeholder icon (Req 17.5).
   */
  favIconUrl?: string;
}

/** Payload for {@link TabShifterMessageType.ACTIVATE}. */
export interface TabActivatePayload {
  /** The id of the tab to activate (Req 17.4). */
  tabId: number;
}

/** Result of an activate attempt. */
export interface TabActivateResult {
  /** `true` when the tab was activated. */
  activated: boolean;
}

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

/**
 * TABS_LIST_LIGHT — enumerate the current window's tabs and project them to the
 * lightweight `{ id, title, favIconUrl }` shape the radial panel renders
 * (Req 17.2, 17.3).
 *
 * Tabs without a usable numeric id are dropped (they cannot be activated), and
 * a blank/whitespace `favIconUrl` is normalized to `undefined` so the panel can
 * decide to render the Notion placeholder (Req 17.5).
 */
export async function handleTabsListLight(): Promise<LightTab[]> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const result: LightTab[] = [];
  for (const tab of tabs) {
    if (typeof tab.id !== "number") continue;
    const light: LightTab = {
      id: tab.id,
      title: tab.title ?? "",
    };
    // Prefer Chrome's `_favicon` API (derived from the page URL) for http(s)
    // tabs: it returns the same COLORED favicon Chrome shows in the tab strip
    // and, being an extension resource, renders reliably inside the content
    // script's shadow DOM regardless of the host page's `img-src` CSP — which
    // otherwise blocks cross-origin favicon URLs and leaves empty boxes. Fall
    // back to the tab's own `favIconUrl` only when no `_favicon` can be built
    // (e.g. chrome:// pages); otherwise the panel renders a lettered
    // placeholder (Req 17.3, 17.5).
    const derived = faviconUrlForPage(tab.url);
    if (derived) {
      light.favIconUrl = derived;
    } else if (typeof tab.favIconUrl === "string" && tab.favIconUrl.trim() !== "") {
      light.favIconUrl = tab.favIconUrl;
    }
    result.push(light);
  }
  return result;
}

/**
 * Build a Chrome `_favicon` URL for a page, used when a tab reports no
 * `favIconUrl`. Returns `undefined` for missing or non-http(s) URLs (e.g.
 * `chrome://`, `about:`) where no favicon is meaningful, so the panel renders
 * its lettered placeholder instead (Req 17.5).
 */
function faviconUrlForPage(pageUrl: string | undefined): string | undefined {
  if (!pageUrl) return undefined;
  if (!/^https?:\/\//i.test(pageUrl)) return undefined;
  const getURL = (chrome as { runtime?: { getURL?: (p: string) => string } })
    .runtime?.getURL;
  if (typeof getURL !== "function") return undefined;
  try {
    const url = new URL(getURL("/_favicon/"));
    url.searchParams.set("pageUrl", pageUrl);
    url.searchParams.set("size", "32");
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * TAB_ACTIVATE — activate the tab identified by `tabId` (Req 17.4) and, best
 * effort, focus the window that owns it so the switch is visible even when the
 * tab lives in a background window.
 *
 * Resolves `{ activated: false }` rather than throwing when the id is invalid
 * or the tab no longer exists, so a stale panel selection degrades gracefully.
 */
export async function handleTabActivate(
  payload: TabActivatePayload,
): Promise<TabActivateResult> {
  const tabId = payload?.tabId;
  if (typeof tabId !== "number" || !Number.isFinite(tabId)) {
    return { activated: false };
  }

  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    // Best-effort: bring the owning window to the foreground (Req 17.4). A
    // failure here must not fail the activation itself.
    const windowId = tab?.windowId;
    if (typeof windowId === "number") {
      const windows = (chrome as { windows?: typeof chrome.windows }).windows;
      if (windows && typeof windows.update === "function") {
        try {
          await windows.update(windowId, { focused: true });
        } catch {
          /* window focus is best-effort; ignore */
        }
      }
    }
    return { activated: true };
  } catch {
    return { activated: false };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the tab-shifter handlers on the background router. Idempotent
 * (`registerHandler` overwrites prior registrations), so it is safe to call on
 * every service-worker wake. Wired from `src/background/index.ts` by the
 * orchestrator (not edited here).
 */
export function installTabShifter(): void {
  registerHandler<void, LightTab[]>(TabShifterMessageType.LIST_LIGHT, () =>
    handleTabsListLight(),
  );
  registerHandler<TabActivatePayload, TabActivateResult>(
    TabShifterMessageType.ACTIVATE,
    (payload) => handleTabActivate(payload),
  );
}
