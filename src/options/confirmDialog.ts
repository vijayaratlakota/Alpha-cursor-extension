/**
 * Alpha Cursor — in-page confirmation dialog for the Options page (task 25.2).
 *
 * A small Notion-styled modal used to confirm destructive actions (Req 19.6
 * "require confirmation before clearing"). Rendered in the main document (the
 * Options page is a normal HTML surface, not a Shadow-DOM content script), it
 * uses the `ex-modal-card` chrome via {@link createCard} `elevated` plus a
 * dimmed backdrop.
 *
 * Accessibility: the dialog is `role="dialog"` + `aria-modal`, focus moves to
 * the confirm button on open and is restored to the trigger on close, and
 * Escape / backdrop-click cancel. Motion is left to the primitives, which honor
 * `prefers-reduced-motion` (Req 20.6).
 */

import { createButton, createCard } from "../ui/primitives";

/** Options for {@link confirmDialog}. */
export interface ConfirmDialogOptions {
  /** Dialog title (heading). */
  title: string;
  /** Body text describing the consequence of confirming. */
  message: string;
  /** Confirm button label. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
}

/**
 * Show a modal confirmation dialog and resolve with the user's choice:
 * `true` when confirmed, `false` when cancelled (via the Cancel button, the
 * Escape key, or a backdrop click).
 */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  const {
    title,
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
  } = options;

  return new Promise<boolean>((resolve) => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Dimmed, click-to-cancel backdrop pinned over the viewport.
    const backdrop = document.createElement("div");
    backdrop.className =
      "fixed inset-0 z-50 flex items-center justify-center bg-scrim p-md";

    const titleId = "acx-confirm-title";
    const descId = "acx-confirm-desc";

    const heading = document.createElement("h2");
    heading.id = titleId;
    heading.className = "text-heading-3 text-ink m-0";
    heading.textContent = title;

    const body = document.createElement("p");
    body.id = descId;
    body.className = "text-body-sm text-ink-secondary mt-sm mb-lg";
    body.textContent = message;

    const actions = document.createElement("div");
    actions.className = "flex justify-end gap-sm";

    let settled = false;
    const close = (result: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeydown, true);
      backdrop.remove();
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
      resolve(result);
    };

    const cancelBtn = createButton({
      variant: "utility",
      label: cancelLabel,
      onClick: () => close(false),
    });
    const confirmBtn = createButton({
      variant: "primary",
      label: confirmLabel,
      onClick: () => close(true),
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    const card = createCard({
      variant: "elevated",
      as: "div",
      children: [heading, body, actions],
      className: "w-full max-w-[420px] rounded-xl",
    });
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", titleId);
    card.setAttribute("aria-describedby", descId);

    backdrop.appendChild(card);

    // Backdrop click (outside the card) cancels.
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) close(false);
    });

    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(false);
      }
    };
    document.addEventListener("keydown", onKeydown, true);

    document.body.appendChild(backdrop);
    confirmBtn.focus();
  });
}
