/**
 * Alpha Cursor — Notion card / surface primitive (plain-DOM factory).
 *
 * Returns an `HTMLElement` styled as a Notion `feature-card` (DESIGN.md):
 * white surface, ink text, `rounded-lg` (12px), `p-lg` (24px). Elevation is
 * flat by default (a 1px hairline border, the Notion "Level 0" treatment) and
 * the `elevated` variant adds the barely-there `shadow-soft` layered shadow.
 *
 * Framework-agnostic and usable in both Shadow DOM surfaces and the
 * popup/options documents.
 */

import { joinClasses, type ClassValue } from "./classNames";

/** Elevation variants for {@link createCard}. */
export type CardVariant = "flat" | "elevated";

/** Options for {@link createCard}. */
export interface CreateCardOptions {
  /**
   * Elevation. `"flat"` (default) uses a hairline border only; `"elevated"`
   * adds the soft Level-1 layered shadow for floating surfaces.
   */
  variant?: CardVariant;
  /**
   * Content to place inside the card. A single `Node` is appended directly; an
   * array of `Node`s is appended in order; a string is set as text content.
   */
  children?: string | Node | Node[];
  /**
   * The element tag to use. Defaults to `"div"`. Use `"section"`/`"article"`
   * for semantic grouping where appropriate.
   */
  as?: keyof HTMLElementTagNameMap;
  /** Extra class names appended after the variant classes. */
  className?: ClassValue;
}

/**
 * Base card chrome shared by all variants: ink text, body-md type, 12px radius,
 * 24px padding. The surface fill + border are variant-specific (the elevated
 * "glass" variant supplies its own translucent fill + border).
 */
const BASE_CLASSES = "text-ink text-body-md font-sans rounded-lg p-md";

/** Flat-only chrome: opaque surface + hairline border (Notion Level 0). */
const FLAT_SURFACE_CLASSES = "bg-surface border border-hairline";

/** Variant overlays on top of {@link BASE_CLASSES}. */
const VARIANT_CLASSES: Record<CardVariant, string> = {
  flat: FLAT_SURFACE_CLASSES,
  // Premium elevation: a translucent "glass" surface (backdrop blur + subtle
  // page show-through) with the layered Level-2 shadow and a faint top edge
  // highlight (see `.acx-glass` / `.acx-enter` in tailwind.css), plus a soft
  // scale+lift entrance. Used for floating dialogs / menus / panels.
  elevated: "acx-glass acx-enter",
};

/**
 * Creates a Notion-styled card / surface element.
 *
 * @example
 * const card = createCard({ children: [titleEl, bodyEl] });
 *
 * @example
 * const modal = createCard({ variant: "elevated", children: dialogContent });
 */
export function createCard(options: CreateCardOptions = {}): HTMLElement {
  const variant: CardVariant = options.variant ?? "flat";
  const el = document.createElement(options.as ?? "div");
  el.className = joinClasses(
    BASE_CLASSES,
    VARIANT_CLASSES[variant],
    options.className,
  );

  const { children } = options;
  if (children !== undefined) {
    if (typeof children === "string") {
      el.textContent = children;
    } else if (Array.isArray(children)) {
      for (const child of children) el.appendChild(child);
    } else {
      el.appendChild(children);
    }
  }

  return el;
}
