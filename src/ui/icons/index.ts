/**
 * Alpha Cursor — Wise-matching monochrome line-icon set (task 29.2).
 *
 * A single cohesive set of single-color line icons for the radial
 * Options_Panel, replacing the previous multi-color emoji glyphs (Req 2.12,
 * 20.2). Every icon is an inline SVG that:
 *   - uses a consistent `0 0 24 24` viewBox, ~1.75 stroke width, and rounded
 *     line caps/joins for the friendly Wise aesthetic,
 *   - paints with `stroke="currentColor"` / `fill="none"` so it inherits the
 *     button's text color (`--acx-color-ink`) and never introduces a second
 *     hue, and
 *   - is marked `aria-hidden="true"` — the accessible name lives on the radial
 *     button's `aria-label` (Req 20.7).
 *
 * Icons are keyed by {@link ToolId} so the catalog (`tools.ts`) stays free of
 * presentation concerns: the panel calls {@link createToolIcon} with a tool's
 * id to obtain a freshly-built SVG element node (the button primitive's `icon`
 * option accepts a `Node`).
 */

import { ToolId } from "../../content/tools";

const SVG_NS = "http://www.w3.org/2000/svg";

/** A single SVG child element: a tag name plus its attribute map. */
interface IconChild {
  tag: string;
  attrs: Record<string, string>;
}

/**
 * Line-icon path data keyed by {@link ToolId}. Each entry is the list of child
 * elements (paths / circles / lines / polylines) that make up the glyph, drawn
 * within the shared `0 0 24 24` viewBox. Geometry is sourced from the Lucide
 * line-icon family (ISC-licensed) so the set reads as one cohesive whole.
 */
const ICONS: Record<ToolId, IconChild[]> = {
  // Copy / clipboard — two overlapping rounded rectangles.
  [ToolId.NOTEPAD_COPY_ALL]: [
    { tag: "rect", attrs: { x: "9", y: "9", width: "13", height: "13", rx: "2" } },
    {
      tag: "path",
      attrs: { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" },
    },
  ],
  // Search — magnifier.
  [ToolId.SEARCH_IN]: [
    { tag: "circle", attrs: { cx: "11", cy: "11", r: "7" } },
    { tag: "line", attrs: { x1: "21", y1: "21", x2: "16.65", y2: "16.65" } },
  ],
  // Save image — framed picture with sun + mountain.
  [ToolId.SAVE_IMAGE]: [
    { tag: "rect", attrs: { x: "3", y: "3", width: "18", height: "18", rx: "2" } },
    { tag: "circle", attrs: { cx: "8.5", cy: "8.5", r: "1.5" } },
    { tag: "polyline", attrs: { points: "21 15 16 10 5 21" } },
  ],
  // Media download — tray with a down arrow.
  [ToolId.MEDIA_DOWNLOAD]: [
    {
      tag: "path",
      attrs: { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" },
    },
    { tag: "polyline", attrs: { points: "7 10 12 15 17 10" } },
    { tag: "line", attrs: { x1: "12", y1: "15", x2: "12", y2: "3" } },
  ],
  // Text extraction — the "type" glyph (text / OCR).
  [ToolId.TEXT_EXTRACTION]: [
    { tag: "polyline", attrs: { points: "4 7 4 4 20 4 20 7" } },
    { tag: "line", attrs: { x1: "9", y1: "20", x2: "15", y2: "20" } },
    { tag: "line", attrs: { x1: "12", y1: "4", x2: "12", y2: "20" } },
  ],
  // Save all tabs — floppy/save disk.
  [ToolId.SAVE_TABS]: [
    {
      tag: "path",
      attrs: {
        d: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z",
      },
    },
    { tag: "polyline", attrs: { points: "17 21 17 13 7 13 7 21" } },
    { tag: "polyline", attrs: { points: "7 3 7 8 15 8" } },
  ],
  // Open saved tabs — opened folder.
  [ToolId.RESTORE_TABS]: [
    {
      tag: "path",
      attrs: {
        d: "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H21a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2",
      },
    },
  ],
  // Full page screenshot — camera.
  [ToolId.FULL_PAGE_SCREENSHOT]: [
    {
      tag: "path",
      attrs: {
        d: "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z",
      },
    },
    { tag: "circle", attrs: { cx: "12", cy: "13", r: "3" } },
  ],
  // Color picker — eyedropper / pipette.
  [ToolId.COLOR_PICKER]: [
    { tag: "path", attrs: { d: "m2 22 1-1h3l9-9" } },
    { tag: "path", attrs: { d: "M3 21v-3l9-9" } },
    {
      tag: "path",
      attrs: {
        d: "m15 6 3.4-3.4a2.1 2.1 0 0 1 3 3L18 9l.4.4a2.1 2.1 0 0 1-3 3l-3.8-3.8a2.1 2.1 0 0 1 3-3z",
      },
    },
  ],
  // Voice to text — microphone.
  [ToolId.VOICE_TO_TEXT]: [
    {
      tag: "path",
      attrs: { d: "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" },
    },
    { tag: "path", attrs: { d: "M19 10v1a7 7 0 0 1-14 0v-1" } },
    { tag: "line", attrs: { x1: "12", y1: "18", x2: "12", y2: "22" } },
    { tag: "line", attrs: { x1: "8", y1: "22", x2: "16", y2: "22" } },
  ],
  // Tab shifter — two opposing arrows (swap).
  [ToolId.TAB_SHIFTER]: [
    { tag: "path", attrs: { d: "M8 3 4 7l4 4" } },
    { tag: "path", attrs: { d: "M4 7h16" } },
    { tag: "path", attrs: { d: "m16 21 4-4-4-4" } },
    { tag: "path", attrs: { d: "M20 17H4" } },
  ],
  // Horizontal scroll — left/right arrows on one axis.
  [ToolId.HORIZONTAL_SCROLL]: [
    { tag: "polyline", attrs: { points: "18 8 22 12 18 16" } },
    { tag: "polyline", attrs: { points: "6 8 2 12 6 16" } },
    { tag: "line", attrs: { x1: "2", y1: "12", x2: "22", y2: "12" } },
  ],
};

/** Default icon edge length (CSS px) — tuned for the 36px circular buttons. */
const DEFAULT_ICON_SIZE = 18;

/**
 * Builds an inline SVG element for a tool, sized for the radial
 * `icon-circular` buttons. The returned glyph is single-color (inherits
 * `currentColor`) and `aria-hidden` (Req 2.12, 20.2, 20.7).
 *
 * @param id   the {@link ToolId} whose glyph to render.
 * @param size icon edge length in CSS px (defaults to {@link DEFAULT_ICON_SIZE}).
 * @returns a freshly-constructed `<svg>` element (a new node per call).
 *
 * @example
 * const icon = createToolIcon(ToolId.SEARCH_IN);
 * const button = createButton({ variant: "icon-circular", icon, ariaLabel: "Search in" });
 */
export function createToolIcon(
  id: ToolId,
  size: number = DEFAULT_ICON_SIZE,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const children = ICONS[id] ?? [];
  for (const child of children) {
    const node = document.createElementNS(SVG_NS, child.tag);
    for (const [name, value] of Object.entries(child.attrs)) {
      node.setAttribute(name, value);
    }
    svg.appendChild(node);
  }

  return svg;
}
