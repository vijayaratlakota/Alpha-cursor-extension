// Ambient declaration for the native EyeDropper API (Tool 9 — Color Picker).
//
// The EyeDropper API (https://developer.mozilla.org/docs/Web/API/EyeDropper) is
// supported in Chromium-based browsers but is not yet part of the TypeScript
// `lib.dom.d.ts` shipped with the project's TS version. Without this minimal
// declaration, `new EyeDropper()` / `window.EyeDropper` would error under the
// strict tsconfig.
//
// We model only the surface the color picker touches: the constructor and the
// `open()` method, which resolves with the sampled color as an sRGB hex string
// and rejects with an `AbortError` `DOMException` when the user cancels (e.g.
// presses Escape).

/** Result of a successful {@link EyeDropper.open} call. */
interface ColorSelectionResult {
  /** The sampled color as an sRGB hex string, e.g. `"#ff0080"`. */
  sRGBHex: string;
}

/** Options accepted by {@link EyeDropper.open} (e.g. an `AbortSignal`). */
interface ColorSelectionOptions {
  signal?: AbortSignal;
}

/**
 * The native eyedropper. Calling {@link EyeDropper.open} enters a screen-wide
 * sampling mode; the returned promise resolves with the picked color or rejects
 * with an `AbortError` `DOMException` when the user cancels.
 */
interface EyeDropper {
  open(options?: ColorSelectionOptions): Promise<ColorSelectionResult>;
}

interface EyeDropperConstructor {
  new (): EyeDropper;
}

interface Window {
  EyeDropper?: EyeDropperConstructor;
}

declare const EyeDropper: EyeDropperConstructor | undefined;
