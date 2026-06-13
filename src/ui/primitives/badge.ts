/**
 * Alpha Cursor — Notion badge-pill primitive (plain-DOM factory).
 *
 * Returns an `HTMLElement` styled as the Notion `badge-pill` (DESIGN.md):
 * white surface, primary-blue text, `eyebrow` type (12px / 600), fully pill
 * (`rounded-full`), `4px 8px` padding. Used for small eyebrow labels and
 * category tags.
 *
 * This is the one place outside actions/links/focus where the primary blue is
 * used as a text color — consistent with DESIGN.md's `badge-pill` spec, which
 * reserves the blue as the badge's accent (Req 20.3).
 *
 * Framework-agnostic; usable in Shadow DOM surfaces and the popup/options docs.
 */

import { joinClasses, type ClassValue } from "./classNames";

/** Options for {@link createBadge}. */
export interface CreateBadgeOptions {
  /** Badge text content. */
  label?: string;
  /**
   * Content node(s) to use instead of/alongside a plain `label`. A `Node` is
   * appended directly; an array is appended in order. When provided, `label`
   * is ignored.
   */
  children?: Node | Node[];
  /**
   * Element tag. Defaults to `"span"` (inline). The badge is decorative text
   * by default and carries no ARIA role.
   */
  as?: keyof HTMLElementTagNameMap;
  /** Extra class names appended after the base classes. */
  className?: ClassValue;
}

/**
 * Notion badge-pill chrome: white surface, primary text, eyebrow type, pill
 * shape, tight 4px/8px padding.
 */
const BASE_CLASSES =
  "inline-flex items-center bg-surface text-primary text-eyebrow font-sans " +
  "rounded-full px-xs py-[4px]";

/**
 * Creates a Notion-styled badge / eyebrow pill.
 *
 * @example
 * const tag = createBadge({ label: "New" });
 */
export function createBadge(options: CreateBadgeOptions = {}): HTMLElement {
  const el = document.createElement(options.as ?? "span");
  el.className = joinClasses(BASE_CLASSES, options.className);

  if (options.children !== undefined) {
    if (Array.isArray(options.children)) {
      for (const child of options.children) el.appendChild(child);
    } else {
      el.appendChild(options.children);
    }
  } else if (options.label !== undefined) {
    el.textContent = options.label;
  }

  return el;
}
