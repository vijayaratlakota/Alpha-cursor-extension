// Background Toggle handlers + lifecycle wiring (task 8.1).
//
// Registers the `TOGGLE_GET` / `TOGGLE_SET` message handlers on the background
// router and wires `chrome.runtime.onInstalled` / `onStartup` so the Toggle
// state is initialized on install and restored/cached on startup (Req 1.5).
//
// - `TOGGLE_GET` → returns the current persisted `{ enabled }` (Req 1.1).
// - `TOGGLE_SET { enabled }` → persists within 500ms via the settings module's
//   sync-with-local-fallback writer (Req 1.4) and echoes back `{ enabled }`.
//
// Persistence + reactivity live in `src/shared/settings.ts`; this file is the
// thin background-context adapter that registers the handlers and lifecycle
// listeners. `installToggle()` is called from `src/background/index.ts` after
// `installRouter()`.

import { registerHandler } from "./router";
import {
  type ToggleState,
  ToggleMessageType,
  getEnabled,
  initializeEnabled,
  setEnabled,
} from "@/shared/settings";

/** Payload accepted by the `TOGGLE_SET` message. */
export interface ToggleSetPayload {
  enabled: boolean;
}

/**
 * Register the `TOGGLE_GET` and `TOGGLE_SET` handlers and wire the MV3
 * lifecycle events. Idempotent: `registerHandler` overwrites prior
 * registrations so re-running on service-worker wake is safe.
 */
export function installToggle(): void {
  registerHandler<void, ToggleState>(ToggleMessageType.GET, async () => {
    const enabled = await getEnabled();
    return { enabled };
  });

  registerHandler<ToggleSetPayload, ToggleState>(
    ToggleMessageType.SET,
    async (payload) => {
      const enabled = Boolean(payload?.enabled);
      await setEnabled(enabled);
      return { enabled };
    },
  );

  registerToggleLifecycle();
}

/**
 * Wire `onInstalled` (seed the default Toggle state, Req 1.5) and `onStartup`
 * (re-read the persisted state into the in-memory cache so the worker reflects
 * the last value immediately on boot). Guarded so it is a no-op in non-service-
 * worker contexts / test shims lacking these events.
 */
function registerToggleLifecycle(): void {
  const runtime = chrome.runtime;
  if (!runtime) {
    return;
  }

  if (runtime.onInstalled && typeof runtime.onInstalled.addListener === "function") {
    runtime.onInstalled.addListener(() => {
      // Initialize the default on first install; idempotent if already set.
      void initializeEnabled().catch(() => {
        /* identity/storage errors are surfaced via the Notification system */
      });
    });
  }

  if (runtime.onStartup && typeof runtime.onStartup.addListener === "function") {
    runtime.onStartup.addListener(() => {
      // The value persists in storage across restarts; reading it warms the
      // in-memory cache so the worker reflects the last persisted state.
      void getEnabled().catch(() => {
        /* fall back to DEFAULT_ENABLED cache on read failure */
      });
    });
  }
}
