/**
 * Alpha Cursor — Notion text-input primitive (plain-DOM factory).
 *
 * Returns an `HTMLInputElement` styled as the Notion `text-input` (DESIGN.md):
 * white surface, ink text, `body-sm` type, 1px border, `rounded-xs` (4px),
 * `6px` padding. Focus adds the soft Level-1 shadow and the reserved
 * primary-blue focus ring (Req 20.3, 20.5).
 *
 * Inputs deliberately stay tight at `rounded-xs` — never the pill radius used
 * for CTAs (DESIGN.md "Don't put pill radii on form fields").
 *
 * Accessibility (Req 20.7): a text field with no visible `<label>` must carry
 * an accessible name, so the factory requires `ariaLabel` whenever no
 * `labelledBy` association is provided.
 */

import { joinClasses, type ClassValue } from "./classNames";

/** Options for {@link createTextInput}. */
export interface CreateTextInputOptions {
  /** Input `type`. Defaults to `"text"`. */
  type?: string;
  /** Initial value. */
  value?: string;
  /** Placeholder text (styled in ink-faint via the base classes). */
  placeholder?: string;
  /**
   * Accessible label. Reflected to `aria-label`. Required unless
   * {@link CreateTextInputOptions.labelledBy} is supplied so the field always
   * has an accessible name (Req 20.7).
   */
  ariaLabel?: string;
  /**
   * Id of an external visible `<label>`/element describing the field. When
   * provided it is reflected to `aria-labelledby` and `ariaLabel` becomes
   * optional.
   */
  labelledBy?: string;
  /** `name` attribute for form association. */
  name?: string;
  /** Disables the input (`opacity-50` + `not-allowed` cursor). */
  disabled?: boolean;
  /** `input`-event handler, called with the current value and the raw event. */
  onInput?: (value: string, event: Event) => void;
  /** Extra class names appended after the base classes. */
  className?: ClassValue;
}

/**
 * Notion text-input chrome plus the focus treatment. The primary-blue
 * `focus-visible` ring satisfies the reserved-accent + visible-focus
 * requirements; the soft shadow on focus matches the DESIGN.md spec.
 */
const BASE_CLASSES =
  "bg-surface text-ink text-body-sm font-sans rounded-xs p-[6px] border border-hairline " +
  "placeholder:text-ink-faint outline-none " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary " +
  "focus:shadow-soft disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Creates a Notion-styled text input.
 *
 * @throws if neither {@link CreateTextInputOptions.ariaLabel} nor
 * {@link CreateTextInputOptions.labelledBy} is provided (the field would have
 * no accessible name — Req 20.7).
 *
 * @example
 * const search = createTextInput({ ariaLabel: "Search sites", placeholder: "example.com" });
 */
export function createTextInput(
  options: CreateTextInputOptions = {},
): HTMLInputElement {
  if (!options.ariaLabel && !options.labelledBy) {
    throw new Error(
      `createTextInput: provide an "ariaLabel" or "labelledBy" so the field ` +
        `has an accessible name (Req 20.7).`,
    );
  }

  const input = document.createElement("input");
  input.type = options.type ?? "text";
  input.className = joinClasses(BASE_CLASSES, options.className);

  if (options.value !== undefined) input.value = options.value;
  if (options.placeholder !== undefined)
    input.placeholder = options.placeholder;
  if (options.name !== undefined) input.name = options.name;
  if (options.ariaLabel) input.setAttribute("aria-label", options.ariaLabel);
  if (options.labelledBy)
    input.setAttribute("aria-labelledby", options.labelledBy);
  if (options.disabled) input.disabled = true;

  if (options.onInput) {
    const handler = options.onInput;
    input.addEventListener("input", (event) => {
      handler((event.target as HTMLInputElement).value, event);
    });
  }

  return input;
}
