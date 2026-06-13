/**
 * Alpha Cursor — Tool 7 "Search in" wiring (task 16.3, Req 12).
 *
 * Registers the {@link ToolId.SEARCH_IN} handler in the content-script tool
 * catalog. The tool is only ever shown for the `selected-text` context (see
 * `src/content/tools.ts`), so when invoked it:
 *
 *   1. Reads the current text selection (Req 12.1). If it is empty/whitespace,
 *      it surfaces a "no text selected" notification and opens NO tab and NO
 *      menu (Req 12.4).
 *   2. Otherwise renders a small Notion-styled "Search in" sub-menu in a closed
 *      Shadow DOM near the cursor, listing the configured search sites
 *      (YouTube / Reddit / Quora / Google by default, or the user's configured
 *      list from settings — Req 12.6).
 *   3. On choosing a site, builds the concrete URL via {@link buildSearchUrl}
 *      and asks the background to open it in a NEW TAB through the
 *      `SEARCH_OPEN` message (Req 12.1, 12.2). If the tab is blocked, the
 *      background stays silent (Req 12.5) — no error toast here either.
 *
 * The pure URL building + default site list live in `searchUrl.ts`; the
 * editable site list surfaces on the Options page (task 25.1). This module
 * intentionally reads `settings.searchSites` if present and otherwise falls
 * back to {@link DEFAULT_SEARCH_SITES}.
 */

import { createShadowHost, type ShadowHostHandle } from "../../ui/shadowHost";
import { joinClasses } from "../../ui/primitives/classNames";
import { notify } from "../../ui/notify";
import { createMessage } from "../../shared/messaging";
import { type SearchSite, type Settings } from "../../shared/settings";
import {
  getLocal,
  getSync,
  scopedKey,
  StorageDomain,
} from "../../shared/storage";
import { getActiveProfileId } from "../../shared/identity";
import {
  registerTool,
  ToolId,
  type ToolInvocation,
} from "../../content/tools";
import { buildSearchUrl, DEFAULT_SEARCH_SITES } from "./searchUrl";
import {
  SearchMessageType,
  type SearchOpenPayload,
} from "../../background/searchHandlers";

/** Module-level handle to the currently open sub-menu, if any. */
let activeMenu: ShadowHostHandle | null = null;

/**
 * Read the user's current text selection, trimmed. Returns an empty string when
 * there is no selection (or it is whitespace-only).
 */
function readSelection(): string {
  const getSel = (globalThis as { getSelection?: () => Selection | null })
    .getSelection;
  let selection: Selection | null = null;
  if (typeof getSel === "function") {
    selection = getSel.call(globalThis);
  } else if (typeof document !== "undefined") {
    selection = document.getSelection();
  }
  if (!selection) return "";
  return selection.toString().trim();
}

/**
 * Resolve the configured "Search in" site list. Reads the persisted
 * `Settings.searchSites` (profile-scoped, sync with local fallback) and falls
 * back to {@link DEFAULT_SEARCH_SITES} when the profile/settings are not yet
 * available or no list has been configured (Req 12.6). The returned list is
 * sorted by `order` so it renders in the user's intended sequence.
 */
async function resolveSearchSites(): Promise<SearchSite[]> {
  const fallback = DEFAULT_SEARCH_SITES.slice();
  const profileId = getActiveProfileId();
  if (!profileId) return fallback;

  const key = scopedKey(profileId, StorageDomain.SETTINGS, "settings");
  let settings: Settings | undefined;
  try {
    settings = await getSync<Settings>(key);
    if (!settings) {
      settings = await getLocal<Settings>(key);
    }
  } catch {
    return fallback;
  }

  const sites = settings?.searchSites;
  if (!Array.isArray(sites) || sites.length === 0) {
    return fallback;
  }
  return sites.slice().sort((a, b) => a.order - b.order);
}

/** Close the "Search in" sub-menu if open. Idempotent. */
function closeMenu(): void {
  if (activeMenu) {
    activeMenu.destroy();
    activeMenu = null;
  }
}

/**
 * Ask the background service worker to open `url` in a new tab (Req 12.1,
 * 12.2). The background handler is silent on failure (Req 12.5); this caller
 * likewise never surfaces an error toast for a blocked tab.
 */
function requestOpenTab(url: string): void {
  const runtime = (chrome as { runtime?: typeof chrome.runtime }).runtime;
  if (!runtime || typeof runtime.sendMessage !== "function") return;
  const message = createMessage<SearchOpenPayload>(SearchMessageType.OPEN, {
    url,
  });
  try {
    // Fire-and-forget. A rejected promise (no receiver) is swallowed so a
    // blocked/failed open stays silent (Req 12.5).
    void Promise.resolve(runtime.sendMessage(message)).catch(() => {
      /* silent: do not notify on a failed open (Req 12.5) */
    });
  } catch {
    /* silent (Req 12.5) */
  }
}

/**
 * Build the sub-menu element: an elevated white Notion surface listing the
 * configured sites as full-width rows. Choosing a row builds the search URL for
 * the captured `selection` and requests a new tab, then closes the menu.
 */
function buildMenu(sites: SearchSite[], selection: string): HTMLElement {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Search in");
  menu.className = joinClasses(
    "pointer-events-auto inline-flex min-w-[180px] flex-col gap-px",
    "bg-surface text-ink font-sans rounded-xl p-xs",
    "border border-hairline acx-elevated",
  );

  for (const site of sites) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.className = joinClasses(
      "w-full text-left cursor-pointer border-0 bg-transparent",
      "text-ink text-body-sm rounded-md py-sm px-md",
      "hover:bg-fill-hover focus-visible:outline-2",
      "focus-visible:outline-offset-2 focus-visible:outline-primary",
    );
    item.textContent = site.label;
    item.addEventListener("click", () => {
      closeMenu();
      const url = buildSearchUrl(site.urlTemplate, selection);
      requestOpenTab(url);
    });
    menu.appendChild(item);
  }

  return menu;
}

/**
 * Open the "Search in" sub-menu near the cursor for the captured `selection`.
 * Closes any menu already open, wires outside-click + Escape to dismiss, and
 * mounts the site list into a closed shadow host (Req 2.11, 20.1).
 */
function openMenu(sites: SearchSite[], selection: string, point: { x: number; y: number }): void {
  closeMenu();

  const handle = createShadowHost({
    overlay: "anchored",
    point,
    surfaceId: "search-menu",
  });
  activeMenu = handle;
  handle.mount(buildMenu(sites, selection));

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    }
  };
  const onPointerDown = (event: MouseEvent): void => {
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];
    if (!path.includes(handle.host)) {
      closeMenu();
    }
  };

  window.addEventListener("keydown", onKeyDown, true);
  handle.onDestroy(() => window.removeEventListener("keydown", onKeyDown, true));

  // Defer outside-click wiring one tick so the click that opened the menu is
  // not treated as an outside dismissal.
  setTimeout(() => {
    window.addEventListener("mousedown", onPointerDown, true);
    handle.onDestroy(() =>
      window.removeEventListener("mousedown", onPointerDown, true),
    );
  }, 0);
}

/**
 * The {@link ToolId.SEARCH_IN} run handler. Reads the selection, short-circuits
 * with a notification when empty (Req 12.4), otherwise resolves the configured
 * sites and opens the sub-menu.
 */
async function runSearchTool(invocation: ToolInvocation): Promise<void> {
  const selection = readSelection();
  if (selection === "") {
    // Empty selection: notify and open NO tab / NO menu (Req 12.4).
    notify({ kind: "info", text: "No text selected" });
    return;
  }
  const sites = await resolveSearchSites();
  openMenu(sites, selection, invocation.point);
}

/**
 * Install the real "Search in" behavior into the tool catalog, replacing the
 * placeholder stub. Wired by the content-script orchestrator (not edited here).
 *
 * @returns `true` if the tool was registered (always, unless the catalog id
 * changes).
 */
export function registerSearchTool(): boolean {
  return registerTool(ToolId.SEARCH_IN, runSearchTool);
}
