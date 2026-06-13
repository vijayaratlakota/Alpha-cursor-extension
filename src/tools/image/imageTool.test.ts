/**
 * Task 14.4 — edge-case test for an unretrievable / undecodable image source
 * (Req 10.5).
 *
 * When the Save-Image tool is invoked over a point where no image can be
 * resolved (`document.elementFromPoint` returns `null`, the jsdom default),
 * `runImageTool` must surface an `IMAGE_DECODE_FAILED` notification and open NO
 * options menu and start NO download (Req 10.5).
 *
 * We drive the tool through its real registration seam: `registerImageTool()`
 * installs the run handler into the content tool catalog, and we invoke it via
 * `getTool(ToolId.SAVE_IMAGE).run(...)`. `notify` is mocked so we can assert the
 * exact error code, and we additionally assert no save-image shadow host appears
 * in the document.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Spy on the notification channel so we can assert the error path is taken
// without rendering a real toast (jsdom-friendly).
const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("../../ui/notify", () => ({ notify: notifyMock }));

import { registerImageTool } from "./imageTool";
import { getTool, ToolId, type Tool } from "../../content/tools";
import { ErrorCode } from "../../shared/messaging";

const SAVE_IMAGE_HOST_SELECTOR = '[data-acx-ui="save-image-menu"]';

let original: Tool["run"];

beforeEach(() => {
  notifyMock.mockClear();
  document.body.innerHTML = "";
  // jsdom does not implement Document.elementFromPoint, so define a default
  // (returns null) that individual tests can override via vi.spyOn.
  (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint =
    () => null;
  // Preserve and re-install the real handler so the suite is self-contained.
  original = getTool(ToolId.SAVE_IMAGE)!.run;
  registerImageTool();
});

afterEach(() => {
  // Restore the catalog entry for other suites.
  const tool = getTool(ToolId.SAVE_IMAGE)!;
  tool.run = original;
  document.body.innerHTML = "";
});

describe("Save Image — unresolvable source (Req 10.5)", () => {
  it("notifies IMAGE_DECODE_FAILED and opens no menu when no image is under the point", async () => {
    // jsdom's elementFromPoint returns null, so resolveImageUrl finds nothing.
    expect(document.elementFromPoint(10, 10)).toBeNull();

    const run = getTool(ToolId.SAVE_IMAGE)!.run;
    await run({ context: "image", point: { x: 10, y: 10 } });

    // Exactly one error notification carrying the decode-failure code.
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const arg = notifyMock.mock.calls[0]![0] as {
      kind: string;
      code: ErrorCode;
    };
    expect(arg.kind).toBe("error");
    expect(arg.code).toBe(ErrorCode.IMAGE_DECODE_FAILED);

    // No options menu host was mounted — no menu, no download path entered.
    expect(document.querySelector(SAVE_IMAGE_HOST_SELECTOR)).toBeNull();
  });

  it("does not open a menu when elementFromPoint resolves a non-image element", async () => {
    // A plain div with no background-image resolves to no usable image URL.
    const div = document.createElement("div");
    document.body.appendChild(div);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(div);

    const run = getTool(ToolId.SAVE_IMAGE)!.run;
    await run({ context: "image", point: { x: 5, y: 5 } });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const arg = notifyMock.mock.calls[0]![0] as { code: ErrorCode };
    expect(arg.code).toBe(ErrorCode.IMAGE_DECODE_FAILED);
    expect(document.querySelector(SAVE_IMAGE_HOST_SELECTOR)).toBeNull();
  });
});
