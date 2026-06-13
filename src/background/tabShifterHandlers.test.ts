// Integration / example tests for the background Tab Shifter handlers (task 21.2).
//
// `installTabShifter()` registers TABS_LIST_LIGHT / TAB_ACTIVATE on the shared
// router. These tests exercise both the router dispatch path and the exported
// handler functions directly, asserting:
//
//   - Req 17.3 / 17.5: TABS_LIST_LIGHT projects chrome.tabs.query to
//     { id, title, favIconUrl }; tabs without a numeric id are dropped; a
//     blank/whitespace favIconUrl is normalized away (so the panel renders the
//     placeholder, Req 17.5) while a present favIconUrl is kept (Req 17.3).
//   - Req 17.4: TAB_ACTIVATE activates the tab via chrome.tabs.update and
//     best-effort focuses its window via chrome.windows.update, returns
//     { activated: true }; an invalid/non-numeric tabId returns
//     { activated: false } without throwing, and a chrome.tabs.update rejection
//     also degrades to { activated: false }.
//
// The ambient `chrome.*` surface is a hand-rolled in-memory fake providing
// tabs.query / tabs.update + optional windows.update.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installTabShifter,
  handleTabsListLight,
  handleTabActivate,
  TabShifterMessageType,
} from "./tabShifterHandlers";
import { clearHandlers, dispatch } from "./router";
import { createMessage, isOk } from "@/shared/messaging";

// ---------------------------------------------------------------------------
// In-memory chrome fake: tabs.query / tabs.update + optional windows.update.
// ---------------------------------------------------------------------------

interface FakeTab {
  id?: number;
  title?: string;
  favIconUrl?: string;
  windowId?: number;
}

interface ChromeFake {
  /** Tabs returned by chrome.tabs.query({ currentWindow: true }). */
  queryTabs: FakeTab[];
  /** Tab ids passed to chrome.tabs.update, in call order. */
  updated: Array<{ tabId: number; active?: boolean }>;
  /** Tab ids whose chrome.tabs.update should reject. */
  updateFailureIds: Set<number>;
  /** windowId values passed to chrome.windows.update, in call order. */
  windowFocus: number[];
  /** When false, chrome.windows is omitted entirely from the fake. */
  withWindows: boolean;
}

function installChromeFake(withWindows = true): ChromeFake {
  const fake: ChromeFake = {
    queryTabs: [],
    updated: [],
    updateFailureIds: new Set<number>(),
    windowFocus: [],
    withWindows,
  };

  const base: Record<string, unknown> = {
    tabs: {
      query: (_info: unknown, cb?: (tabs: unknown[]) => void) => {
        const result = fake.queryTabs.map((t) => ({ ...t }));
        if (cb) {
          cb(result);
          return undefined;
        }
        return Promise.resolve(result);
      },
      update: (tabId: number, props: { active?: boolean }) => {
        if (fake.updateFailureIds.has(tabId)) {
          return Promise.reject(new Error(`tabs.update failed for ${tabId}`));
        }
        fake.updated.push({ tabId, active: props?.active === true });
        const source = fake.queryTabs.find((t) => t.id === tabId);
        const windowId = source?.windowId ?? 1;
        return Promise.resolve({ id: tabId, windowId });
      },
    },
  };

  if (withWindows) {
    base.windows = {
      update: (windowId: number) => {
        fake.windowFocus.push(windowId);
        return Promise.resolve({ id: windowId });
      },
    };
  }

  (globalThis as unknown as { chrome: unknown }).chrome = base;
  return fake;
}

// ---------------------------------------------------------------------------

let fake: ChromeFake;
const noSender = {} as chrome.runtime.MessageSender;

beforeEach(() => {
  fake = installChromeFake();
  clearHandlers();
  installTabShifter();
});

afterEach(() => {
  clearHandlers();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

// ---------------------------------------------------------------------------
// TABS_LIST_LIGHT projection (Req 17.3, 17.5)
// ---------------------------------------------------------------------------

describe("TABS_LIST_LIGHT projection (task 21.2, Req 17.3/17.5)", () => {
  it("projects tabs to { id, title, favIconUrl } via dispatch", async () => {
    fake.queryTabs = [
      { id: 1, title: "One", favIconUrl: "https://a.example/favicon.ico" },
      { id: 2, title: "Two", favIconUrl: "https://b.example/favicon.ico" },
    ];

    const response = await dispatch(
      createMessage(TabShifterMessageType.LIST_LIGHT, undefined),
      noSender,
    );

    expect(isOk(response)).toBe(true);
    if (isOk(response)) {
      expect(response.data).toEqual([
        { id: 1, title: "One", favIconUrl: "https://a.example/favicon.ico" },
        { id: 2, title: "Two", favIconUrl: "https://b.example/favicon.ico" },
      ]);
    }
  });

  it("drops tabs without a numeric id", async () => {
    fake.queryTabs = [
      { id: 1, title: "Keep", favIconUrl: "https://a.example/f.ico" },
      { title: "NoId", favIconUrl: "https://b.example/f.ico" },
      { title: "AlsoNoId" },
    ];

    const tabs = await handleTabsListLight();

    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.id).toBe(1);
  });

  it("keeps a present favIconUrl (Req 17.3) and omits a blank/whitespace one (Req 17.5)", async () => {
    fake.queryTabs = [
      { id: 1, title: "HasIcon", favIconUrl: "https://a.example/f.ico" },
      { id: 2, title: "BlankIcon", favIconUrl: "   " },
      { id: 3, title: "EmptyIcon", favIconUrl: "" },
      { id: 4, title: "MissingIcon" },
    ];

    const tabs = await handleTabsListLight();

    expect(tabs).toHaveLength(4);
    // Present favicon retained verbatim (Req 17.3).
    expect(tabs[0]).toEqual({
      id: 1,
      title: "HasIcon",
      favIconUrl: "https://a.example/f.ico",
    });
    // Blank / empty / missing all normalize to an omitted favIconUrl so the
    // panel renders the placeholder (Req 17.5).
    for (const index of [1, 2, 3]) {
      expect(tabs[index]!.favIconUrl).toBeUndefined();
      expect("favIconUrl" in tabs[index]!).toBe(false);
    }
  });

  it("defaults a missing title to an empty string", async () => {
    fake.queryTabs = [{ id: 5, favIconUrl: "https://a.example/f.ico" }];

    const tabs = await handleTabsListLight();

    expect(tabs[0]!.title).toBe("");
  });
});

// ---------------------------------------------------------------------------
// TAB_ACTIVATE (Req 17.4)
// ---------------------------------------------------------------------------

describe("TAB_ACTIVATE (task 21.2, Req 17.4)", () => {
  it("activates the tab and best-effort focuses its window via dispatch", async () => {
    fake.queryTabs = [{ id: 3, title: "Target", windowId: 12 }];

    const response = await dispatch(
      createMessage(TabShifterMessageType.ACTIVATE, { tabId: 3 }),
      noSender,
    );

    expect(isOk(response)).toBe(true);
    if (isOk(response)) {
      expect(response.data).toEqual({ activated: true });
    }
    expect(fake.updated).toEqual([{ tabId: 3, active: true }]);
    expect(fake.windowFocus).toEqual([12]);
  });

  it("still activates when chrome.windows is unavailable", async () => {
    fake = installChromeFake(false);
    fake.queryTabs = [{ id: 4, title: "NoWindows", windowId: 1 }];

    const result = await handleTabActivate({ tabId: 4 });

    expect(result).toEqual({ activated: true });
    expect(fake.updated).toEqual([{ tabId: 4, active: true }]);
  });

  it("returns { activated: false } for a non-numeric tabId without throwing", async () => {
    const result = await handleTabActivate({
      tabId: "nope" as unknown as number,
    });

    expect(result).toEqual({ activated: false });
    expect(fake.updated).toHaveLength(0);
  });

  it("returns { activated: false } for a non-finite tabId", async () => {
    const result = await handleTabActivate({ tabId: Number.NaN });

    expect(result).toEqual({ activated: false });
    expect(fake.updated).toHaveLength(0);
  });

  it("degrades to { activated: false } when chrome.tabs.update rejects", async () => {
    fake.queryTabs = [{ id: 9, title: "Gone", windowId: 1 }];
    fake.updateFailureIds.add(9);

    const result = await handleTabActivate({ tabId: 9 });

    expect(result).toEqual({ activated: false });
  });
});
