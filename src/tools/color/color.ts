/**
 * Alpha Cursor — Color Picker pure helpers (task 18.1).
 *
 * PURE, side-effect-free functions backing Tool 9 (Color Picker). They convert
 * a sampled color to a paste-ready lowercase `#rrggbb` hex token (Req 14.7) and
 * support the round-trip property (Property 16): for any integer RGB triple in
 * 0–255, `rgbToHex` / `formatColor` produce a valid hex token that
 * `hexToRgb` decodes back to the exact same channel values.
 *
 * None of these functions touch `chrome.*`, the DOM, the `EyeDropper` API, or
 * any ambient state — the eyedropper/overlay wiring lives in task 18.3. They are
 * exported cleanly for property-based testing (Property 16 in task 18.2).
 */

/** A sampled color as individual red/green/blue channels (0–255). */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Clamp `value` into the 0–255 channel range and round to the nearest integer.
 * Non-finite input (`NaN`, `Infinity`) collapses to `0` so a single channel can
 * never poison the resulting token.
 */
function clampChannel(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const rounded = Math.round(value);
  if (rounded < 0) {
    return 0;
  }
  if (rounded > 255) {
    return 255;
  }
  return rounded;
}

/** Format a clamped 0–255 channel as a zero-padded, lowercase 2-digit hex pair. */
function channelToHexPair(channel: number): string {
  return channel.toString(16).padStart(2, "0");
}

/**
 * Convert red/green/blue channels to a paste-ready lowercase `#rrggbb` hex
 * string (Req 14.7). Each channel is clamped to 0–255, rounded to an integer,
 * and padded to two hex digits, so the result is always exactly seven
 * characters (`#` + six lowercase hex digits).
 *
 * @param r Red channel; clamped/rounded to 0–255.
 * @param g Green channel; clamped/rounded to 0–255.
 * @param b Blue channel; clamped/rounded to 0–255.
 * @returns A `#rrggbb` token, e.g. `rgbToHex(255, 0, 128)` → `"#ff0080"`.
 */
export function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    channelToHexPair(clampChannel(r)) +
    channelToHexPair(clampChannel(g)) +
    channelToHexPair(clampChannel(b))
  );
}

/**
 * Parse a hex color string into its red/green/blue channels, or `null` when the
 * input is not a valid hex color. Supports both shorthand `#rgb` and full
 * `#rrggbb` forms, with or without the leading `#`, case-insensitively. The
 * shorthand form expands each nibble (`#abc` → `#aabbcc`).
 *
 * This is the inverse of {@link rgbToHex} for integer channels and backs the
 * round-trip property (Property 16).
 *
 * @param hex A hex color string such as `"#ff0080"`, `"ff0080"`, or `"#f08"`.
 * @returns The decoded {@link Rgb}, or `null` if `hex` is not a valid color.
 */
export function hexToRgb(hex: string): Rgb | null {
  if (typeof hex !== "string") {
    return null;
  }

  const body = hex.startsWith("#") ? hex.slice(1) : hex;

  let normalized: string;
  if (/^[0-9a-fA-F]{3}$/.test(body)) {
    // Expand shorthand #rgb → #rrggbb.
    normalized = body
      .split("")
      .map((nibble) => nibble + nibble)
      .join("");
  } else if (/^[0-9a-fA-F]{6}$/.test(body)) {
    normalized = body;
  } else {
    return null;
  }

  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

/** Parse an `rgb(r, g, b)` / `rgba(r, g, b, a)` CSS string into channels. */
function parseRgbString(value: string): Rgb | null {
  const match = value
    .trim()
    .match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/i);
  if (!match) {
    return null;
  }
  return {
    r: clampChannel(Number(match[1])),
    g: clampChannel(Number(match[2])),
    b: clampChannel(Number(match[3])),
  };
}

/**
 * Normalize a sampled color into the paste-ready `#rrggbb` token (Req 14.7).
 *
 * Accepts the shapes the color picker may produce:
 *  - An {@link Rgb} object `{ r, g, b }` (e.g. from a Canvas sample) — channels
 *    are clamped/rounded via {@link rgbToHex}.
 *  - A CSS `rgb(r, g, b)` / `rgba(r, g, b, a)` string.
 *  - An already-hex string (`#rrggbb` or shorthand `#rgb`, with or without `#`).
 *
 * The output is always a valid lowercase `#rrggbb` token that round-trips
 * through {@link hexToRgb}. Unparseable input falls back to `"#000000"` so the
 * caller always receives a paste-ready value.
 *
 * @param sample The sampled color as an {@link Rgb} object or string.
 * @returns A paste-ready `#rrggbb` token.
 */
export function formatColor(sample: Rgb | string): string {
  if (typeof sample === "string") {
    const fromHex = hexToRgb(sample);
    if (fromHex) {
      return rgbToHex(fromHex.r, fromHex.g, fromHex.b);
    }
    const fromRgb = parseRgbString(sample);
    if (fromRgb) {
      return rgbToHex(fromRgb.r, fromRgb.g, fromRgb.b);
    }
    return "#000000";
  }

  if (sample && typeof sample === "object") {
    return rgbToHex(sample.r, sample.g, sample.b);
  }

  return "#000000";
}
