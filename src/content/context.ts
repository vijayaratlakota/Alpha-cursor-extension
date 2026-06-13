/**
 * Alpha Cursor — Options_Panel context resolution (task 10.1).
 *
 * Resolves the {@link ContextType} for a middle-click so the radial
 * Options_Panel can surface the tools applicable to whatever the cursor is over
 * (Req 2.1–2.5). The design fixes the precedence order:
 *
 *   non-empty selection → `selected-text`   (highest precedence, Req 2.4)
 *   else `<img>` / CSS background image → `image`   (Req 2.2)
 *   else `<video>` → `video`   (Req 2.3)
 *   else → `generic-page`   (Req 2.5)
 *
 * The decision itself is factored into a PURE helper, {@link pickContext}, that
 * takes a small flag bag (`{ hasSelection, isImage, isVideo }`) so task 10.2 can
 * property-test the precedence rule without touching the DOM. The DOM-driven
 * {@link resolveContext} reads `window.getSelection()` and inspects the event's
 * `composedPath()` / `target`, derives the flags, and delegates to
 * `pickContext`.
 */

/** The classification of what the cursor is over when middle-clicked (Req 2). */
export type ContextType = "selected-text" | "image" | "video" | "generic-page";

/**
 * The minimal set of boolean signals the precedence rule depends on. Extracted
 * from the DOM by {@link resolveContext} and consumed by the pure
 * {@link pickContext}.
 */
export interface ContextFlags {
  /** A non-empty text selection exists at the moment of the click (Req 2.4). */
  hasSelection: boolean;
  /** The element under the cursor is an image / has a CSS background image (Req 2.2). */
  isImage: boolean;
  /** The element under the cursor is a video (Req 2.3). */
  isVideo: boolean;
}

/**
 * PURE precedence rule (Property 1). Given the resolved flags, returns the
 * {@link ContextType} per the fixed order: selection wins over everything, then
 * image, then video, then the generic-page fallback.
 *
 * This function performs NO DOM access and is fully deterministic, so it is the
 * property-test target for task 10.2.
 */
export function pickContext(flags: ContextFlags): ContextType {
  if (flags.hasSelection) return "selected-text";
  if (flags.isImage) return "image";
  if (flags.isVideo) return "video";
  return "generic-page";
}

/**
 * Returns `true` when there is a non-empty text selection in the document.
 * Whitespace-only selections are treated as empty so they don't spuriously
 * outrank an image/video context.
 */
function hasNonEmptySelection(): boolean {
  const getSel = (globalThis as { getSelection?: () => Selection | null })
    .getSelection;
  let selection: Selection | null = null;
  if (typeof getSel === "function") {
    selection = getSel.call(globalThis);
  } else if (typeof document !== "undefined") {
    selection = document.getSelection();
  }
  if (!selection) return false;
  if (selection.isCollapsed) return false;
  return selection.toString().trim().length > 0;
}

/** True when `el` is an `<img>` element. */
function isImageElement(el: Element): boolean {
  return el instanceof HTMLImageElement || el.tagName.toLowerCase() === "img";
}

/** True when `el` is a `<video>` element. */
function isVideoElement(el: Element): boolean {
  return el instanceof HTMLVideoElement || el.tagName.toLowerCase() === "video";
}

/**
 * True when `el` paints a CSS `background-image` referencing a real image
 * (`url(...)`), i.e. a non-`none` background image. Used so background-image
 * "hero" elements resolve to the `image` context like `<img>` does (Req 2.2).
 */
function hasCssBackgroundImage(el: Element): boolean {
  const getComputed = (
    globalThis as {
      getComputedStyle?: (e: Element) => CSSStyleDeclaration;
    }
  ).getComputedStyle;
  if (typeof getComputed !== "function") return false;
  try {
    const bg = getComputed.call(globalThis, el).backgroundImage;
    return typeof bg === "string" && bg !== "none" && bg.includes("url(");
  } catch {
    return false;
  }
}

/**
 * Build the ordered list of elements to inspect for the click, preferring the
 * event's `composedPath()` (which pierces shadow boundaries and lists the
 * deepest target first) and falling back to `event.target`.
 */
function elementsFromEvent(event: MouseEvent): Element[] {
  const path =
    typeof event.composedPath === "function" ? event.composedPath() : [];
  const elements: Element[] = [];
  for (const node of path) {
    if (node instanceof Element) elements.push(node);
  }
  if (elements.length === 0 && event.target instanceof Element) {
    elements.push(event.target);
  }
  return elements;
}

/**
 * Derive {@link ContextFlags} from a middle-click event by inspecting the
 * selection state and the element(s) under the cursor.
 *
 * Exported primarily so tests / callers can verify the DOM extraction
 * independently of the pure precedence rule.
 */
export function resolveContextFlags(event: MouseEvent): ContextFlags {
  const elements = elementsFromEvent(event);
  let isImage = false;
  let isVideo = false;

  for (const el of elements) {
    if (!isImage && (isImageElement(el) || hasCssBackgroundImage(el))) {
      isImage = true;
    }
    if (!isVideo && isVideoElement(el)) {
      isVideo = true;
    }
    if (isImage && isVideo) break;
  }

  return {
    hasSelection: hasNonEmptySelection(),
    isImage,
    isVideo,
  };
}

/**
 * Resolve the {@link ContextType} for a middle-click `MouseEvent` (Req 2.1).
 * Reads the live selection and the element(s) under the cursor, then applies
 * the pure {@link pickContext} precedence rule.
 *
 * @example
 * element.addEventListener("mousedown", (e) => {
 *   if (e.button === 1) openPanel(resolveContext(e), { x: e.clientX, y: e.clientY });
 * });
 */
export function resolveContext(event: MouseEvent): ContextType {
  return pickContext(resolveContextFlags(event));
}
