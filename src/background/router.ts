// Background message router for the MV3 service worker.
//
// Every cross-context call (popup, options, content script → background) flows
// through a single `chrome.runtime.onMessage` listener installed by
// `installRouter()`. The router maps a message `type` string to a typed handler
// and normalizes every outcome into the shared `Response<R>` discriminated
// union so callers always receive `{ ok: true, data }` or `{ ok: false, error }`
// (Req 22.1).
//
// MV3 lifecycle note (Req 22.3): the service worker is ephemeral and may be
// killed between messages. This router holds no durable state of its own — it
// only dispatches. Long-running operations (screenshot stitching, multi-tab
// restore, media batches) are responsible for persisting and resuming their own
// progress via `OperationCheckpoint` records in `chrome.storage.local`. Those
// handlers register here like any other handler; on worker wake the handler
// re-reads its checkpoint before continuing. The router itself is re-created and
// handlers re-registered each time the worker boots (see `src/background/index.ts`).

import {
  type AppError,
  type Message,
  type Response,
  ErrorCode,
  err,
  makeError,
  ok,
} from "@/shared/messaging";

/**
 * A typed message handler. Receives the message `payload` and the Chrome
 * `MessageSender` describing the message origin, and resolves with the success
 * data `R`. Throwing or rejecting is allowed: the router normalizes any failure
 * into an `err(AppError)` response.
 */
export type MessageHandler<T = unknown, R = unknown> = (
  payload: T,
  sender: chrome.runtime.MessageSender,
) => Promise<R>;

/**
 * Internal registry mapping a message `type` to its handler. Handlers are stored
 * with `unknown` payload/result types; `registerHandler` preserves the precise
 * types at the registration call site while keeping the registry homogeneous.
 */
const handlers = new Map<string, MessageHandler<unknown, unknown>>();

/**
 * Register a typed handler for a message `type`. Re-registering an existing
 * `type` overwrites the previous handler (last registration wins), which keeps
 * service-worker re-initialization idempotent.
 */
export function registerHandler<T, R>(
  type: string,
  handler: MessageHandler<T, R>,
): void {
  handlers.set(type, handler as MessageHandler<unknown, unknown>);
}

/**
 * Remove all registered handlers. Primarily a test seam so suites can reset the
 * registry between cases (task 5.3).
 */
export function clearHandlers(): void {
  handlers.clear();
}

/** Whether a handler is registered for the given message `type`. */
export function hasHandler(type: string): boolean {
  return handlers.has(type);
}

/**
 * Normalize any thrown/rejected value into an `AppError`. An existing `AppError`
 * is passed through unchanged; anything else becomes an `ErrorCode.UNKNOWN`
 * error carrying a best-effort message string.
 */
function normalizeError(value: unknown): AppError {
  if (isAppError(value)) {
    return value;
  }
  if (value instanceof Error) {
    return makeError(ErrorCode.UNKNOWN, value.message);
  }
  if (typeof value === "string") {
    return makeError(ErrorCode.UNKNOWN, value);
  }
  return makeError(ErrorCode.UNKNOWN, "An unknown error occurred");
}

/** Structural type guard for `AppError` (no `instanceof`, it is a plain object). */
function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    candidate.code in ErrorCode &&
    typeof candidate.message === "string" &&
    typeof candidate.recoverable === "boolean"
  );
}

/**
 * Look up and run the handler for `message.type`, wrapping its result in
 * `ok(data)`. Unknown message types resolve to an `err()` with
 * `ErrorCode.UNKNOWN`. Any handler throw/rejection is normalized via
 * `normalizeError`. This function never rejects — it always resolves with a
 * `Response<R>`.
 */
export async function dispatch<R = unknown>(
  message: Message,
  sender: chrome.runtime.MessageSender,
): Promise<Response<R>> {
  const handler = handlers.get(message.type);
  if (!handler) {
    return err(
      makeError(
        ErrorCode.UNKNOWN,
        `No handler registered for message type "${message.type}"`,
      ),
    );
  }

  try {
    const data = (await handler(message.payload, sender)) as R;
    return ok(data);
  } catch (thrown) {
    return err(normalizeError(thrown));
  }
}

/**
 * Wire the router to `chrome.runtime.onMessage`. Returns `true` synchronously
 * from the listener to keep the message channel open for the asynchronous
 * `dispatch`, then calls `sendResponse` with the resolved `Response`. Call once
 * on service-worker startup.
 */
export function installRouter(): void {
  chrome.runtime.onMessage.addListener(
    (
      message: Message,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: Response) => void,
    ): boolean => {
      // Messages addressed to the offscreen document are handled there, not by
      // the background router. Ignore them so the channel isn't answered twice.
      if (message && message.target === "offscreen") {
        return false;
      }
      dispatch(message, sender).then(sendResponse, (unexpected) => {
        // `dispatch` is designed never to reject, but guard the channel anyway
        // so a programming error never leaves the sender hanging.
        sendResponse(err(normalizeError(unexpected)));
      });
      // Returning true signals Chrome to keep the channel open for the async
      // sendResponse above.
      return true;
    },
  );
}
