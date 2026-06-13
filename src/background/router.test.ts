// Unit tests for the background message router (task 5.3).
//
// These cover the router's two jobs: dispatching a `Message` to the handler
// registered for its `type` and normalizing every outcome into the shared
// `Response<R>` union (Req 22.1). The `installRouter()` wiring is exercised
// against a `sinon-chrome` mock so we can assert the `chrome.runtime.onMessage`
// listener is added, returns `true` (keeping the async channel open), and
// eventually calls `sendResponse` with the resolved `Response`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import chrome from "sinon-chrome";

import {
  type Message,
  type Response,
  ErrorCode,
  makeError,
  isErr,
  isOk,
  createMessage,
} from "@/shared/messaging";
import {
  clearHandlers,
  dispatch,
  hasHandler,
  installRouter,
  registerHandler,
} from "./router";

// sinon-chrome provides a full stubbed chrome API. Assign it onto the global so
// `installRouter()` (which references the ambient `chrome`) wires into the mock.
beforeEach(() => {
  chrome.reset();
  (globalThis as unknown as { chrome: typeof chrome }).chrome = chrome;
  clearHandlers();
});

afterEach(() => {
  clearHandlers();
  chrome.reset();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

const noSender = {} as chrome.runtime.MessageSender;

describe("dispatch", () => {
  it("routes to the registered handler and wraps the result in ok(data)", async () => {
    registerHandler<{ n: number }, number>("DOUBLE", async (payload) => payload.n * 2);

    const message = createMessage("DOUBLE", { n: 21 });
    const response = await dispatch<number>(message, noSender);

    expect(isOk(response)).toBe(true);
    expect(response).toEqual({ ok: true, data: 42 });
  });

  it("returns an err(UNKNOWN) response for an unknown message type", async () => {
    const message = createMessage("NOPE", {});
    const response = await dispatch(message, noSender);

    expect(isErr(response)).toBe(true);
    if (isErr(response)) {
      expect(response.error.code).toBe(ErrorCode.UNKNOWN);
      expect(response.error.message).toContain("NOPE");
    }
  });

  it("passes a thrown AppError through unchanged", async () => {
    const appError = makeError(ErrorCode.QUOTA_EXCEEDED, "notepad full", false);
    registerHandler("THROW_APP_ERROR", async () => {
      throw appError;
    });

    const response = await dispatch(createMessage("THROW_APP_ERROR", {}), noSender);

    expect(isErr(response)).toBe(true);
    if (isErr(response)) {
      // Same shape, code, message, and recoverable flag preserved.
      expect(response.error).toEqual(appError);
      expect(response.error.code).toBe(ErrorCode.QUOTA_EXCEEDED);
      expect(response.error.recoverable).toBe(false);
    }
  });

  it("normalizes a thrown plain Error to UNKNOWN with its message", async () => {
    registerHandler("THROW_ERROR", async () => {
      throw new Error("boom");
    });

    const response = await dispatch(createMessage("THROW_ERROR", {}), noSender);

    expect(isErr(response)).toBe(true);
    if (isErr(response)) {
      expect(response.error.code).toBe(ErrorCode.UNKNOWN);
      expect(response.error.message).toBe("boom");
      expect(response.error.recoverable).toBe(true);
    }
  });

  it("normalizes a thrown string to UNKNOWN carrying the string", async () => {
    registerHandler("THROW_STRING", async () => {
      throw "stringly typed failure";
    });

    const response = await dispatch(createMessage("THROW_STRING", {}), noSender);

    expect(isErr(response)).toBe(true);
    if (isErr(response)) {
      expect(response.error.code).toBe(ErrorCode.UNKNOWN);
      expect(response.error.message).toBe("stringly typed failure");
    }
  });

  it("normalizes a thrown non-error/non-string value to a generic UNKNOWN", async () => {
    registerHandler("THROW_OBJECT", async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { weird: true };
    });

    const response = await dispatch(createMessage("THROW_OBJECT", {}), noSender);

    expect(isErr(response)).toBe(true);
    if (isErr(response)) {
      expect(response.error.code).toBe(ErrorCode.UNKNOWN);
      expect(response.error.message).toBe("An unknown error occurred");
    }
  });

  it("never rejects regardless of how the handler fails", async () => {
    const throwers: Array<() => Promise<unknown>> = [
      async () => {
        throw new Error("err");
      },
      async () => {
        throw "str";
      },
      async () => {
        throw { weird: true };
      },
      async () => {
        throw makeError(ErrorCode.STORAGE_FAILED, "disk");
      },
    ];

    for (const [i, thrower] of throwers.entries()) {
      registerHandler(`FAIL_${i}`, thrower);
      // If dispatch ever rejected, this assertion would throw instead of resolve.
      await expect(
        dispatch(createMessage(`FAIL_${i}`, {}), noSender),
      ).resolves.toMatchObject({ ok: false });
    }
  });

  it("forwards the payload and sender to the handler", async () => {
    const handler = vi.fn(async () => "done");
    registerHandler("ECHO", handler);

    const payload = { hello: "world" };
    const sender = { id: "ext-id", tab: { id: 7 } } as chrome.runtime.MessageSender;
    const message: Message<typeof payload> = createMessage("ECHO", payload);

    await dispatch(message, sender);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload, sender);
  });
});

describe("registry helpers", () => {
  it("hasHandler reflects registration and clearHandlers resets the registry", () => {
    expect(hasHandler("REG")).toBe(false);

    registerHandler("REG", async () => null);
    expect(hasHandler("REG")).toBe(true);

    clearHandlers();
    expect(hasHandler("REG")).toBe(false);
  });

  it("last registration wins when a type is re-registered", async () => {
    registerHandler("DUP", async () => "first");
    registerHandler("DUP", async () => "second");

    const response = await dispatch(createMessage("DUP", {}), noSender);
    expect(response).toEqual({ ok: true, data: "second" });
  });
});

describe("installRouter", () => {
  it("adds a single chrome.runtime.onMessage listener", () => {
    installRouter();
    expect(chrome.runtime.onMessage.addListener.calledOnce).toBe(true);
  });

  it("listener returns true synchronously to keep the channel open", () => {
    installRouter();
    const listener = chrome.runtime.onMessage.addListener.firstCall.args[0];

    registerHandler("PING", async () => "pong");
    const result = listener(createMessage("PING", {}), noSender, () => {});

    expect(result).toBe(true);
  });

  it("eventually calls sendResponse with the success Response", async () => {
    installRouter();
    const listener = chrome.runtime.onMessage.addListener.firstCall.args[0];

    registerHandler<{ n: number }, number>("INC", async (p) => p.n + 1);

    const sendResponse = vi.fn<(response: Response) => void>();
    listener(createMessage("INC", { n: 41 }), noSender, sendResponse);

    // Let the async dispatch microtasks settle.
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, data: 42 });
  });

  it("eventually calls sendResponse with a normalized error Response", async () => {
    installRouter();
    const listener = chrome.runtime.onMessage.addListener.firstCall.args[0];

    registerHandler("KABOOM", async () => {
      throw new Error("kaboom");
    });

    const sendResponse = vi.fn<(response: Response) => void>();
    listener(createMessage("KABOOM", {}), noSender, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    const call = sendResponse.mock.calls[0];
    expect(call).toBeDefined();
    const [response] = call!;
    expect(isErr(response)).toBe(true);
    if (isErr(response)) {
      expect(response.error.code).toBe(ErrorCode.UNKNOWN);
      expect(response.error.message).toBe("kaboom");
    }
  });

  it("sends an error Response for an unknown message type via the listener", async () => {
    installRouter();
    const listener = chrome.runtime.onMessage.addListener.firstCall.args[0];

    const sendResponse = vi.fn<(response: Response) => void>();
    listener(createMessage("MISSING", {}), noSender, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    const call = sendResponse.mock.calls[0];
    expect(call).toBeDefined();
    const [response] = call!;
    expect(isErr(response)).toBe(true);
    if (isErr(response)) {
      expect(response.error.code).toBe(ErrorCode.UNKNOWN);
    }
  });
});
