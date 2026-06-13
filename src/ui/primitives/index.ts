// Notion UI primitives barrel (task 6.2).
//
// Framework-agnostic, plain-DOM factory functions returning styled
// `HTMLElement`s. Each styles itself with Tailwind v4 utility classes backed by
// the Notion @theme tokens (task 3.1), so the primitives work both inside the
// content-script closed Shadow DOM roots and in the popup/options pages that
// render in the main document.
//
// Requirements honored across these primitives:
//   - 20.3 primary blue reserved for actions/links/focus,
//   - 20.5 visible focus-visible ring,
//   - 20.6 prefers-reduced-motion honored (motion-safe-gated transitions),
//   - 20.7 aria-labels enforced for icon-only / unlabeled controls.

export { joinClasses } from "./classNames";
export type { ClassValue } from "./classNames";

export { createButton } from "./button";
export type { ButtonVariant, CreateButtonOptions } from "./button";

export { createCard } from "./card";
export type { CardVariant, CreateCardOptions } from "./card";

export { createTextInput } from "./textInput";
export type { CreateTextInputOptions } from "./textInput";

export { createBadge } from "./badge";
export type { CreateBadgeOptions } from "./badge";
