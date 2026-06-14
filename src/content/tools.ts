/**
 * Alpha Cursor — tool catalog + context-aware tool-set resolver (task 10.3).
 *
 * Defines the descriptor for an Options_Panel tool, the catalog of the twelve
 * tools with the {@link ContextType}(s) each applies to, a registration
 * mechanism so the real tool behaviors (tasks 11–22) can plug in their `run`
 * handlers, and the PURE {@link resolveToolSet} that maps a resolved
 * {@link ContextType} to the exact set of tools the panel should show:
 * every context-independent tool plus exactly the tools applicable to that
 * context, and no inapplicable context-specific tool (Req 2.6, Property 2).
 *
 * ## Context model
 * - A tool with `contexts: "all"` is **context-independent** — it appears in
 *   every Options_Panel regardless of what the cursor is over.
 * - A tool with `contexts: ContextType[]` is **context-specific** — it appears
 *   only when the resolved context is in that list.
 *
 * Mapping (from Requirements 4/6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18 and
 * the design's "Cross-Cutting: Options_Panel"):
 *
 * | Tool                  | Contexts                          | Requirement |
 * |-----------------------|-----------------------------------|-------------|
 * | Copy All (notepad)    | all (context-independent)         | 6           |
 * | Save all tabs         | generic-page                      | 7.1         |
 * | Open saved tabs       | generic-page                      | 8.1         |
 * | Full page screenshot  | generic-page                      | 9.1         |
 * | Color picker          | generic-page                      | 14.1        |
 * | Voice to text         | generic-page                      | 16.1        |
 * | Tab shifter           | generic-page                      | 17.1        |
 * | Horizontal scroll     | generic-page                      | 18.1        |
 * | Text extraction (OCR) | generic-page, image, video        | 15.1        |
 * | Save image            | image                             | 10.1        |
 * | Search in             | selected-text                     | 12.1        |
 * | Media download        | video                             | 13          |
 *
 * ## Registration mechanism (for tasks 11–22)
 * The catalog ships with placeholder `run` handlers that emit a "coming soon"
 * notification. Each later tool task calls {@link registerTool} with the tool's
 * id to install the real handler in place of the stub, without reshaping the
 * catalog. {@link resolveToolSet} always returns the *current* (possibly
 * replaced) handler.
 */

import type { ContextType } from "./context";
import { notify } from "../ui/notify";

/** Stable identifiers for the twelve tools. Used by {@link registerTool}. */
export const ToolId = {
  NOTEPAD_COPY_ALL: "notepad-copy-all",
  SAVE_TABS: "save-tabs",
  RESTORE_TABS: "restore-tabs",
  FULL_PAGE_SCREENSHOT: "full-page-screenshot",
  COLOR_PICKER: "color-picker",
  VOICE_TO_TEXT: "voice-to-text",
  TAB_SHIFTER: "tab-shifter",
  HORIZONTAL_SCROLL: "horizontal-scroll",
  TEXT_EXTRACTION: "text-extraction",
  SAVE_IMAGE: "save-image",
  SEARCH_IN: "search-in",
  MEDIA_DOWNLOAD: "media-download",
} as const;

/** Union of all valid tool id string literals. */
export type ToolId = (typeof ToolId)[keyof typeof ToolId];

/**
 * Runtime context handed to a tool's `run` handler when it is invoked from the
 * Options_Panel. Carries the resolved {@link ContextType} and the viewport
 * point where the panel was opened so tools can anchor follow-up UI.
 */
export interface ToolInvocation {
  /** The {@link ContextType} resolved for the click that opened the panel. */
  context: ContextType;
  /** Viewport coordinates (CSS px) of the originating middle-click. */
  point: { x: number; y: number };
}

/** A tool's invocation handler. May be async (downloads, captures, …). */
export type ToolRun = (invocation: ToolInvocation) => void | Promise<void>;

/** Descriptor for a single Options_Panel tool. */
export interface Tool {
  /** Stable identifier (one of {@link ToolId}). */
  id: ToolId;
  /** Human-readable label rendered in the panel. */
  label: string;
  /**
   * Applicability. `"all"` marks a context-independent tool shown in every
   * panel; an array lists the exact {@link ContextType}s the tool applies to.
   */
  contexts: ContextType[] | "all";
  /** Invocation handler. Replaceable at runtime via {@link registerTool}. */
  run: ToolRun;
}

/**
 * Build a placeholder `run` for a not-yet-implemented tool. Tasks 11–22 replace
 * these via {@link registerTool}. The stub surfaces a Notion toast so the panel
 * is fully wired and testable before the real behaviors land.
 */
function comingSoon(label: string): ToolRun {
  return () => {
    notify({ kind: "info", text: `${label} is coming soon` });
  };
}

/**
 * The tool catalog. `contexts` values are FIXED by the requirements; only the
 * `run` handlers are mutable (replaced by {@link registerTool}). Order is the
 * intended display order within a panel.
 */
const CATALOG: Tool[] = [
  {
    id: ToolId.NOTEPAD_COPY_ALL,
    label: "Copy All",
    contexts: "all",
    run: comingSoon("Copy All"),
  },
  {
    id: ToolId.SEARCH_IN,
    label: "Search in",
    contexts: ["selected-text"],
    run: comingSoon("Search in"),
  },
  {
    id: ToolId.SAVE_IMAGE,
    label: "Save image",
    contexts: ["image"],
    run: comingSoon("Save image"),
  },
  {
    id: ToolId.MEDIA_DOWNLOAD,
    label: "Download media",
    contexts: ["video"],
    run: comingSoon("Download media"),
  },
  {
    id: ToolId.TEXT_EXTRACTION,
    label: "Text extraction",
    contexts: ["generic-page", "image", "video"],
    run: comingSoon("Text extraction"),
  },
  {
    id: ToolId.SAVE_TABS,
    label: "Save all tabs",
    contexts: ["generic-page"],
    run: comingSoon("Save all tabs"),
  },
  {
    id: ToolId.RESTORE_TABS,
    label: "Open saved tabs",
    contexts: ["generic-page"],
    run: comingSoon("Open saved tabs"),
  },
  {
    id: ToolId.FULL_PAGE_SCREENSHOT,
    label: "Full page screenshot",
    contexts: ["generic-page"],
    run: comingSoon("Full page screenshot"),
  },
  {
    id: ToolId.COLOR_PICKER,
    label: "Color picker",
    contexts: ["generic-page"],
    run: comingSoon("Color picker"),
  },
  {
    id: ToolId.VOICE_TO_TEXT,
    label: "Voice to text",
    contexts: ["generic-page"],
    run: comingSoon("Voice to text"),
  },
  {
    id: ToolId.TAB_SHIFTER,
    label: "Tab shifter",
    contexts: ["generic-page"],
    run: comingSoon("Tab shifter"),
  },
  {
    id: ToolId.HORIZONTAL_SCROLL,
    label: "Horizontal scroll",
    contexts: ["generic-page"],
    run: comingSoon("Horizontal scroll"),
  },
];

/** Index from id → catalog entry for O(1) registration/lookup. */
const CATALOG_BY_ID = new Map<ToolId, Tool>(
  CATALOG.map((tool) => [tool.id, tool]),
);

/**
 * Returns `true` when `tool` should appear for the given {@link ContextType}:
 * either it is context-independent (`"all"`) or its context list includes
 * `context`.
 */
export function toolAppliesTo(tool: Tool, context: ContextType): boolean {
  return tool.contexts === "all" || tool.contexts.includes(context);
}

/**
 * Returns `true` when `tool` is context-independent (shown in every panel).
 */
export function isContextIndependent(tool: Tool): boolean {
  return tool.contexts === "all";
}

/**
 * PURE tool-set resolver (Property 2, Req 2.6).
 *
 * For a resolved {@link ContextType}, returns every context-independent tool
 * plus exactly the context-specific tools applicable to that context — and no
 * inapplicable context-specific tool — preserving catalog (display) order.
 *
 * Reads the current catalog (so {@link registerTool} replacements are visible)
 * but does not mutate it. Exported for property testing (task 10.4).
 */
export function resolveToolSet(context: ContextType): Tool[] {
  return CATALOG.filter((tool) => toolAppliesTo(tool, context));
}

/** Returns a shallow copy of the full catalog (for tests / introspection). */
export function getToolCatalog(): Tool[] {
  return CATALOG.slice();
}

/** Looks up a single tool by id, or `undefined` if unknown. */
export function getTool(id: ToolId): Tool | undefined {
  return CATALOG_BY_ID.get(id);
}

/**
 * Install the real `run` handler for a tool, replacing its placeholder stub.
 * Called by tasks 11–22 as each tool's behavior is implemented.
 *
 * @returns `true` if the tool exists and was updated; `false` for an unknown id.
 *
 * @example
 * // From the notepad task (11.7):
 * registerTool(ToolId.NOTEPAD_COPY_ALL, async () => { await copyAllEntries(); });
 */
export function registerTool(id: ToolId, run: ToolRun): boolean {
  const tool = CATALOG_BY_ID.get(id);
  if (!tool) return false;
  tool.run = run;
  return true;
}
