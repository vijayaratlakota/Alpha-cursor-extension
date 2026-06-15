/**
 * Alpha Cursor — Shadow DOM style injection helpers.
 *
 * The content-script UI (Options_Panel, OCR overlay, color picker, tab shifter,
 * notifications) mounts inside CLOSED Shadow DOM roots so host-page CSS cannot
 * bleed in and the extension's CSS cannot bleed out. To style those roots we
 * need the compiled stylesheet as a STRING that we can adopt into each root.
 *
 * Vite gives us two suffixes for importing CSS as a string instead of injecting
 * it into the document `<head>`:
 *   - `?inline` — returns the processed CSS (Tailwind/PostCSS transforms run).
 *   - `?raw`    — returns the file contents verbatim (no processing).
 *
 * We import the Tailwind entry stylesheet with `?inline` so the `@theme` block,
 * `@import "tailwindcss"`, and base layer are all compiled to real CSS before
 * we inject it. The raw token-only sheet (`tokens.css`) is also available via
 * `?inline` for surfaces that want just the custom properties.
 *
 * Usage (in a content-script UI factory):
 *
 *     import { sharedStyleSheet } from "@/ui/styles/theme";
 *
 *     const host = document.createElement("div");
 *     const root = host.attachShadow({ mode: "closed" });
 *     root.adoptedStyleSheets = [sharedStyleSheet()];
 *
 * `adoptedStyleSheets` + `CSSStyleSheet` is the cheapest way to share one
 * parsed sheet across many shadow roots. We construct it lazily and cache it so
 * every panel reuses the same `CSSStyleSheet` instance.
 */

// Compiled Tailwind output (tokens + utilities + base layer) as a string.
import compiledCss from "./tailwind.css?inline";
// Raw design tokens only (no Tailwind utilities) as a string.
import tokensCss from "./tokens.css?inline";

/**
 * Rewrite the bundled font `url("/fonts/…")` (root-relative) to an absolute
 * `chrome-extension://…` URL via `chrome.runtime.getURL`. This is required for
 * content-script Shadow DOM surfaces injected into a host page, where a
 * root-relative URL would resolve against the PAGE origin (e.g.
 * `https://youtube.com/fonts/…`) and fail to load the bundled VT323 face. On
 * the extension's own pages the relative URL already works, but rewriting is
 * harmless there too. No-op when `chrome.runtime.getURL` is unavailable (tests).
 */
function resolveBundledFontUrls(css: string): string {
  const getURL = (globalThis as { chrome?: typeof chrome }).chrome?.runtime
    ?.getURL;
  if (typeof getURL !== "function") return css;
  // Match url("/fonts/x"), url('/fonts/x'), url(/fonts/x).
  return css.replace(
    /url\((['"]?)\/fonts\/([^'")]+)\1\)/g,
    (_match, quote: string, file: string) =>
      `url(${quote}${getURL(`fonts/${file}`)}${quote})`,
  );
}

/**
 * The compiled, ready-to-inject shared stylesheet string (Tailwind utilities +
 * design tokens + base defaults), with bundled font URLs resolved to absolute
 * extension URLs. Importable wherever a raw style string is needed.
 */
export const sharedStyleString: string = resolveBundledFontUrls(compiledCss);

/**
 * The token-only style string (`--acx-*` custom properties). Use when a surface
 * needs only the design variables without the full Tailwind utility layer.
 */
export const tokensStyleString: string = tokensCss;

let cachedSheet: CSSStyleSheet | null = null;

/**
 * Returns a shared, lazily-constructed `CSSStyleSheet` carrying the full
 * compiled Tailwind + Notion-token CSS. The same instance is reused across all
 * Shadow DOM roots, so adopting it is effectively free after the first call.
 *
 * Assign the result into a shadow root's `adoptedStyleSheets`:
 *
 *     root.adoptedStyleSheets = [sharedStyleSheet()];
 */
export function sharedStyleSheet(): CSSStyleSheet {
  if (cachedSheet) return cachedSheet;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(sharedStyleString);
  cachedSheet = sheet;
  return sheet;
}

/**
 * Fallback injector for environments without constructable-stylesheet support:
 * appends a `<style>` element carrying the shared CSS to the given root.
 * Returns the created element so callers can remove it on teardown.
 */
export function injectStyleElement(
  root: ShadowRoot | Document | HTMLElement,
  css: string = sharedStyleString,
): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = css;
  root.appendChild(style);
  return style;
}

/**
 * Attaches the shared styles to a shadow root, preferring constructable
 * stylesheets and falling back to a `<style>` element. This is the recommended
 * entry point for content-script UI factories.
 */
export function applySharedStyles(root: ShadowRoot): void {
  if ("adoptedStyleSheets" in root && typeof CSSStyleSheet === "function") {
    try {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sharedStyleSheet()];
      return;
    } catch {
      // Some engines throw if the sheet was constructed in another realm;
      // fall through to the <style> element approach.
    }
  }
  injectStyleElement(root);
}
