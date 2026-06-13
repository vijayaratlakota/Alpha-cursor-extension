// Shared UI module: closed Shadow DOM host factory, Notion UI primitives, and
// the Notification (toast) system. Built in tasks 6 and 7.

// Tailwind v4 + Notion design tokens and Shadow DOM style injection helpers
// (task 3.1). Re-exported here so UI factories can pull styles from "@/ui".
export {
  sharedStyleString,
  tokensStyleString,
  sharedStyleSheet,
  injectStyleElement,
  applySharedStyles,
} from "./styles/theme";

// Closed Shadow DOM host factory (task 6.1). Content-script UI surfaces mount
// into isolated closed shadow roots created here.
export {
  createShadowHost,
  HOST_ATTRIBUTE,
} from "./shadowHost";
export type {
  ShadowHostHandle,
  CreateShadowHostOptions,
  ShadowHostOverlay,
  ShadowHostPoint,
} from "./shadowHost";

// Notion UI primitives (task 6.2): plain-DOM factory functions for buttons,
// cards/surfaces, text inputs, and badge pills, styled with the Notion @theme
// tokens and honoring focus-ring, reduced-motion, and aria-label requirements.
export {
  joinClasses,
  createButton,
  createCard,
  createTextInput,
  createBadge,
} from "./primitives";
export type {
  ClassValue,
  ButtonVariant,
  CreateButtonOptions,
  CardVariant,
  CreateCardOptions,
  CreateTextInputOptions,
  CreateBadgeOptions,
} from "./primitives";

// Notification (toast) system (task 7.1): a single `notify({ kind, text, code? })`
// API rendering a transient `ex-toast` styled toast inside the content-script
// closed Shadow DOM, honoring `prefers-reduced-motion` (Req 20.1, 20.6).
export { notify, DEFAULT_DURATION_MS } from "./notify";
export type { NotifyKind, NotifyOptions, NotifyHandle } from "./notify";
