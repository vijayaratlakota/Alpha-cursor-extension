/**
 * Alpha Cursor — Notion button primitive (plain-DOM factory).
 *
 * Framework-agnostic factory returning an `HTMLButtonElement` styled with the
 * Tailwind v4 @theme utilities backed by the Notion design tokens (task 3.1).
 * Usable both inside content-script closed Shadow DOM roots and in the
 * popup/options pages that render in the main document.
 *
 * Variants (DESIGN.md):
 *   - `primary`       — Notion blue fill, on-primary text, pill; pressed =
 *                       primary-active. The single structural blue action.
 *   - `secondary`     — white surface, ink text, pill, soft shadow.
 *   - `utility`       — white surface, ink text, 8px radius, 4px/14px padding,
 *                       1px hairline border.
 *   - `icon-circular` — circular translucent rgba(0,0,0,0.05) fill, on-primary
 *                       glyph; inherently icon-only.
 *
 * Accessibility / motion (Req 20):
 *   - 20.3 — primary blue is reserved for the primary action + focus ring.
 *   - 20.5 — a visible `focus-visible` outline in primary blue on keyboard focus.
 *   - 20.6 — every press/scale transition is gated behind `motion-safe:` so the
 *            user's `prefers-reduced-motion` choice is honored.
 *   - 20.7 — icon-only controls MUST supply `ariaLabel`; the API throws if one
 *            is missing and reflects it as the `aria-label` attribute.
 */

import { joinClasses, type ClassValue } from "./classNames";

/** Visual variants for {@link createButton}. */
export type ButtonVariant =
  | "primary"
  | "secondary"
  | "utility"
  | "icon-circular";

/** Options for {@link createButton}. */
export interface CreateButtonOptions {
  /** Visual variant. Defaults to `"primary"`. */
  variant?: ButtonVariant;
  /**
   * Visible text label. Rendered as the button's text content unless
   * {@link CreateButtonOptions.iconOnly} is `true` (or the variant is
   * `"icon-circular"`), in which case it is omitted from the accessible tree
   * and {@link CreateButtonOptions.ariaLabel} must be provided instead.
   */
  label?: string;
  /** Click handler attached via `addEventListener("click", ...)`. */
  onClick?: (event: MouseEvent) => void;
  /**
   * Marks the control as icon-only. When `true` (always true for the
   * `"icon-circular"` variant) an {@link CreateButtonOptions.ariaLabel} is
   * REQUIRED (Req 20.7) and the label text is not rendered.
   */
  iconOnly?: boolean;
  /**
   * Accessible label. Required when the control is icon-only. Reflected to the
   * `aria-label` attribute.
   */
  ariaLabel?: string;
  /**
   * Optional glyph/icon content. A `Node` is appended as-is; a string is set as
   * text content (never as HTML, to avoid injection). Pass an SVG/element node
   * for vector icons.
   */
  icon?: string | Node;
  /** Native button `type`. Defaults to `"button"` to avoid implicit submits. */
  type?: "button" | "submit" | "reset";
  /** Disables the control (`opacity-50` + `not-allowed` cursor per the skill). */
  disabled?: boolean;
  /** Extra class names appended after the variant classes. */
  className?: ClassValue;
}

/**
 * Base classes shared by every button variant: layout, the reserved
 * primary-blue `focus-visible` ring (Req 20.3, 20.5), reduced-motion-gated
 * press transform (Req 20.6), and the disabled treatment.
 */
const BASE_CLASSES =
  "inline-flex items-center justify-center font-sans select-none cursor-pointer border-0 " +
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary " +
  "disabled:opacity-50 disabled:cursor-not-allowed " +
  "motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-90";

/** Variant-specific class strings derived from the DESIGN.md component specs. */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // bg primary, on-primary text, button type, pill; pressed -> primary-active.
  primary:
    "bg-primary text-on-primary text-button rounded-full px-lg py-xs active:bg-primary-active",
  // white surface, ink text, pill, soft shadow.
  secondary:
    "bg-surface text-ink text-button rounded-full px-lg py-xs shadow-soft",
  // white surface, ink text, 8px radius, 4px/14px padding, 1px hairline border.
  utility:
    "bg-surface text-ink text-button rounded-md border border-hairline px-[14px] py-[4px]",
  // circular translucent fill (theme-adaptive), ink glyph; square hit area.
  "icon-circular":
    "bg-fill-subtle text-ink hover:bg-fill-hover rounded-full size-9 p-0",
};

/**
 * Creates a Notion-styled button element.
 *
 * @throws if the control is icon-only (via {@link CreateButtonOptions.iconOnly}
 * or the `"icon-circular"` variant) and no {@link CreateButtonOptions.ariaLabel}
 * is supplied (Req 20.7).
 *
 * @example
 * const cta = createButton({ variant: "primary", label: "Get started", onClick });
 *
 * @example
 * const close = createButton({ variant: "icon-circular", icon: "✕", ariaLabel: "Close" });
 */
export function createButton(
  options: CreateButtonOptions = {},
): HTMLButtonElement {
  const variant: ButtonVariant = options.variant ?? "primary";
  const iconOnly = options.iconOnly ?? variant === "icon-circular";

  if (iconOnly && !options.ariaLabel) {
    throw new Error(
      `createButton: icon-only controls require an "ariaLabel" (Req 20.7). ` +
        `variant="${variant}".`,
    );
  }

  const button = document.createElement("button");
  button.type = options.type ?? "button";
  button.className = joinClasses(
    BASE_CLASSES,
    VARIANT_CLASSES[variant],
    options.className,
  );

  if (options.icon !== undefined) {
    if (typeof options.icon === "string") {
      const glyph = document.createElement("span");
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = options.icon;
      button.appendChild(glyph);
    } else {
      button.appendChild(options.icon);
    }
  }

  if (!iconOnly && options.label !== undefined) {
    button.appendChild(document.createTextNode(options.label));
  }

  // Accessible name: required for icon-only, optional otherwise.
  if (options.ariaLabel) {
    button.setAttribute("aria-label", options.ariaLabel);
  }

  if (options.disabled) {
    button.disabled = true;
  }

  if (options.onClick) {
    button.addEventListener("click", options.onClick);
  }

  return button;
}
