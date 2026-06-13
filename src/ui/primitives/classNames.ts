/**
 * Alpha Cursor — tiny class-name joiner for the UI primitives.
 *
 * The primitives style themselves with Tailwind utility class strings. This
 * helper composes those strings together with optional, possibly-falsy extras
 * supplied by callers, so each factory can accept an open-ended `className`
 * without scattering null/array handling everywhere.
 *
 * It intentionally has no dependency on Tailwind itself — it just flattens and
 * filters class values into a single space-separated string.
 */

/** Anything acceptable as a class-name fragment. */
export type ClassValue =
  | string
  | number
  | false
  | null
  | undefined
  | ClassValue[];

/**
 * Flattens and joins class values into a single, space-separated string,
 * dropping falsy entries and collapsing repeated whitespace.
 */
export function joinClasses(...values: ClassValue[]): string {
  const out: string[] = [];
  const walk = (value: ClassValue): void => {
    if (!value && value !== 0) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const str = String(value).trim();
    if (str) out.push(str);
  };
  for (const value of values) walk(value);
  return out.join(" ").replace(/\s+/g, " ").trim();
}
