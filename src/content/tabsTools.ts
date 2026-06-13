/**
 * Alpha Cursor — content/UI wiring for Tool 2 (Save All Tabs, Req 7) and Tool 3
 * (Restore Saved Tabs, Req 8) — tasks 12.3 / 12.5 (UI half).
 *
 * The background worker (`src/background/tabsHandlers.ts`) owns `chrome.tabs.*`
 * and storage; this module is the content-script front end that:
 *   - registers the `SAVE_TABS` and `RESTORE_TABS` tool `run` handlers into the
 *     Options_Panel catalog via {@link registerTool},
 *   - prompts for a folder name (Save) and renders the saved-folder list with
 *     restore + delete controls (Restore), both in a CLOSED Shadow DOM dialog
 *     styled with the Notion primitives,
 *   - sends the typed `TABS_*` messages to the background and surfaces the
 *     outcome via {@link notify}, including the name-collision overwrite/rename
 *     flow (Req 7.4) and the failed-count report on restore (Req 8.5).
 *
 * ## UI choice
 * Rather than `window.prompt` (which is blocked in many pages and ignores the
 * Notion design system), this module renders a small shadow-DOM dialog built
 * from the existing `createCard` / `createTextInput` / `createButton`
 * primitives. It mounts in a full-viewport closed shadow host with a dimmed
 * backdrop, closes on Escape / backdrop click, and never lets host-page CSS
 * bleed in (Req 2.11, 20.1).
 */

import { createShadowHost, type ShadowHostHandle } from "../ui/shadowHost";
import { createCard } from "../ui/primitives/card";
import { createButton } from "../ui/primitives/button";
import { createTextInput } from "../ui/primitives/textInput";
import { joinClasses } from "../ui/primitives/classNames";
import { notify } from "../ui/notify";
import { registerTool, ToolId } from "./tools";
import {
  createMessage,
  isOk,
  type Response,
} from "../shared/messaging";

// ---------------------------------------------------------------------------
// Message contracts (mirror src/background/tabsHandlers.ts)
// ---------------------------------------------------------------------------

/** Message type strings shared with the background tab handlers. */
const TabsMessageType = {
  SAVE: "TABS_SAVE",
  LIST: "TABS_LIST",
  DELETE: "TABS_DELETE",
  RESTORE: "TABS_RESTORE",
} as const;

interface TabsSavePayload {
  name: string;
  overwrite?: boolean;
}

type TabsSaveResult =
  | { saved: true; folderId: string; name: string; savedCount: number }
  | { saved: false; reason: "name_exists"; name: string };

interface TabFolderSummary {
  id: string;
  name: string;
  count: number;
  savedAt: number;
}

interface TabsRestoreResult {
  openedCount: number;
  failedCount: number;
}

// ---------------------------------------------------------------------------
// Messaging helper
// ---------------------------------------------------------------------------

/**
 * Send a typed message to the background router and resolve with its
 * `Response<R>`. Wraps `chrome.runtime.sendMessage` in a promise and normalizes
 * a missing/duplicate response into an error branch so callers always get a
 * discriminated `Response`.
 */
function sendToBackground<T, R>(
  type: string,
  payload: T,
): Promise<Response<R>> {
  return new Promise<Response<R>>((resolve) => {
    try {
      chrome.runtime.sendMessage(
        createMessage(type, payload),
        (response: Response<R>) => {
          const lastError = chrome.runtime?.lastError;
          if (lastError || !response) {
            resolve({
              ok: false,
              error: {
                code: "UNKNOWN",
                message: lastError?.message ?? "No response from background.",
                recoverable: true,
              },
            });
            return;
          }
          resolve(response);
        },
      );
    } catch (cause) {
      resolve({
        ok: false,
        error: {
          code: "UNKNOWN",
          message: cause instanceof Error ? cause.message : String(cause),
          recoverable: true,
        },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Dialog scaffolding (closed shadow host + dimmed backdrop)
// ---------------------------------------------------------------------------

/** Handle for an open dialog, exposing a `close()` disposer. */
interface DialogHandle {
  host: ShadowHostHandle;
  close: () => void;
}

/**
 * Mount `content` inside a centered, dimmed, full-viewport closed shadow host.
 * Closes on Escape and backdrop click; `onClose` runs once on teardown.
 */
function openDialog(content: HTMLElement, onClose?: () => void): DialogHandle {
  const host = createShadowHost({
    overlay: "full-viewport",
    surfaceId: "tabs-dialog",
  });

  const backdrop = document.createElement("div");
  backdrop.className = joinClasses(
    "pointer-events-auto fixed inset-0 flex items-center justify-center",
    "bg-scrim p-md",
  );

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    window.removeEventListener("keydown", onKeyDown, true);
    onClose?.();
    host.destroy();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });

  backdrop.appendChild(content);
  host.mount(backdrop);
  window.addEventListener("keydown", onKeyDown, true);

  return { host, close };
}

/** Build a dialog title element styled with Notion ink/heading tokens. */
function buildTitle(text: string): HTMLElement {
  const heading = document.createElement("h2");
  heading.className = "text-ink text-body-md font-sans font-semibold m-0";
  heading.textContent = text;
  return heading;
}

/** A horizontal row of action buttons aligned to the right. */
function buildActionRow(buttons: HTMLElement[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "flex items-center justify-end gap-xs";
  for (const button of buttons) row.appendChild(button);
  return row;
}

// ---------------------------------------------------------------------------
// Save flow (Req 7)
// ---------------------------------------------------------------------------

/**
 * Send a save request, handling the collision response (Req 7.4) by prompting
 * overwrite vs rename, and notifying success with the tab count (Req 7.6).
 */
async function submitSave(name: string, overwrite: boolean): Promise<void> {
  const response = await sendToBackground<TabsSavePayload, TabsSaveResult>(
    TabsMessageType.SAVE,
    { name, overwrite },
  );

  if (!isOk(response)) {
    // NO_TABS (Req 7.5), invalid name, identity/storage failures, etc.
    notify({
      kind: "error",
      text: response.error.message,
      code: response.error.code,
    });
    return;
  }

  const result = response.data;
  if (result.saved === false) {
    // Req 7.4 — collision: let the user overwrite or pick a new name.
    promptNameCollision(result.name);
    return;
  }

  notify({
    kind: "success",
    text: `Saved ${result.savedCount} ${
      result.savedCount === 1 ? "tab" : "tabs"
    } to "${result.name}".`,
  });
}

/** Render the initial "name this tab folder" dialog (Req 7.2). */
function promptFolderName(): void {
  const card = createCard({ variant: "elevated" });
  card.className = joinClasses(
    card.className,
    "pointer-events-auto w-[min(360px,100%)] flex flex-col gap-md",
  );

  const input = createTextInput({
    ariaLabel: "Tab folder name",
    placeholder: "e.g. Research session",
  });
  input.className = joinClasses(input.className, "w-full");

  const cancel = createButton({
    variant: "utility",
    label: "Cancel",
    onClick: () => dialog.close(),
  });
  const save = createButton({
    variant: "primary",
    label: "Save tabs",
    onClick: () => {
      const name = input.value.trim();
      if (name.length === 0) {
        notify({ kind: "info", text: "Enter a name for the tab folder." });
        input.focus();
        return;
      }
      dialog.close();
      void submitSave(name, false);
    },
  });

  // Enter submits.
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save.click();
    }
  });

  card.appendChild(buildTitle("Save all tabs"));
  card.appendChild(input);
  card.appendChild(buildActionRow([cancel, save]));

  const dialog = openDialog(card);
  // Focus the field once mounted.
  setTimeout(() => input.focus(), 0);
}

/** Render the overwrite-vs-rename dialog after a name collision (Req 7.4). */
function promptNameCollision(name: string): void {
  const card = createCard({ variant: "elevated" });
  card.className = joinClasses(
    card.className,
    "pointer-events-auto w-[min(380px,100%)] flex flex-col gap-md",
  );

  const message = document.createElement("p");
  message.className = "text-ink-muted text-body-sm font-sans m-0";
  message.textContent = `A tab folder named "${name}" already exists. Overwrite it or choose a different name?`;

  const rename = createButton({
    variant: "utility",
    label: "Rename",
    onClick: () => {
      dialog.close();
      promptFolderName();
    },
  });
  const overwrite = createButton({
    variant: "primary",
    label: "Overwrite",
    onClick: () => {
      dialog.close();
      void submitSave(name, true);
    },
  });

  card.appendChild(buildTitle("Name already used"));
  card.appendChild(message);
  card.appendChild(buildActionRow([rename, overwrite]));

  const dialog = openDialog(card);
}

// ---------------------------------------------------------------------------
// Restore flow (Req 8)
// ---------------------------------------------------------------------------

/** Send a restore request and report the opened / failed counts (Req 8.5). */
async function submitRestore(folderId: string, name: string): Promise<void> {
  const response = await sendToBackground<
    { folderId: string },
    TabsRestoreResult
  >(TabsMessageType.RESTORE, { folderId });

  if (!isOk(response)) {
    // NO_OPENABLE_URLS (Req 8.4) and other failures.
    notify({
      kind: "error",
      text: response.error.message,
      code: response.error.code,
    });
    return;
  }

  const { openedCount, failedCount } = response.data;
  const opened = `Opened ${openedCount} ${
    openedCount === 1 ? "tab" : "tabs"
  } from "${name}".`;
  notify({
    kind: failedCount > 0 ? "info" : "success",
    text:
      failedCount > 0
        ? `${opened} ${failedCount} ${
            failedCount === 1 ? "URL" : "URLs"
          } could not be opened.`
        : opened,
  });
}

/** Send a delete request and refresh the list dialog (Req 8.6). */
async function submitDelete(
  folderId: string,
  rerender: () => Promise<void>,
): Promise<void> {
  const response = await sendToBackground<{ folderId: string }, { deleted: boolean }>(
    TabsMessageType.DELETE,
    { folderId },
  );
  if (!isOk(response)) {
    notify({
      kind: "error",
      text: response.error.message,
      code: response.error.code,
    });
    return;
  }
  await rerender();
}

/** Build a single saved-folder row with Restore + Delete controls. */
function buildFolderRow(
  folder: TabFolderSummary,
  close: () => void,
  rerender: () => Promise<void>,
): HTMLElement {
  const row = document.createElement("div");
  row.className = joinClasses(
    "flex items-center justify-between gap-sm",
    "py-xs px-sm rounded-md border border-hairline bg-surface",
  );

  const meta = document.createElement("div");
  meta.className = "flex flex-col min-w-0";
  const nameEl = document.createElement("span");
  nameEl.className = "text-ink text-body-sm font-sans truncate";
  nameEl.textContent = folder.name;
  const countEl = document.createElement("span");
  countEl.className = "text-ink-faint text-eyebrow font-sans";
  countEl.textContent = `${folder.count} ${folder.count === 1 ? "tab" : "tabs"}`;
  meta.appendChild(nameEl);
  meta.appendChild(countEl);

  const controls = document.createElement("div");
  controls.className = "flex items-center gap-xs shrink-0";

  const restore = createButton({
    variant: "primary",
    label: "Open",
    onClick: () => {
      close();
      void submitRestore(folder.id, folder.name);
    },
  });
  const del = createButton({
    variant: "icon-circular",
    icon: "🗑",
    ariaLabel: `Delete ${folder.name}`,
    onClick: () => {
      void submitDelete(folder.id, rerender);
    },
  });

  controls.appendChild(restore);
  controls.appendChild(del);

  row.appendChild(meta);
  row.appendChild(controls);
  return row;
}

/** Open the saved-folder chooser dialog (Req 8.2), wiring restore + delete. */
async function openRestoreDialog(): Promise<void> {
  const response = await sendToBackground<void, TabFolderSummary[]>(
    TabsMessageType.LIST,
    undefined,
  );

  if (!isOk(response)) {
    notify({
      kind: "error",
      text: response.error.message,
      code: response.error.code,
    });
    return;
  }

  const card = createCard({ variant: "elevated" });
  card.className = joinClasses(
    card.className,
    "pointer-events-auto w-[min(420px,100%)] flex flex-col gap-md max-h-[80vh]",
  );

  const dialog = openDialog(card);

  // Renders/refreshes the list body in place from the latest folder list.
  const renderList = (folders: TabFolderSummary[]): void => {
    card.replaceChildren();
    card.appendChild(buildTitle("Open saved tabs"));

    if (folders.length === 0) {
      const empty = document.createElement("p");
      empty.className = "text-ink-muted text-body-sm font-sans m-0";
      empty.textContent = "No saved tab folders yet.";
      card.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "flex flex-col gap-xs overflow-y-auto";
      for (const folder of folders) {
        list.appendChild(buildFolderRow(folder, dialog.close, refresh));
      }
      card.appendChild(list);
    }

    const closeBtn = createButton({
      variant: "utility",
      label: "Close",
      onClick: () => dialog.close(),
    });
    card.appendChild(buildActionRow([closeBtn]));
  };

  // Re-fetch the list and re-render (after a delete).
  async function refresh(): Promise<void> {
    const refreshed = await sendToBackground<void, TabFolderSummary[]>(
      TabsMessageType.LIST,
      undefined,
    );
    if (isOk(refreshed)) {
      renderList(refreshed.data);
    }
  }

  renderList(response.data);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Install the real `run` handlers for the Save All Tabs and Restore Saved Tabs
 * tools, replacing their catalog stubs. Called from the content-script
 * bootstrap (orchestrator wiring).
 */
export function registerTabsTools(): void {
  registerTool(ToolId.SAVE_TABS, () => {
    promptFolderName();
  });
  registerTool(ToolId.RESTORE_TABS, () => {
    void openRestoreDialog();
  });
}
