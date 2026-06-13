// @vitest-environment node
//
// Smoke tests for the finalized MV3 manifest (task 26.4).
//
// These validate the three privacy/security-critical guarantees the manifest
// makes, by importing the default export from `manifest.config.ts` (the object
// `defineManifest` returns):
//   - Req 22.1: MV3 + ephemeral service-worker background.
//   - Req 21.1: the declared permission set is the MINIMAL set actually used —
//     exactly ["storage","tabs","downloads"], with NO speculative permissions.
//   - Req 22.2: all executable assets are bundled locally (no remote code) —
//     the tesseract assets are exposed as web-accessible resources and no
//     http(s) URLs appear in the script entries.

import { describe, expect, it } from "vitest";

import manifest from "../manifest.config";

// `defineManifest` is typed as a union (object | Promise | factory); this
// manifest is the plain object form, so narrow to the concrete MV3 shape.
const m = manifest as chrome.runtime.ManifestV3;

describe("MV3 manifest validity (Req 22.1)", () => {
  it("declares manifest_version 3", () => {
    expect(m.manifest_version).toBe(3);
  });

  it("uses an ephemeral ES-module service worker for the background", () => {
    expect(m.background).toBeDefined();
    expect(m.background?.service_worker).toBeTruthy();
    expect(typeof m.background?.service_worker).toBe("string");
    // MV3 background is a service worker, never a persistent background page.
    expect(m.background?.type).toBe("module");
    expect(m).not.toHaveProperty("background.page");
    expect(m).not.toHaveProperty("background.persistent");
  });

  it("wires the popup and options surfaces", () => {
    expect(m.action?.default_popup).toBeTruthy();
    expect(m.options_page).toBeTruthy();
  });

  it("registers a content script matching <all_urls>", () => {
    const scripts = m.content_scripts ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    const first = scripts[0];
    expect(first).toBeDefined();
    expect(first?.matches).toContain("<all_urls>");
    expect((first?.js ?? []).length).toBeGreaterThan(0);
  });
});

describe("minimal permission declaration (Req 21.1)", () => {
  it("declares exactly the storage/tabs/downloads permissions", () => {
    expect(m.permissions).toEqual(["storage", "tabs", "downloads"]);
  });

  it("does not declare speculative permissions", () => {
    const declared = new Set<string>(m.permissions ?? []);
    for (const speculative of [
      "scripting",
      "cookies",
      "clipboardWrite",
      "clipboardRead",
      "bookmarks",
      "history",
      "webRequest",
      "<all_urls>",
    ]) {
      expect(declared.has(speculative)).toBe(false);
    }
  });

  it("declares <all_urls> as a host permission (not a plain permission)", () => {
    expect(m.host_permissions).toContain("<all_urls>");
  });
});

describe("no-remote-code asset resolution (Req 22.2)", () => {
  it("exposes the bundled tesseract assets as web-accessible resources", () => {
    const war = m.web_accessible_resources ?? [];
    expect(war.length).toBeGreaterThan(0);
    const resources = war.flatMap((entry) =>
      // MV3 web_accessible_resources entries are objects with a `resources` array.
      typeof entry === "object" && entry !== null && "resources" in entry
        ? (entry as { resources: string[] }).resources
        : [],
    );
    expect(resources).toContain("tesseract/*");
  });

  it("references only local script entries (no http(s) URLs)", () => {
    const serviceWorker = m.background?.service_worker ?? "";
    expect(serviceWorker).not.toMatch(/^https?:\/\//);

    const contentJs = (m.content_scripts ?? []).flatMap((cs) => cs.js ?? []);
    for (const entry of contentJs) {
      expect(entry).not.toMatch(/^https?:\/\//);
    }
  });
});
