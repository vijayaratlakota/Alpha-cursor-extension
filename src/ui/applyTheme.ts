/**
 * Alpha Cursor — apply the theme preference to a document-rendered surface.
 *
 * The popup and options pages render in the extension's own document (not a
 * closed Shadow DOM), so they apply the theme by setting `data-acx-theme`
 * (mode) and `data-acx-bg` (light background variant) on the root element. The
 * shadow-host factory does the equivalent for injected content-script surfaces.
 *
 * Call {@link applyThemeToDocument} once at startup; it seeds from the cached
 * preference, refines once storage resolves, and keeps the document in sync
 * with later changes (so changing the theme on the options page updates the
 * popup/options live).
 */

import {
  getCachedTheme,
  getTheme,
  onThemeChanged,
  type ThemePreference,
} from "../shared/settings";

/** Mode attribute (shared with the shadow host). */
const THEME_ATTRIBUTE = "data-acx-theme";
/** Light-mode background variant attribute (shared with the shadow host). */
const BG_ATTRIBUTE = "data-acx-bg";

/** Write the mode + background attributes onto a root element. */
function paint(el: HTMLElement, pref: ThemePreference): void {
  el.setAttribute(THEME_ATTRIBUTE, pref.mode);
  if (pref.mode === "light") {
    el.setAttribute(BG_ATTRIBUTE, pref.background);
  } else {
    el.removeAttribute(BG_ATTRIBUTE);
  }
}

/**
 * Apply the theme preference to `root` (defaults to `document.documentElement`)
 * and keep it in sync with later changes. Returns an unsubscribe function.
 */
export function applyThemeToDocument(
  root: HTMLElement = document.documentElement,
): () => void {
  paint(root, getCachedTheme());
  void getTheme()
    .then((pref) => paint(root, pref))
    .catch(() => {
      /* cached default already applied */
    });
  return onThemeChanged((pref) => paint(root, pref));
}
