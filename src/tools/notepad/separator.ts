/**
 * Alpha Cursor — Notepad separator + join pure helpers (task 11.1).
 *
 * Two PURE, side-effect-free functions backing Tool 1 (Notepad Clipboard):
 *
 *  - {@link resolveSeparator} maps a stored {@link SeparatorConfig} (or a loose
 *    string / missing value) to the literal separator string used when joining
 *    Notepad entries, defaulting to a comma whenever the configuration is
 *    missing, invalid, empty, or corrupted (Req 5.5).
 *  - {@link joinEntries} concatenates ordered entries placing the separator
 *    ONLY between consecutive entries — the same result "Copy All" writes to the
 *    clipboard (Req 5.6, 6.2).
 *
 * Both are exported cleanly for property-based testing (Property 6 in task 11.2
 * and Property 7 in task 11.3). They never touch `chrome.*`, the DOM, or any
 * other ambient state.
 */

import type { SeparatorConfig } from "../../shared/settings";

/**
 * The default separator applied whenever a configuration is missing, invalid,
 * empty, or corrupted (Req 5.5). A bare comma — the join logic does not add
 * surrounding whitespace, so the separator is exactly the characters chosen.
 */
export const DEFAULT_SEPARATOR = ",";

/**
 * Literal separator characters for each preset {@link SeparatorConfig.kind}.
 * `custom` is intentionally absent: its value comes from the config's `custom`
 * field (or the default when that is unusable).
 */
const PRESET_SEPARATORS: Record<"comma" | "dash" | "slash", string> = {
  comma: ",",
  dash: "-",
  slash: "/",
};

/** True when `value` is a usable, non-empty separator string. */
function isUsableString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Resolve a raw separator configuration to the literal separator string.
 *
 * Accepts a {@link SeparatorConfig} object, a plain string, or `null`/
 * `undefined`, and always returns a valid, non-empty separator (Property 6):
 *
 *  - `null` / `undefined` / non-object, non-string values → {@link DEFAULT_SEPARATOR}.
 *  - A {@link SeparatorConfig} with `kind` `"comma"` → `","`, `"dash"` → `"-"`,
 *    `"slash"` → `"/"`. For `"custom"`, the config's `custom` string is used
 *    when it is a non-empty string, otherwise {@link DEFAULT_SEPARATOR}. An
 *    unrecognized/corrupted `kind` → {@link DEFAULT_SEPARATOR}.
 *  - A plain string equal to a known kind name (`"comma"`, `"dash"`, `"slash"`)
 *    maps to that preset; the bare string `"custom"` (with no value) →
 *    {@link DEFAULT_SEPARATOR}. Any other non-empty string is treated as a
 *    literal separator; an empty string → {@link DEFAULT_SEPARATOR}.
 *
 * @param raw The stored separator configuration, a literal string, or nothing.
 * @returns A valid separator string; never empty.
 */
export function resolveSeparator(
  raw: SeparatorConfig | string | null | undefined,
): string {
  if (raw == null) {
    return DEFAULT_SEPARATOR;
  }

  if (typeof raw === "string") {
    return resolveFromKindString(raw);
  }

  if (typeof raw === "object") {
    const kind = (raw as Partial<SeparatorConfig>).kind;
    if (kind === "custom") {
      const custom = (raw as Partial<SeparatorConfig>).custom;
      return isUsableString(custom) ? custom : DEFAULT_SEPARATOR;
    }
    if (kind === "comma" || kind === "dash" || kind === "slash") {
      return PRESET_SEPARATORS[kind];
    }
    // Missing / unrecognized / corrupted kind.
    return DEFAULT_SEPARATOR;
  }

  // numbers, booleans, symbols, etc. — not a valid configuration.
  return DEFAULT_SEPARATOR;
}

/**
 * Interpret a plain string as either a preset kind name or a literal separator.
 */
function resolveFromKindString(value: string): string {
  if (value === "comma" || value === "dash" || value === "slash") {
    return PRESET_SEPARATORS[value];
  }
  if (value === "custom") {
    // "custom" with no accompanying value carries no usable separator.
    return DEFAULT_SEPARATOR;
  }
  // Any other non-empty string is itself the separator; empty → default.
  return value.length > 0 ? value : DEFAULT_SEPARATOR;
}

/**
 * Join ordered Notepad entries, inserting `separator` ONLY between consecutive
 * entries (Property 7). The number of separators is exactly `max(0, n - 1)`,
 * entry order is preserved, and an empty list yields `""`. This is the same
 * string "Copy All" writes to the clipboard (Req 6.2).
 *
 * Implemented explicitly (rather than `entries.join`) per the task, and guards
 * a non-array input by returning `""`.
 *
 * @param entries Ordered entry texts.
 * @param separator The separator placed between consecutive entries.
 * @returns The joined string.
 */
export function joinEntries(entries: string[], separator: string): string {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "";
  }

  let result = entries[0] ?? "";
  for (let i = 1; i < entries.length; i++) {
    result += separator + (entries[i] ?? "");
  }
  return result;
}
