/**
 * Alpha Cursor — Options page (tasks 25.1, 25.2, 26.2).
 *
 * The Options page is the single home for configuration (Req 19) and the
 * privacy statement (Req 21.4). It renders in the extension's main document
 * (not a content-script Shadow DOM), so the compiled Tailwind v4 + Notion-token
 * stylesheet is imported directly below so the utility classes resolve here,
 * exactly as the popup does.
 *
 * Sections (Req mapping):
 *   1. Header + description.
 *   2. Global Toggle row — reflects the live state and lets the user change it
 *      (Req 19.4); seeds from `getEnabled()`, persists via `setEnabled()`, and
 *      reflects external changes via `onEnabledChanged()`.
 *   3. Separator config (Req 5.1, 5.2): comma / dash / slash / custom; when
 *      "custom" is chosen a text input collects the custom string. Persisted via
 *      `saveSeparator` (Req 5.3) without blocking interaction (Req 19.3);
 *      persistence failure is silent and applies for the session (Req 5.4).
 *   4. "Search in" site list (Req 12.6): list / add / remove / reorder, seeded
 *      from `DEFAULT_SEARCH_SITES` when empty, persisted via `saveSearchSites`
 *      with contiguous order.
 *   5. Sync preference (Req 19.2): "chrome-sync" vs "local-only", persisted via
 *      `saveSyncPreference`. Neither contacts any Alpha Cursor server.
 *   6. Clear all data (Req 19.6, 21.7): confirmation dialog wired to
 *      `storage.clearAll(profileId)`.
 *   7. Privacy statement (Req 21.4): plain-language local-only disclosure,
 *      "cloud sync" = Chrome `storage.sync`, and the Web Speech API nuance.
 *
 * Persistence policy (Req 19.3): every change is fire-and-forget (`void`-ed
 * promise) so the user keeps interacting while the write lands well within the
 * 500ms budget. The settings layer (`saveSettings`) already swallows sync
 * errors, so persistence failures never surface a blocking error (Req 5.4).
 *
 * Accessibility (Req 20): radios use native `<input type="radio">` for built-in
 * keyboard semantics, icon-only reorder/remove controls carry `aria-label`s
 * (Req 20.7), and the focus rings + reduced-motion handling come from the
 * primitives. A polite `aria-live` status region announces saves.
 */

// Pull the compiled Tailwind + Notion-token stylesheet into the options page so
// the utility classes used below resolve (the popup does the same).
import "../ui/styles/tailwind.css";

import { createButton } from "../ui/primitives/button";
import { createCard } from "../ui/primitives/card";
import { createTextInput } from "../ui/primitives/textInput";
import { joinClasses } from "../ui/primitives/classNames";
import { confirmDialog } from "./confirmDialog";
import { applyThemeToDocument } from "../ui/applyTheme";
import { requireProfile } from "../shared/identity";
import { clearAll } from "../shared/storage";
import { DEFAULT_SEARCH_SITES, QUERY_PLACEHOLDER } from "../tools/search/searchUrl";
import {
  loadSettings,
  saveSeparator,
  saveSearchSites,
  saveSyncPreference,
  getEnabled,
  getCachedEnabled,
  setEnabled,
  onEnabledChanged,
  getFeatureFlags,
  setFeatureFlag,
  FEATURE_FLAG_KEYS,
  DEFAULT_FEATURE_FLAGS,
  getTheme,
  setTheme,
  THEME_BACKGROUNDS,
  DEFAULT_THEME,
  getPanelStyle,
  setPanelStyle,
  DEFAULT_PANEL_STYLE,
  type PanelStyle,
  type ThemePreference,
  type ThemeMode,
  type ThemeBackground,
  DEFAULT_SEPARATOR_CONFIG,
  DEFAULT_SYNC_PREFERENCE,
  type FeatureFlags,
  type SeparatorConfig,
  type SearchSite,
  type Settings,
} from "../shared/settings";

// ---------------------------------------------------------------------------
// Pure helpers (exported for reuse / task 25.3 tests)
// ---------------------------------------------------------------------------

/** A unique id for a newly-added search site (crypto UUID, fallback to time). */
function makeSiteId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return `site-${cryptoObj.randomUUID()}`;
  }
  return `site-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * Re-number a list of search sites so `order` is contiguous and zero-based,
 * preserving the array's current sequence. Returned list is a fresh copy; the
 * input is not mutated. Keeping order contiguous is the invariant the list
 * relies on after every add / remove / reorder (Req 12.6).
 */
export function normalizeSiteOrder(sites: SearchSite[]): SearchSite[] {
  return sites.map((site, index) => ({ ...site, order: index }));
}

/**
 * Return the sites sorted by their `order` field (stable for equal orders).
 * Used to render the persisted list in user-defined sequence.
 */
export function sortSitesByOrder(sites: SearchSite[]): SearchSite[] {
  return [...sites].sort((a, b) => a.order - b.order);
}

/**
 * Move the site at `index` one slot toward `direction` ("up" decreases the
 * index, "down" increases it) and renumber. Out-of-range moves are no-ops
 * (returns a normalized copy unchanged in sequence).
 */
export function moveSite(
  sites: SearchSite[],
  index: number,
  direction: "up" | "down",
): SearchSite[] {
  const next = [...sites];
  const target = direction === "up" ? index - 1 : index + 1;
  const a = next[index];
  const b = next[target];
  if (a === undefined || b === undefined) {
    return normalizeSiteOrder(next);
  }
  next[index] = b;
  next[target] = a;
  return normalizeSiteOrder(next);
}

/**
 * Seed the search-site list from {@link DEFAULT_SEARCH_SITES} when the persisted
 * list is empty/missing, otherwise return the persisted list sorted by order
 * and renumbered contiguously (Req 12.1, 12.6).
 */
export function seedSearchSites(sites: SearchSite[] | undefined): SearchSite[] {
  if (!sites || sites.length === 0) {
    return DEFAULT_SEARCH_SITES.map((site) => ({ ...site }));
  }
  return normalizeSiteOrder(sortSitesByOrder(sites));
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

/** Create a section heading (`h2`) styled per the Notion type scale. */
function sectionHeading(text: string): HTMLHeadingElement {
  const h = document.createElement("h2");
  h.className = "m-0 text-heading-3 font-sans text-ink";
  h.textContent = text;
  return h;
}

/** Create supporting/muted descriptive copy. */
function description(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "m-0 mt-xxs text-caption font-sans text-ink-muted";
  p.textContent = text;
  return p;
}

/** Build a labelled section card with a heading + optional description. */
function sectionCard(
  title: string,
  desc: string | undefined,
  body: HTMLElement,
): HTMLElement {
  const head = document.createElement("div");
  head.className = "flex flex-col";
  head.appendChild(sectionHeading(title));
  if (desc) head.appendChild(description(desc));

  const wrapper = document.createElement("div");
  wrapper.className = "flex flex-col gap-md";
  wrapper.append(head, body);

  const card = createCard({ as: "section", children: wrapper });
  card.setAttribute("aria-label", title);
  return card;
}

// ---------------------------------------------------------------------------
// Status (aria-live) region — announces saves (Req 19.3)
// ---------------------------------------------------------------------------

interface StatusRegion {
  el: HTMLElement;
  show(text: string, kind?: "info" | "success" | "error"): void;
}

function createStatusRegion(): StatusRegion {
  const el = document.createElement("p");
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.className = "m-0 min-h-[1.43em] text-caption font-sans text-ink-muted";

  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = (text: string, kind: "info" | "success" | "error" = "info"): void => {
    if (timer !== undefined) clearTimeout(timer);
    el.textContent = text;
    el.className = joinClasses(
      "m-0 min-h-[1.43em] text-caption font-sans",
      kind === "error" ? "text-accent-orange-deep" : "text-ink-muted",
    );
    if (text) {
      timer = setTimeout(() => {
        el.textContent = "";
      }, 3000);
    }
  };

  return { el, show };
}

// ---------------------------------------------------------------------------
// Global Toggle row (Req 19.4)
// ---------------------------------------------------------------------------

interface ToggleHandle {
  el: HTMLElement;
  setState(enabled: boolean): void;
}

/**
 * Build the global ON/OFF Toggle as an accessible `role="switch"` control,
 * mirroring the popup's switch so the Options page reflects and changes the
 * same live state (Req 19.4). `onChange` fires only on user interaction;
 * `setState` reflects external changes without re-firing.
 */
function createToggleRow(onChange: (enabled: boolean) => void): ToggleHandle {
  const row = document.createElement("div");
  row.className = joinClasses(
    "flex items-center justify-between gap-md",
    "px-md py-sm rounded-md bg-canvas-soft border border-hairline",
  );

  const labelWrap = document.createElement("div");
  labelWrap.className = "flex flex-col";

  const labelId = "acx-options-toggle-label";
  const title = document.createElement("span");
  title.id = labelId;
  title.className = "text-body-md font-sans text-ink";
  title.textContent = "Alpha Cursor";

  const stateText = document.createElement("span");
  stateText.className = "text-caption font-sans text-ink-muted";

  labelWrap.append(title, stateText);

  const sw = document.createElement("button");
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-labelledby", labelId);
  sw.className = joinClasses(
    "relative inline-flex items-center shrink-0 cursor-pointer",
    "w-[46px] h-[26px] rounded-full border-2 border-hairline-strong p-0",
    "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
    "motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out",
  );

  const knob = document.createElement("span");
  knob.setAttribute("aria-hidden", "true");
  knob.className = joinClasses(
    "absolute top-[1px] left-[1px] size-[20px] rounded-full bg-surface border-2 border-hairline-strong",
    "motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out",
  );
  sw.appendChild(knob);

  // Seed from the cached/default state (default-on) so the switch reflects the
  // real state immediately rather than flashing OFF before storage resolves.
  let current = getCachedEnabled();

  const paint = (enabled: boolean): void => {
    sw.setAttribute("aria-checked", String(enabled));
    sw.style.backgroundColor = enabled
      ? "var(--acx-color-primary)"
      : "var(--acx-color-canvas-soft)";
    knob.style.transform = enabled ? "translateX(18px)" : "translateX(0)";
    stateText.textContent = enabled ? "On" : "Off";
  };

  paint(current);

  sw.addEventListener("click", () => {
    current = !current;
    paint(current);
    onChange(current);
  });

  row.append(labelWrap, sw);

  return {
    el: row,
    setState(enabled: boolean): void {
      current = enabled;
      paint(enabled);
    },
  };
}

// ---------------------------------------------------------------------------
// Separator config (Req 5.1, 5.2)
// ---------------------------------------------------------------------------

const SEPARATOR_PRESETS: { kind: SeparatorConfig["kind"]; label: string }[] = [
  { kind: "comma", label: "Comma  ( , )" },
  { kind: "dash", label: "Dash  ( - )" },
  { kind: "slash", label: "Slash  ( / )" },
  { kind: "custom", label: "Custom…" },
];

/**
 * Build the separator radio group plus the conditional custom-string input.
 * `onChange` is invoked with the resolved {@link SeparatorConfig} after any
 * user edit; persistence is the caller's responsibility (kept non-blocking).
 */
function createSeparatorControl(
  initial: SeparatorConfig,
  onChange: (config: SeparatorConfig) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "flex flex-col gap-sm";

  const radioGroup = document.createElement("div");
  radioGroup.setAttribute("role", "radiogroup");
  radioGroup.setAttribute("aria-label", "Entry separator");
  radioGroup.className = "flex flex-col gap-xxs";

  const groupName = "acx-separator";
  let currentKind: SeparatorConfig["kind"] = initial.kind;
  let customValue = initial.custom ?? "";

  // Custom input row (shown only when "custom" is selected, Req 5.2).
  const customRow = document.createElement("div");
  customRow.className = "flex flex-col gap-xxs pl-lg";

  const customInput = createTextInput({
    ariaLabel: "Custom separator characters",
    placeholder: "e.g. \" | \"",
    value: customValue,
    onInput: (value) => {
      customValue = value;
      if (currentKind === "custom") {
        onChange({ kind: "custom", custom: customValue });
      }
    },
  });
  customInput.classList.add("max-w-[220px]");
  const customHint = description(
    "Used verbatim between entries. Falls back to a comma if left empty or invalid.",
  );
  customRow.append(customInput, customHint);

  const syncCustomVisibility = (): void => {
    customRow.style.display = currentKind === "custom" ? "flex" : "none";
  };

  for (const preset of SEPARATOR_PRESETS) {
    const label = document.createElement("label");
    label.className = joinClasses(
      "flex items-center gap-sm cursor-pointer",
      "text-body-sm font-sans text-ink-secondary",
    );

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = groupName;
    radio.value = preset.kind;
    radio.checked = preset.kind === currentKind;
    radio.className = joinClasses(
      "size-4 accent-primary cursor-pointer",
      "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
    );
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      currentKind = preset.kind;
      syncCustomVisibility();
      if (currentKind === "custom") {
        onChange({ kind: "custom", custom: customValue });
        customInput.focus();
      } else {
        onChange({ kind: currentKind });
      }
    });

    const text = document.createElement("span");
    text.textContent = preset.label;

    label.append(radio, text);
    radioGroup.appendChild(label);
  }

  wrap.append(radioGroup, customRow);
  syncCustomVisibility();
  return wrap;
}

// ---------------------------------------------------------------------------
// "Search in" site list (Req 12.6)
// ---------------------------------------------------------------------------

/**
 * Build the editable "Search in" site list with add / remove / reorder. The
 * list is kept in `state.sites` (order-contiguous) and re-rendered on every
 * mutation; `onChange` receives the new normalized list for persistence.
 */
function createSearchSitesControl(
  initial: SearchSite[],
  onChange: (sites: SearchSite[]) => void,
): HTMLElement {
  const state = { sites: seedSearchSites(initial) };

  const wrap = document.createElement("div");
  wrap.className = "flex flex-col gap-md";

  const listEl = document.createElement("ul");
  listEl.className = "m-0 p-0 list-none flex flex-col gap-xs";

  // Commit + re-render helper.
  const commit = (next: SearchSite[]): void => {
    state.sites = normalizeSiteOrder(next);
    renderList();
    onChange(state.sites);
  };

  function renderList(): void {
    listEl.replaceChildren();

    if (state.sites.length === 0) {
      const empty = document.createElement("li");
      empty.className = joinClasses(
        "rounded-md bg-canvas-soft px-md py-sm",
        "text-caption font-sans text-ink-faint",
      );
      empty.textContent = "No sites yet. Add one below.";
      listEl.appendChild(empty);
      return;
    }

    state.sites.forEach((site, index) => {
      const item = document.createElement("li");
      item.className = joinClasses(
        "flex items-center gap-sm",
        "rounded-md bg-canvas-soft border border-hairline px-sm py-xs",
      );

      const info = document.createElement("div");
      info.className = "flex flex-col min-w-0 grow";

      const label = document.createElement("span");
      label.className = "text-body-sm font-sans text-ink truncate";
      label.textContent = site.label;

      const tmpl = document.createElement("span");
      tmpl.className = "text-caption font-sans text-ink-faint truncate";
      tmpl.textContent = site.urlTemplate;
      tmpl.title = site.urlTemplate;

      info.append(label, tmpl);

      const controls = document.createElement("div");
      controls.className = "flex items-center gap-xs shrink-0";

      const upBtn = createButton({
        variant: "utility",
        icon: "↑",
        iconOnly: true,
        ariaLabel: `Move ${site.label} up`,
        disabled: index === 0,
        onClick: () => commit(moveSite(state.sites, index, "up")),
      });
      const downBtn = createButton({
        variant: "utility",
        icon: "↓",
        iconOnly: true,
        ariaLabel: `Move ${site.label} down`,
        disabled: index === state.sites.length - 1,
        onClick: () => commit(moveSite(state.sites, index, "down")),
      });
      const removeBtn = createButton({
        variant: "utility",
        icon: "✕",
        iconOnly: true,
        ariaLabel: `Remove ${site.label}`,
        onClick: () =>
          commit(state.sites.filter((_, i) => i !== index)),
      });

      controls.append(upBtn, downBtn, removeBtn);
      item.append(info, controls);
      listEl.appendChild(item);
    });
  }

  // ── Add-site form ─────────────────────────────────────────────────
  const form = document.createElement("form");
  form.className = joinClasses(
    "flex flex-col gap-sm",
    "rounded-md bg-canvas-soft border border-hairline p-sm",
  );

  const labelInput = createTextInput({
    ariaLabel: "New site label",
    placeholder: "Label (e.g. DuckDuckGo)",
  });
  const urlInput = createTextInput({
    ariaLabel: "New site search URL with {q} placeholder",
    placeholder: `Search URL with ${QUERY_PLACEHOLDER} (e.g. https://duckduckgo.com/?q=${QUERY_PLACEHOLDER})`,
  });
  urlInput.classList.add("w-full");
  labelInput.classList.add("w-full");

  const addError = document.createElement("p");
  addError.setAttribute("role", "alert");
  addError.className = "m-0 text-caption font-sans text-accent-orange-deep";
  addError.style.display = "none";

  const addBtn = createButton({
    variant: "primary",
    label: "Add site",
    type: "submit",
  });
  const addBtnRow = document.createElement("div");
  addBtnRow.className = "flex justify-end";
  addBtnRow.appendChild(addBtn);

  const showAddError = (msg: string): void => {
    addError.textContent = msg;
    addError.style.display = msg ? "block" : "none";
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const label = labelInput.value.trim();
    const urlTemplate = urlInput.value.trim();

    if (!label) {
      showAddError("Enter a label for the site.");
      labelInput.focus();
      return;
    }
    if (!urlTemplate.includes(QUERY_PLACEHOLDER)) {
      showAddError(`The search URL must include the ${QUERY_PLACEHOLDER} placeholder.`);
      urlInput.focus();
      return;
    }

    showAddError("");
    const newSite: SearchSite = {
      id: makeSiteId(),
      label,
      urlTemplate,
      order: state.sites.length,
    };
    commit([...state.sites, newSite]);
    labelInput.value = "";
    urlInput.value = "";
    labelInput.focus();
  });

  form.append(labelInput, urlInput, addError, addBtnRow);

  wrap.append(listEl, form);
  renderList();
  return wrap;
}

// ---------------------------------------------------------------------------
// Sync preference (Req 19.2)
// ---------------------------------------------------------------------------

const SYNC_OPTIONS: {
  value: "chrome-sync" | "local-only";
  label: string;
  hint: string;
}[] = [
  {
    value: "chrome-sync",
    label: "Sync with Chrome",
    hint: "Settings follow your Chrome profile via the browser's built-in storage.sync. No Alpha Cursor server is involved.",
  },
  {
    value: "local-only",
    label: "Keep on this device only",
    hint: "Settings stay in this browser's local storage and never leave the device.",
  },
];

/**
 * Build the sync-preference radio group. Each option is clearly labelled so the
 * user understands neither choice uses any Alpha Cursor server (Req 19.2).
 */
function createSyncPreferenceControl(
  initial: "chrome-sync" | "local-only",
  onChange: (pref: "chrome-sync" | "local-only") => void,
): HTMLElement {
  const group = document.createElement("div");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Synchronization preference");
  group.className = "flex flex-col gap-sm";

  const groupName = "acx-sync-pref";
  let current = initial;

  for (const option of SYNC_OPTIONS) {
    const label = document.createElement("label");
    label.className = joinClasses(
      "flex items-start gap-sm cursor-pointer",
      "rounded-md bg-canvas-soft border border-hairline px-sm py-xs",
    );

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = groupName;
    radio.value = option.value;
    radio.checked = option.value === current;
    radio.className = joinClasses(
      "mt-[2px] size-4 accent-primary cursor-pointer shrink-0",
      "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
    );
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      current = option.value;
      onChange(current);
    });

    const text = document.createElement("div");
    text.className = "flex flex-col";

    const title = document.createElement("span");
    title.className = "text-body-sm font-sans text-ink";
    title.textContent = option.label;

    const hint = document.createElement("span");
    hint.className = "text-caption font-sans text-ink-muted";
    hint.textContent = option.hint;

    text.append(title, hint);
    label.append(radio, text);
    group.appendChild(label);
  }

  return group;
}

// ---------------------------------------------------------------------------
// Theme picker (light / dark + light background variant)
// ---------------------------------------------------------------------------

/**
 * Build the theme controls: a mode segmented control (Light / Dark) plus, when
 * Light is selected, a row of background-colour swatches. Changes persist via
 * `setTheme` (which the popup/options/injected surfaces all react to live) and
 * are applied immediately to this page through {@link applyThemeToDocument}'s
 * subscription. `onChange` receives the new preference for status messaging.
 */
function createThemeControl(
  initial: ThemePreference,
  onChange: (theme: ThemePreference) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "flex flex-col gap-md";

  let current: ThemePreference = { ...initial };

  // ── Mode segmented control ───────────────────────────────────────
  const modeRow = document.createElement("div");
  modeRow.setAttribute("role", "radiogroup");
  modeRow.setAttribute("aria-label", "Theme mode");
  modeRow.className = "flex items-center gap-sm";

  const modes: { id: ThemeMode; label: string }[] = [
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
  ];

  // ── Light background swatches ────────────────────────────────────
  const bgWrap = document.createElement("div");
  bgWrap.className = "flex flex-col gap-xs";
  const bgLabel = description("Light background");
  const swatchRow = document.createElement("div");
  swatchRow.setAttribute("role", "radiogroup");
  swatchRow.setAttribute("aria-label", "Light background colour");
  swatchRow.className = "flex items-center gap-sm flex-wrap";
  bgWrap.append(bgLabel, swatchRow);

  const syncBgVisibility = (): void => {
    bgWrap.style.display = current.mode === "light" ? "flex" : "none";
  };

  const modeButtons: { id: ThemeMode; el: HTMLButtonElement }[] = [];
  const paintModes = (): void => {
    for (const { id, el } of modeButtons) {
      const selected = id === current.mode;
      el.setAttribute("aria-checked", String(selected));
      el.style.background = selected
        ? "var(--acx-color-primary)"
        : "var(--acx-color-surface)";
      el.style.color = "var(--acx-color-ink)";
    }
  };

  for (const mode of modes) {
    const btn = createButton({
      variant: selectedModeVariant(),
      label: mode.label,
      ariaLabel: `${mode.label} mode`,
      onClick: () => {
        current = { ...current, mode: mode.id };
        paintModes();
        syncBgVisibility();
        onChange(current);
      },
    });
    btn.setAttribute("role", "radio");
    modeButtons.push({ id: mode.id, el: btn });
    modeRow.appendChild(btn);
  }

  const swatchButtons: { id: ThemeBackground; el: HTMLButtonElement }[] = [];
  const paintSwatches = (): void => {
    for (const { id, el } of swatchButtons) {
      const selected = id === current.background;
      // Selected swatch gets a thicker ring via outline.
      el.style.outline = selected
        ? "3px solid var(--acx-color-hairline)"
        : "none";
      el.style.outlineOffset = "2px";
      el.setAttribute("aria-checked", String(selected));
    }
  };

  for (const bg of THEME_BACKGROUNDS) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.setAttribute("role", "radio");
    sw.setAttribute("aria-label", `${bg.label} background`);
    sw.title = bg.label;
    sw.className = joinClasses(
      "size-8 rounded-md cursor-pointer shrink-0",
      "border-2 border-hairline-strong",
      "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
    );
    sw.style.background = bg.swatch;
    sw.addEventListener("click", () => {
      current = { ...current, background: bg.id };
      paintSwatches();
      onChange(current);
    });
    swatchButtons.push({ id: bg.id, el: sw });
    swatchRow.appendChild(sw);
  }

  paintModes();
  paintSwatches();
  syncBgVisibility();

  wrap.append(modeRow, bgWrap);
  return wrap;
}

/** The mode buttons use the secondary (white pill) button variant. */
function selectedModeVariant(): "secondary" {
  return "secondary";
}

// ---------------------------------------------------------------------------
// Panel style control (arcade console vs radial wheel)
// ---------------------------------------------------------------------------

/**
 * Build the middle-click panel-style picker: a two-option segmented control
 * (Console / Radial). Persists via `setPanelStyle`; content scripts react live
 * via `onPanelStyleChanged`. `onChange` receives the new style for status
 * messaging.
 */
function createPanelStyleControl(
  initial: PanelStyle,
  onChange: (style: PanelStyle) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "flex flex-col gap-sm";

  const row = document.createElement("div");
  row.setAttribute("role", "radiogroup");
  row.setAttribute("aria-label", "Middle-click panel style");
  row.className = "flex items-center gap-sm";

  let current: PanelStyle = initial;

  const options: { id: PanelStyle; label: string }[] = [
    { id: "console", label: "Console" },
    { id: "radial", label: "Radial" },
  ];

  const buttons: { id: PanelStyle; el: HTMLButtonElement }[] = [];
  const paint = (): void => {
    for (const { id, el } of buttons) {
      const selected = id === current;
      el.setAttribute("aria-checked", String(selected));
      el.style.background = selected
        ? "var(--acx-color-primary)"
        : "var(--acx-color-surface)";
      el.style.color = "var(--acx-color-ink)";
    }
  };

  for (const option of options) {
    const btn = createButton({
      variant: "secondary",
      label: option.label,
      ariaLabel: `${option.label} panel`,
      onClick: () => {
        current = option.id;
        paint();
        onChange(current);
      },
    });
    btn.setAttribute("role", "radio");
    // These segmented buttons are state indicators, not brand CTAs — neutralize
    // the primitive's bold fill so the painted selected/idle state reads.
    btn.style.removeProperty("background-color");
    btn.style.removeProperty("color");
    buttons.push({ id: option.id, el: btn });
    row.appendChild(btn);
  }

  paint();
  wrap.appendChild(row);
  return wrap;
}

// ---------------------------------------------------------------------------
// Feature toggles (per-feature automatic behaviors)
// ---------------------------------------------------------------------------

/** Display metadata for each toggleable automatic feature. */
const FEATURE_META: Record<
  keyof FeatureFlags,
  { label: string; hint: string }
> = {
  dragCopy: {
    label: "Drag to copy",
    hint: "Highlight text with the mouse and it's copied to the clipboard and notepad automatically. Press Ctrl+Z right after to undo.",
  },
  persistHighlight: {
    label: "Keep copied text highlighted",
    hint: "Leave a green highlight on text you drag-copied so you can see what was copied, until you refresh the page.",
  },
  notepadCapture: {
    label: "Save copies to notepad",
    hint: "Every Ctrl+C copy is collected in the notepad so you can Copy All later.",
  },
  ocrToNotepad: {
    label: "Save extracted text to notepad",
    hint: "Text pulled from images and videos (Text extraction) is also added to the notepad.",
  },
  cookieRemoval: {
    label: "Remove cookie pop-ups",
    hint: "Automatically dismiss cookie-consent banners as pages load.",
  },
};

/**
 * Build a single accessible `role="switch"` row for a feature flag. Mirrors the
 * global Toggle switch styling so the page reads consistently. `onChange` fires
 * only on user interaction.
 */
function createFeatureSwitchRow(
  key: keyof FeatureFlags,
  initial: boolean,
  onChange: (value: boolean) => void,
): HTMLElement {
  const meta = FEATURE_META[key];

  const row = document.createElement("div");
  row.className = joinClasses(
    "flex items-center justify-between gap-md",
    "px-md py-sm rounded-md bg-canvas-soft border border-hairline",
  );

  const labelWrap = document.createElement("div");
  labelWrap.className = "flex flex-col min-w-0";

  const labelId = `acx-feature-${key}-label`;
  const title = document.createElement("span");
  title.id = labelId;
  title.className = "text-body-sm font-sans text-ink";
  title.textContent = meta.label;

  const hint = document.createElement("span");
  hint.className = "text-caption font-sans text-ink-muted";
  hint.textContent = meta.hint;

  labelWrap.append(title, hint);

  const sw = document.createElement("button");
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-labelledby", labelId);
  sw.className = joinClasses(
    "relative inline-flex items-center shrink-0 cursor-pointer",
    "w-[46px] h-[26px] rounded-full border-2 border-hairline-strong p-0",
    "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
    "motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out",
  );

  const knob = document.createElement("span");
  knob.setAttribute("aria-hidden", "true");
  knob.className = joinClasses(
    "absolute top-[1px] left-[1px] size-[20px] rounded-full bg-surface border-2 border-hairline-strong",
    "motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out",
  );
  sw.appendChild(knob);

  let current = initial;
  const paint = (on: boolean): void => {
    sw.setAttribute("aria-checked", String(on));
    sw.style.backgroundColor = on
      ? "var(--acx-color-primary)"
      : "var(--acx-color-canvas-soft)";
    knob.style.transform = on ? "translateX(18px)" : "translateX(0)";
  };
  paint(current);

  sw.addEventListener("click", () => {
    current = !current;
    paint(current);
    onChange(current);
  });

  row.append(labelWrap, sw);
  return row;
}

/**
 * Build the Features section body: one switch per toggleable automatic feature,
 * seeded from the persisted flags. Each switch persists its own flag
 * non-blockingly (Req 19.3) and is independent of the others.
 */
function createFeatureToggles(
  initial: FeatureFlags,
  status: StatusRegion,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "flex flex-col gap-sm";

  for (const key of FEATURE_FLAG_KEYS) {
    const row = createFeatureSwitchRow(key, initial[key], (value) => {
      void setFeatureFlag(key, value);
      status.show(
        `${FEATURE_META[key].label} ${value ? "enabled" : "disabled"}.`,
        "success",
      );
    });
    wrap.appendChild(row);
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Clear all data (Req 19.6, 21.7)
// ---------------------------------------------------------------------------

/**
 * Build the destructive "Clear all data" control. On click it asks for
 * confirmation (Req 19.6) and, on confirm, calls `clearAll(profileId)` which
 * removes every profile-scoped key across `chrome.storage.sync`,
 * `chrome.storage.local`, and IndexedDB (notepad, saved tabs, settings, blobs)
 * — satisfying Req 21.7's "clear their data" reinterpreted for the client-only
 * design. The button is clearly labelled as clearing ALL Alpha Cursor data.
 */
function createClearDataControl(status: StatusRegion): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "flex flex-col gap-sm";

  const note = description(
    "This permanently deletes all Alpha Cursor data for this device — your notepad entries, saved tab folders, settings, and stored images. This cannot be undone.",
  );

  const btnRow = document.createElement("div");
  btnRow.className = "flex items-center justify-start";

  const clearBtn = createButton({
    variant: "utility",
    label: "Clear all data",
    ariaLabel: "Clear all Alpha Cursor data",
    onClick: () => {
      void runClear();
    },
  });
  // Signal the destructive nature with the deep-orange ink (not a structural
  // accent fill — the blue stays reserved for primary actions, Req 20.3).
  clearBtn.classList.add("text-accent-orange-deep", "border-accent-orange-deep");
  btnRow.appendChild(clearBtn);

  wrap.append(note, btnRow);

  async function runClear(): Promise<void> {
    const confirmed = await confirmDialog({
      title: "Clear all data?",
      message:
        "This will delete every Alpha Cursor item stored for this device: notepad entries, saved tab folders, settings, and stored images. This action cannot be undone.",
      confirmLabel: "Clear everything",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;

    try {
      const profileId = await requireProfile();
      await clearAll(profileId);
      status.show("All Alpha Cursor data was cleared.", "success");
    } catch {
      status.show("Couldn't clear the data. Please try again.", "error");
    }
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Privacy statement (Req 21.4, task 26.2)
// ---------------------------------------------------------------------------

/** Build a small paragraph for the privacy statement body. */
function privacyParagraph(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "m-0 text-body-sm font-sans text-ink-secondary";
  p.textContent = text;
  return p;
}

/**
 * Build the privacy statement (Req 21.4). It states plainly that all data is
 * stored locally, that no Alpha Cursor server exists, that "cloud sync" means
 * Chrome's own `storage.sync`, and documents the Web Speech API nuance.
 */
function createPrivacyStatement(): HTMLElement {
  const body = document.createElement("div");
  body.className = "flex flex-col gap-sm";

  body.appendChild(
    privacyParagraph(
      "Alpha Cursor is 100% client-side. Everything you do — your notepad, saved tabs, screenshots, OCR, and settings — is stored locally on this device using the browser's own storage. There is no Alpha Cursor account, server, or backend: none exists, so your data is never sent to us.",
    ),
  );

  body.appendChild(
    privacyParagraph(
      "\u201CCloud sync\u201D here means Chrome's built-in storage.sync. When you choose \u201CSync with Chrome,\u201D your small settings ride along with your Chrome profile sync, which is operated by your browser (Google) — not by Alpha Cursor. Choosing \u201CKeep on this device only\u201D keeps those settings in local storage so they never leave this device. Either way, no Alpha Cursor server is ever contacted.",
    ),
  );

  body.appendChild(
    privacyParagraph(
      "Voice-to-text uses the Web Speech API built into your browser. The extension itself adds no server and makes no speech-related network calls. However, in Chrome the browser's native speech recognition may send audio to Google's speech service to transcribe it. That is a browser feature outside the extension's control; if you prefer not to use it, simply don't use the voice-to-text tool.",
    ),
  );

  body.appendChild(
    privacyParagraph(
      "Clearing your data from this page deletes the corresponding stored data for this device across the browser's sync storage, local storage, and IndexedDB.",
    ),
  );

  const card = createCard({ as: "section", children: (() => {
    const wrapper = document.createElement("div");
    wrapper.className = "flex flex-col gap-md";
    const head = document.createElement("div");
    head.className = "flex flex-col";
    head.appendChild(sectionHeading("Privacy"));
    head.appendChild(
      description("What data is collected, where it is stored, and how it is used."),
    );
    wrapper.append(head, body);
    return wrapper;
  })() });
  card.setAttribute("aria-label", "Privacy statement");
  return card;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/** Build and mount the full Options page UI into `root`. */
export function mountOptions(root: HTMLElement, settings: Settings): void {
  root.className = joinClasses(
    "mx-auto max-w-[720px] box-border flex flex-col gap-lg",
    "bg-canvas text-ink font-sans p-lg",
  );

  // Shared status region (announced saves / clear outcome).
  const status = createStatusRegion();

  // ── Header ────────────────────────────────────────────────────────
  const header = document.createElement("header");
  header.className = "flex flex-col gap-xxs";

  const wordmark = document.createElement("h1");
  wordmark.className = "m-0 text-heading-1 font-sans text-ink";
  wordmark.textContent = "Alpha Cursor Settings";
  const subtitle = description(
    "Configure how Alpha Cursor behaves. Changes are saved automatically as you make them.",
  );
  header.append(wordmark, subtitle);

  // ── Toggle ──────────────────────────────────────────────────────────
  const toggle = createToggleRow((enabled) => {
    void setEnabled(enabled);
    status.show(enabled ? "Alpha Cursor turned on." : "Alpha Cursor turned off.", "success");
  });
  const toggleCard = sectionCard(
    "Extension",
    "Turn Alpha Cursor on or off. This is the same switch as the toolbar popup.",
    toggle.el,
  );

  // ── Separator ───────────────────────────────────────────────────────
  const separatorControl = createSeparatorControl(
    settings.separator ?? { ...DEFAULT_SEPARATOR_CONFIG },
    (config) => {
      // Non-blocking, silent-on-failure persistence (Req 5.3, 5.4, 19.3).
      void saveSeparator(config);
      status.show("Separator saved.", "success");
    },
  );
  const separatorCard = sectionCard(
    "Notepad separator",
    "Choose the characters placed between copied entries when you Copy All.",
    separatorControl,
  );

  // ── Search sites ─────────────────────────────────────────────────────
  const searchControl = createSearchSitesControl(
    settings.searchSites ?? [],
    (sites) => {
      void saveSearchSites(sites);
      status.show("Search sites saved.", "success");
    },
  );
  const searchCard = sectionCard(
    "Search in",
    `Sites offered when you search selected text. Use ${QUERY_PLACEHOLDER} where the search term goes. Reorder with the arrows.`,
    searchControl,
  );

  // ── Sync preference ──────────────────────────────────────────────────
  const syncControl = createSyncPreferenceControl(
    settings.syncPreference ?? DEFAULT_SYNC_PREFERENCE,
    (pref) => {
      void saveSyncPreference(pref);
      status.show("Sync preference saved.", "success");
    },
  );
  const syncCard = sectionCard(
    "Synchronization",
    "Decide where your settings live. Neither option uses any Alpha Cursor server.",
    syncControl,
  );

  // ── Theme picker ─────────────────────────────────────────────────────
  const themeBody = document.createElement("div");
  themeBody.className = "flex flex-col gap-sm";
  const renderTheme = (pref: ThemePreference): void => {
    themeBody.replaceChildren(
      createThemeControl(pref, (next) => {
        void setTheme(next);
        status.show(
          next.mode === "dark"
            ? "Dark mode on."
            : `Light mode — ${next.background} background.`,
          "success",
        );
      }),
    );
  };
  renderTheme({ ...DEFAULT_THEME });
  void getTheme()
    .then(renderTheme)
    .catch(() => {
      /* default already rendered */
    });
  const themeCard = sectionCard(
    "Theme",
    "Choose light or dark mode. In light mode, pick a background colour.",
    themeBody,
  );

  // ── Panel style ──────────────────────────────────────────────────────
  const panelStyleBody = document.createElement("div");
  panelStyleBody.className = "flex flex-col gap-sm";
  const renderPanelStyle = (style: PanelStyle): void => {
    panelStyleBody.replaceChildren(
      createPanelStyleControl(style, (next) => {
        void setPanelStyle(next);
        status.show(
          next === "console"
            ? "Middle-click panel: arcade console."
            : "Middle-click panel: radial wheel.",
          "success",
        );
      }),
    );
  };
  renderPanelStyle(DEFAULT_PANEL_STYLE);
  void getPanelStyle()
    .then(renderPanelStyle)
    .catch(() => {
      /* default already rendered */
    });
  const panelStyleCard = sectionCard(
    "Middle-click panel",
    "Choose how the panel looks when you middle-click: the arcade console (with a screen that names each tool and lists saved tabs you can pick with the mouse or ↑ ↓ Enter) or the original radial wheel.",
    panelStyleBody,
  );

  // ── Feature toggles ──────────────────────────────────────────────────
  // Seed from defaults (all on) then refine once the persisted flags resolve.
  const featuresBody = document.createElement("div");
  featuresBody.className = "flex flex-col gap-sm";
  const renderFeatures = (flags: FeatureFlags): void => {
    featuresBody.replaceChildren(createFeatureToggles(flags, status));
  };
  renderFeatures({ ...DEFAULT_FEATURE_FLAGS });
  void getFeatureFlags()
    .then(renderFeatures)
    .catch(() => {
      /* defaults already rendered */
    });
  const featuresCard = sectionCard(
    "Features",
    "Turn individual automatic behaviors on or off. These work on top of the main switch above.",
    featuresBody,
  );

  // ── Clear data ───────────────────────────────────────────────────────
  const clearControl = createClearDataControl(status);
  const clearCard = sectionCard("Clear data", undefined, clearControl);

  // ── Privacy ──────────────────────────────────────────────────────────
  const privacyCard = createPrivacyStatement();

  // ── Footer status line ───────────────────────────────────────────────
  const statusFooter = document.createElement("div");
  statusFooter.className = "min-h-[1.43em]";
  statusFooter.appendChild(status.el);

  root.append(
    header,
    toggleCard,
    themeCard,
    panelStyleCard,
    featuresCard,
    separatorCard,
    searchCard,
    syncCard,
    clearCard,
    privacyCard,
    statusFooter,
  );

  // ── Wire live Toggle state ───────────────────────────────────────────
  void getEnabled().then((enabled) => toggle.setState(enabled));
  toggle.setState(settings.enabled);
  onEnabledChanged((enabled) => toggle.setState(enabled));
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const appRoot = document.getElementById("app");
if (appRoot) {
  applyThemeToDocument();
  void loadSettings()
    .then((settings) => mountOptions(appRoot, settings))
    .catch(() => {
      // Settings load failed (e.g. identity not yet available). Render with
      // defaults so the page is still usable; persistence will retry on change.
      void import("../shared/settings").then(({ defaultSettings }) => {
        mountOptions(appRoot, defaultSettings());
      });
    });
}
