// Options page tests (task 25.3): the exported pure search-site helpers and the
// "Clear all data" confirmation flow (Req 12.6, 19.6, 21.7).
//
// The pure helpers (`normalizeSiteOrder`, `sortSitesByOrder`, `moveSite`,
// `seedSearchSites`) are self-contained and tested directly. The clear-all flow
// is exercised by mounting `mountOptions` into a jsdom `#app` and clicking the
// destructive control, with the confirmation dialog and the storage/identity
// boundary mocked so we can assert that `clearAll(profileId)` runs ONLY when the
// user confirms.
//
// `../shared/storage` (`clearAll`) and `../shared/identity` (`requireProfile`)
// are mocked as spies; `./confirmDialog` is mocked so each test controls the
// confirm/cancel outcome; `../shared/settings` keeps its real constants/helpers
// but its storage-touching functions are stubbed so mounting never hits the
// (mocked) storage layer. The Tailwind CSS import is stubbed so it never reaches
// the esbuild/Tailwind pipeline under the jsdom environment.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ui/styles/tailwind.css", () => ({}));

// Controllable confirmation dialog.
const confirmDialogMock = vi.fn<() => Promise<boolean>>();
vi.mock("./confirmDialog", () => ({
  confirmDialog: (...args: unknown[]) => confirmDialogMock(...(args as [])),
}));

// Storage + identity boundary as spies. Keep the real storage exports (settings.ts
// imports many of them) and override only `clearAll`.
const clearAllMock = vi.fn((_profileId: string) => Promise.resolve());
vi.mock("../shared/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/storage")>();
  return {
    ...actual,
    clearAll: (profileId: string) => clearAllMock(profileId),
  };
});

const requireProfileMock = vi.fn(() => Promise.resolve("test-profile-id"));
vi.mock("../shared/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/identity")>();
  return {
    ...actual,
    requireProfile: () => requireProfileMock(),
  };
});

// Keep the real settings constants + pure helpers, but stub the storage-touching
// functions so mounting doesn't reach the mocked storage layer.
vi.mock("../shared/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/settings")>();
  return {
    ...actual,
    getEnabled: vi.fn(() => Promise.resolve(true)),
    setEnabled: vi.fn(() => Promise.resolve()),
    onEnabledChanged: vi.fn(() => () => {}),
    saveSeparator: vi.fn(() => Promise.resolve()),
    saveSearchSites: vi.fn(() => Promise.resolve()),
    saveSyncPreference: vi.fn(() => Promise.resolve()),
  };
});

import {
  normalizeSiteOrder,
  sortSitesByOrder,
  moveSite,
  seedSearchSites,
  mountOptions,
} from "./index";
import { defaultSettings, type SearchSite } from "../shared/settings";
import { DEFAULT_SEARCH_SITES } from "../tools/search/searchUrl";

// --- Helpers ---------------------------------------------------------------

function site(id: string, order: number): SearchSite {
  return { id, label: id, urlTemplate: `https://x/?q={q}#${id}`, order };
}

// ---------------------------------------------------------------------------
// Pure search-site helpers (Req 12.6)
// ---------------------------------------------------------------------------

describe("normalizeSiteOrder", () => {
  it("renumbers order contiguously and zero-based, preserving sequence", () => {
    const input = [site("a", 5), site("b", 2), site("c", 99)];
    const result = normalizeSiteOrder(input);
    expect(result.map((s) => [s.id, s.order])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("does not mutate the input array or its items", () => {
    const input = [site("a", 7)];
    const result = normalizeSiteOrder(input);
    expect(input[0]!.order).toBe(7);
    expect(result[0]).not.toBe(input[0]);
  });

  it("returns an empty list for empty input", () => {
    expect(normalizeSiteOrder([])).toEqual([]);
  });
});

describe("sortSitesByOrder", () => {
  it("sorts ascending by order", () => {
    const input = [site("c", 2), site("a", 0), site("b", 1)];
    expect(sortSitesByOrder(input).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("is stable for equal orders and does not mutate input", () => {
    const input = [site("a", 0), site("b", 0), site("c", 0)];
    const result = sortSitesByOrder(input);
    expect(result.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(result).not.toBe(input);
  });
});

describe("moveSite", () => {
  const base = [site("a", 0), site("b", 1), site("c", 2)];

  it("moves an item down, swapping and renumbering", () => {
    const result = moveSite(base, 0, "down");
    expect(result.map((s) => [s.id, s.order])).toEqual([
      ["b", 0],
      ["a", 1],
      ["c", 2],
    ]);
  });

  it("moves an item up, swapping and renumbering", () => {
    const result = moveSite(base, 2, "up");
    expect(result.map((s) => [s.id, s.order])).toEqual([
      ["a", 0],
      ["c", 1],
      ["b", 2],
    ]);
  });

  it("is a no-op (normalized, unchanged sequence) moving up at the top bound", () => {
    const result = moveSite(base, 0, "up");
    expect(result.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(result.map((s) => s.order)).toEqual([0, 1, 2]);
  });

  it("is a no-op moving down at the bottom bound", () => {
    const result = moveSite(base, 2, "down");
    expect(result.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(result.map((s) => s.order)).toEqual([0, 1, 2]);
  });
});

describe("seedSearchSites", () => {
  it("returns the DEFAULT_SEARCH_SITES when the list is empty", () => {
    const result = seedSearchSites([]);
    expect(result.map((s) => s.id)).toEqual(
      DEFAULT_SEARCH_SITES.map((s) => s.id),
    );
  });

  it("returns DEFAULT_SEARCH_SITES (copies) when undefined", () => {
    const result = seedSearchSites(undefined);
    expect(result).toHaveLength(DEFAULT_SEARCH_SITES.length);
    // Fresh copies, not the frozen module constant objects.
    expect(result[0]).not.toBe(DEFAULT_SEARCH_SITES[0]);
  });

  it("sorts by order and renumbers contiguously when populated", () => {
    const input = [site("c", 9), site("a", 3), site("b", 5)];
    const result = seedSearchSites(input);
    expect(result.map((s) => [s.id, s.order])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Clear-all confirmation flow (Req 19.6, 21.7)
// ---------------------------------------------------------------------------

describe("Clear all data confirmation (Req 19.6)", () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById("app") as HTMLElement;
    mountOptions(root, defaultSettings());
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function clearButton(): HTMLButtonElement {
    const btn = root.querySelector<HTMLButtonElement>(
      '[aria-label="Clear all Alpha Cursor data"]',
    );
    if (!btn) throw new Error("Clear-all button not found");
    return btn;
  }

  it("renders a 'Clear all data' control", () => {
    const btn = clearButton();
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain("Clear all data");
  });

  it("invokes clearAll(profileId) when the user confirms", async () => {
    confirmDialogMock.mockResolvedValue(true);

    clearButton().click();
    // Let runClear's awaited confirmDialog + requireProfile + clearAll settle.
    await vi.waitFor(() => expect(clearAllMock).toHaveBeenCalledTimes(1));

    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    expect(requireProfileMock).toHaveBeenCalledTimes(1);
    expect(clearAllMock).toHaveBeenCalledWith("test-profile-id");
  });

  it("does NOT invoke clearAll when the user cancels", async () => {
    confirmDialogMock.mockResolvedValue(false);

    clearButton().click();
    await vi.waitFor(() => expect(confirmDialogMock).toHaveBeenCalledTimes(1));
    // Give any (incorrect) follow-up a chance to run before asserting absence.
    await Promise.resolve();
    await Promise.resolve();

    expect(clearAllMock).not.toHaveBeenCalled();
  });
});
