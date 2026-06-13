# Implementation Plan: Alpha Cursor Extension

## Overview

Convert the feature design into a series of incremental coding steps that build the 100% client-side Manifest V3 Chrome extension. Each task builds on the previous ones and ends with wiring into the larger system, so there is no orphaned code.

Sequencing: foundational scaffolding first (project init, manifest, build config, Tailwind v4 + Notion tokens, storage layer, local identity, message envelope/router, Shadow DOM base + Notion UI primitives, Notification, Toggle), then the context-aware Options_Panel, then each of the twelve tools as incremental tasks, then the popup and options page, then permissions/privacy + manifest finalization, then full test/build verification.

Stack: Vite + `@crxjs/vite-plugin` + TypeScript, Tailwind CSS v4, Shadow DOM for injected UI, bundled `jsPDF` and `tesseract.js` (no remote code). Property-based tests use `fast-check` + Vitest at a minimum of 100 runs per property; everything else uses example/integration/smoke tests.

Property test tagging format (used in every PBT sub-task):
`// Feature: alpha-cursor-extension, Property {number}: {property_text}`

## Tasks

- [x] 1. Project scaffolding and setup
  - Initialize a Vite + TypeScript project with `@crxjs/vite-plugin` for MV3-aware bundling
  - Create the source layout: `src/background/`, `src/content/`, `src/popup/`, `src/options/`, `src/shared/`, `src/ui/`, `src/tools/`
  - Add dependencies: `vite`, `@crxjs/vite-plugin`, `typescript`, `tailwindcss` (v4) + `@tailwindcss/vite`, `jspdf`, `tesseract.js`, and dev dependencies `vitest`, `fast-check`, `sinon-chrome`, `@types/chrome`
  - Configure `tsconfig.json` (strict mode) and `vitest.config.ts` (jsdom environment for DOM-touching tests)
  - Add npm scripts: `dev`, `build`, `test` (with `--run`), `typecheck`
  - _Requirements: 22.1, 22.2_

- [x] 2. Build configuration and base MV3 manifest
  - [x] 2.1 Author `vite.config.ts` with the crxjs plugin and `@tailwindcss/vite`, wiring background service worker, content script, popup, and options entry points
    - Ensure bundled assets (jsPDF, tesseract WASM + worker + trained-data) are emitted into the package and referenced via `chrome.runtime.getURL` (no remote code)
    - _Requirements: 22.1, 22.2_
  - [x] 2.2 Create the initial `manifest.config.ts` (or `manifest.json`) with MV3 `service_worker` background, content script registration, `action` popup, and `options_page`
    - Declare a minimal initial permission set; host/device permissions added at point of use later
    - _Requirements: 21.1, 22.1_

- [x] 3. Tailwind v4 and Notion design tokens
  - [x] 3.1 Create the Tailwind v4 entry stylesheet (`@import "tailwindcss"`) and a `@theme` block mapping DESIGN.md color, typography, spacing, radius, and elevation tokens to CSS variables
    - Configure Inter font family stack and the reserved primary blue accent
    - Provide a shared style string/asset importable into Shadow DOM roots
    - _Requirements: 20.1, 20.2, 20.3, 20.4_
  - [x]* 3.2 Write a smoke/snapshot test asserting token variables and Inter family are present in the generated CSS
    - _Requirements: 20.2, 20.4_

- [x] 4. Storage layer module and local identity
  - [x] 4.1 Implement `src/shared/storage.ts` encapsulating the sync/local/IndexedDB tiering with profile-scoped keys (`acx:{localProfileId}:{domain}:{...}`)
    - Provide typed get/set helpers for `chrome.storage.sync`, `chrome.storage.local`, and an IndexedDB (`acx-blobs`) blob store
    - Wrap all `chrome.*` calls to convert `lastError`/rejections into `AppError`
    - Implement `clearAll(profileId)` removing every profile-scoped key across sync, local, and IndexedDB
    - _Requirements: 3.2, 3.3, 22.5, 19.6, 21.7_
  - [x] 4.2 Implement `src/shared/identity.ts` with `ensureLocalProfile()` creating/persisting a UUID v4 `localProfileId` eagerly on load and blocking writes until it exists
    - _Requirements: 3.1, 3.4, 3.5_
  - [x]* 4.3 Write property test for profile-scoped reads
    - **Property 19: Storage reads are scoped to the active local profile**
    - **Validates: Requirements 3.2, 3.3**
  - [x]* 4.4 Write property test for clear-data completeness
    - **Property 20: Clear-data removes all profile-scoped data**
    - **Validates: Requirements 19.6, 21.7**
  - [x]* 4.5 Write unit tests for identity creation and write-blocking on failure
    - _Requirements: 3.4, 3.5_

- [x] 5. Message envelope and router
  - [x] 5.1 Define the typed `Message<T>` / `Response<R>` envelope and the `AppError` discriminated union in `src/shared/messaging.ts`
    - _Requirements: 22.1_
  - [x] 5.2 Implement the background message router (`src/background/router.ts`) dispatching by `type` with typed handler registration and uniform error normalization
    - _Requirements: 22.1, 22.3_
  - [x]* 5.3 Write unit tests for router dispatch and error normalization using `sinon-chrome` mocks
    - _Requirements: 22.1_

- [x] 6. Shadow DOM base and Notion UI primitives
  - [x] 6.1 Implement a closed Shadow DOM host factory (`src/ui/shadowHost.ts`) that injects the Tailwind token stylesheet and mounts content-script UI in isolation
    - _Requirements: 2.11, 20.1_
  - [x] 6.2 Implement Notion UI primitives (`src/ui/primitives/`): button (primary/utility/icon-circular), card/surface, text-input, badge-pill, with visible focus rings, aria-labels for icon-only controls, and `prefers-reduced-motion` honoring
    - _Requirements: 20.3, 20.5, 20.6, 20.7_
  - [x]* 6.3 Write component snapshot tests for primitives asserting Notion-token conformance
    - _Requirements: 20.1, 20.2, 20.3, 20.5, 20.7_

- [x] 7. Notification system
  - [x] 7.1 Implement `notify({ kind, text, code? })` rendering a transient `ex-toast` styled toast inside the content-script Shadow DOM, honoring reduced motion
    - _Requirements: 20.1, 20.6_
  - [x]* 7.2 Write unit/snapshot test for toast rendering and auto-dismiss
    - _Requirements: 20.1_

- [x] 8. Global ON/OFF Toggle
  - [x] 8.1 Implement Toggle state module: `TOGGLE_SET`/`TOGGLE_GET` handlers, persistence to `chrome.storage.sync` (fallback `local`) within 500ms, and restore on `onStartup`/`onInstalled`
    - Content scripts subscribe via `chrome.storage.onChanged`; when OFF, remove the middle-click handler and disable cookie removal
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6_
  - [x]* 8.2 Write integration tests for persistence timing and startup restore (mocked Chrome APIs)
    - _Requirements: 1.4, 1.5_

- [ ] 9. Checkpoint - foundation
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Context-aware Options_Panel
  - [x] 10.1 Implement `resolveContext(event): ContextType` with precedence: non-empty selection → `selected-text`; else `<img>`/CSS background → `image`; else `<video>` → `video`; else `generic-page`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - [x]* 10.2 Write property test for context precedence
    - **Property 1: Context resolution honors precedence**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
  - [x] 10.3 Implement the tool-set resolver mapping a `ContextType` to context-independent tools plus exactly the applicable context-specific tools
    - _Requirements: 2.6_
  - [x]* 10.4 Write property test for tool-set composition
    - **Property 2: Tool set always includes context-independent tools**
    - **Validates: Requirements 2.6**
  - [x] 10.5 Implement radial panel rendering in the Shadow DOM with viewport-edge repositioning (`repositionPanel(point, panelSize, viewport)`), middle-click open, outside-click/Escape close, and tool dispatch on select
    - _Requirements: 2.7, 2.8, 2.9, 2.10, 2.11_
  - [x]* 10.6 Write property test for viewport containment
    - **Property 3: Panel stays within the viewport**
    - **Validates: Requirements 2.8**
  - [x]* 10.7 Write unit tests for open/close on middle-click, Escape, and outside-click
    - _Requirements: 1.3, 2.9, 2.10_

- [x] 11. Tool 1 — Notepad Clipboard
  - [x] 11.1 Implement pure helpers `resolveSeparator(raw)` (defaults to comma on missing/invalid) and `joinEntries(entries, separator)` (separator only between consecutive entries)
    - _Requirements: 5.5, 5.6, 6.2_
  - [x]* 11.2 Write property test for separator resolution
    - **Property 6: Separator resolution always yields a valid separator**
    - **Validates: Requirements 5.5**
  - [x]* 11.3 Write property test for join logic
    - **Property 7: Join inserts the separator only between consecutive entries**
    - **Validates: Requirements 5.6, 6.2**
  - [x] 11.4 Implement copy-event capture in the content script (`NOTEPAD_APPEND`) with monotonic `seq` ordering, best-effort append on quota exceed, and `chrome.storage.local` + IndexedDB overflow persistence
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [ ]* 11.5 Write property test for append growth and ordering
    - **Property 4: Notepad append grows and preserves order**
    - **Validates: Requirements 4.1, 4.5**
  - [ ]* 11.6 Write property test for origin-independent capture
    - **Property 5: Capture is origin-independent**
    - **Validates: Requirements 4.3**
  - [x] 11.7 Implement `NOTEPAD_COPY_ALL` (join + `navigator.clipboard.writeText`) with empty-notepad notification and no clipboard write
    - _Requirements: 6.1, 6.3, 6.4, 6.5_
  - [ ]* 11.8 Write edge-case tests for quota-exceed notification and empty/failed Copy All
    - _Requirements: 4.4, 6.4, 6.5_

- [x] 12. Tool 2 — Save All Tabs and Tool 3 — Restore Saved Tabs
  - [x] 12.1 Implement pure helpers `validateFolderName` and `partitionOpenableUrls(urls)` → `{ openable, invalid }`
    - _Requirements: 7.4, 8.3, 8.4, 8.5_
  - [x]* 12.2 Write property test for URL partitioning
    - **Property 9: URL partition is complete and disjoint**
    - **Validates: Requirements 8.3, 8.4, 8.5**
  - [x] 12.3 Implement background `TABS_SAVE`/`TABS_LIST`/`TABS_DELETE`: enumerate `chrome.tabs.query({ currentWindow: true })`, store `{url,title}[]` snapshots, handle name collision via `NAME_EXISTS`, and the no-tabs case
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - [ ]* 12.4 Write property test for tab snapshot fidelity
    - **Property 8: Tab snapshot fidelity**
    - **Validates: Requirements 7.3**
  - [x] 12.5 Implement background `TABS_RESTORE`: open openable URLs, count failures, report count, and notify + open nothing when none are openable; wire the restore/delete UI list
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_
  - [ ]* 12.6 Write integration tests for save/restore/delete and name-collision flow (mocked Chrome APIs)
    - _Requirements: 7.4, 7.7, 8.3_

- [ ] 13. Tool 4 — Full Page Screenshot
  - [x] 13.1 Implement pure `computeSegments(totalHeight, viewportHeight, devicePixelRatio)` returning gap-free, fully-covering scroll offsets and draw rects meeting the Full HD width threshold where permitted
    - _Requirements: 9.2, 9.3_
  - [x]* 13.2 Write property test for screenshot segmentation
    - **Property 10: Screenshot segmentation fully covers the page**
    - **Validates: Requirements 9.2, 9.3**
  - [ ] 13.3 Implement the capture orchestrator: content script drives auto-scroll + reports metrics; background calls `captureVisibleTab` per segment; stitch on Canvas/OffscreenCanvas; write `OperationCheckpoint` for SW-restart resumption
    - _Requirements: 9.2, 9.7, 22.3_
  - [ ] 13.4 Implement output handling: prompt PDF (jsPDF) vs high-quality image, generate, and auto-download via `chrome.downloads`; failure → notification, no download; show Notion progress indicator
    - _Requirements: 9.4, 9.5, 9.6, 9.7_
  - [ ]* 13.5 Write integration test for downloads + jsPDF output and checkpoint resume (mocked Chrome APIs)
    - _Requirements: 9.5, 22.3_

- [ ] 14. Tool 5 — Save Image with Enhancement
  - [x] 14.1 Implement pure helpers `chooseEncoder(format)`, `formatToMime(format)`, and the decode→encode→decode dimension round-trip helper
    - _Requirements: 10.2, 10.3, 10.4_
  - [x]* 14.2 Write property test for image conversion
    - **Property 11: Image conversion preserves dimensions and maps mime correctly**
    - **Validates: Requirements 10.2, 10.3, 10.4**
  - [ ] 14.3 Implement image fetch → Canvas via `createImageBitmap` (WebP decode), optional enhancement (high-quality smoothing + sharpen/contrast convolution on OffscreenCanvas), conversion via `canvas.toBlob` or jsPDF page, and auto-download; failure → notification, no download; success → notification with format
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_
  - [ ]* 14.4 Write edge-case test for unretrievable/undecodable source
    - _Requirements: 10.5_

- [x] 15. Tool 6 — Cookie Consent Popup Removal
  - [x] 15.1 Implement pure helpers `matchesConsentRule(element, ruleset)` and `restoreScrollState(prev)`, plus the bundled consent ruleset
    - _Requirements: 11.1, 11.2, 11.5_
  - [x]* 15.2 Write property test for consent removal scope
    - **Property 12: Consent removal touches only matching elements**
    - **Validates: Requirements 11.1, 11.2, 11.5**
  - [x]* 15.3 Write property test for scroll-state restoration
    - **Property 13: Scroll state restoration round-trips**
    - **Validates: Requirements 11.3**
  - [x] 15.4 Wire content-script detection on load + `MutationObserver` for late-injected popups; remove matches, restore body scroll/overflow; disabled when Toggle OFF
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.6_

- [x] 16. Tool 7 — Search Selected Text
  - [x] 16.1 Implement pure `buildSearchUrl(template, selection)` that URL-encodes the selection into the `{q}` placeholder
    - _Requirements: 12.2, 12.3_
  - [x]* 16.2 Write property test for search URL encoding
    - **Property 14: Search URL encodes and round-trips the selection**
    - **Validates: Requirements 12.2, 12.3**
  - [x] 16.3 Wire the "Search in" sub-menu (YouTube/Reddit/Quora + configured sites), open results in a new tab, empty-selection notification + no tab, and silent handling when the tab is blocked
    - _Requirements: 12.1, 12.2, 12.4, 12.5_

- [ ] 17. Tool 8 — Media Downloader (best-effort, honestly scoped)
  - [x] 17.1 Implement pure helpers `classifyMediaTarget(element, pageMeta)` → feasible/infeasible + reason and `isDirectlyDownloadable(url)`, ensuring DRM, signed/expiring, login-gated, and bulk-scrape targets are never marked feasible
    - _Requirements: 13.1, 13.3, 13.4, 13.5, 22.4_
  - [x]* 17.2 Write property test for the media classifier
    - **Property 15: Media classifier never marks protected media feasible**
    - **Validates: Requirements 13.1, 13.3, 13.4, 13.5, 22.4**
  - [ ] 17.3 Wire content/background download of directly-accessible media via `chrome.downloads`; disable infeasible options with an explanatory notification; show the ToS notice before the first download; report failures by item
    - _Requirements: 13.2, 13.6, 13.7, 13.8, 22.4_
  - [ ]* 17.4 Write example test for the ToS-notice-before-first-download flow
    - _Requirements: 13.8_

- [x] 18. Tool 9 — Color Picker
  - [x] 18.1 Implement pure helpers `rgbToHex(r,g,b)` / `formatColor(sample)` producing paste-ready `#rrggbb` that round-trips
    - _Requirements: 14.7_
  - [x]* 18.2 Write property test for color formatting
    - **Property 16: Color formatting is paste-ready and round-trips**
    - **Validates: Requirements 14.7**
  - [x] 18.3 Wire the eyedropper: prefer native `EyeDropper`, fallback to Canvas-sampled overlay; copy hex on click; Escape deactivates without copying; sampling failure → notification, no clipboard write; success notification with code
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6_

- [ ] 19. Tool 10 — OCR Text Extraction
  - [x] 19.1 Implement pure `normalizeSelectionRect(start, end)` yielding non-negative width/height regardless of drag direction
    - _Requirements: 15.2_
  - [x]* 19.2 Write property test for selection-rectangle normalization
    - **Property 17: Selection rectangle normalization**
    - **Validates: Requirements 15.2**
  - [ ] 19.3 Wire drag-selection overlay, region rasterization (`captureVisibleTab` crop / `drawImage(video)`), bundled `tesseract.js` (local WASM + worker) extraction, clipboard copy + notification, no-text notification, and Escape cancel
    - _Requirements: 15.1, 15.3, 15.4, 15.5, 15.6_
  - [ ]* 19.4 Write edge-case test for the no-text-found path
    - _Requirements: 15.5_

- [ ] 20. Tool 11 — Voice to Text
  - [ ] 20.1 Implement the voice transcriber using Web Speech API `SpeechRecognition`: mic control UI, permission request, interim+final transcripts, and on stop expose text to copy or insert into the field focused at start
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.6_
  - [ ]* 20.2 Write example tests for permission-denied notification and focused-field insertion
    - _Requirements: 16.5, 16.6_

- [ ] 21. Tool 12 — Tab Shifter
  - [ ] 21.1 Implement `TABS_LIST_LIGHT` (id, title, favIconUrl) and `TAB_ACTIVATE { tabId }` handlers and the radial Shadow-DOM tab panel with favicon + title, Notion placeholder for missing favicon, and Escape-closes-without-switching
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6_
  - [ ]* 21.2 Write integration/example tests for tab activation and favicon placeholder
    - _Requirements: 17.4, 17.5_

- [x] 22. Tool — Horizontal Scroll
  - [x] 22.1 Implement pure `wheelToHorizontalDelta(deltaY, deltaX)` mapping vertical wheel intent to horizontal scroll preserving magnitude and direction
    - _Requirements: 18.2, 18.3_
  - [x]* 22.2 Write property test for wheel-to-horizontal mapping
    - **Property 18: Wheel-to-horizontal mapping**
    - **Validates: Requirements 18.2, 18.3**
  - [x] 22.3 Wire the toggleable horizontal-scroll mode with an active-mode indicator; selecting again disables it
    - _Requirements: 18.1, 18.4, 18.5_

- [ ] 23. Checkpoint - all tools
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 24. Popup surface
  - [ ] 24.1 Build the popup UI (Tailwind v4 + Notion tokens): global Toggle with two states, compact notepad view, and "Copy All"
    - _Requirements: 1.1, 6.1, 19.1, 20.1_
  - [ ]* 24.2 Write unit/snapshot tests for popup Toggle two states
    - _Requirements: 1.1_

- [ ] 25. Options page
  - [ ] 25.1 Build the options page: separator config (comma/dash/slash/custom), "Search in" site list add/remove/reorder, sync preference (`chrome-sync` vs `local-only`), current Toggle state + change, all persisting within 500ms
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 12.6, 19.1, 19.2, 19.3, 19.4, 19.5_
  - [ ] 25.2 Implement clear-all-notepad control with confirmation, wired to `storage.clearAll` scoping
    - _Requirements: 19.6, 21.7_
  - [ ]* 25.3 Write edge-case + integration tests for separator persistence-failure-silent, settings 500ms persistence, and clear-all confirmation
    - _Requirements: 5.3, 5.4, 19.3, 19.6_

- [ ] 26. Permissions, privacy, and manifest finalization
  - [ ] 26.1 Implement point-of-use host/device permission requests with graceful denial (notify the affected feature, keep other features working)
    - _Requirements: 21.2, 21.3_
  - [ ] 26.2 Add the privacy statement to the options page stating all data is stored locally (no Alpha Cursor server exists), "cloud sync" = Chrome `storage.sync`, and the Web Speech API browser-native nuance
    - _Requirements: 21.4_
  - [ ] 26.3 Finalize the MV3 manifest to declare only the minimal permissions actually used by implemented features
    - _Requirements: 21.1, 22.1_
  - [ ]* 26.4 Write smoke tests for manifest validity, minimal-permission declaration, and no-remote-code asset resolution via `chrome.runtime.getURL`
    - _Requirements: 21.1, 22.1, 22.2_

- [ ] 27. Final verification and build
  - [ ] 27.1 Run the full test suite (property tests at min 100 runs, example/integration/smoke), fix failures, and run a production `build` to confirm the packaged extension emits all bundled assets
    - _Requirements: 22.1, 22.2_

- [ ] 28. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP.
- Each task references specific requirement sub-clauses for traceability; property test sub-tasks reference the exact design property they validate.
- Property-based tests use `fast-check` + Vitest at a minimum of 100 runs and are placed next to the implementation they validate to catch errors early.
- UI rendering, Chrome-API wiring, bundled libraries (tesseract.js, jsPDF), Web Speech, and the media network layer are covered by example/integration/smoke tests rather than property tests, per the design's Testing Strategy.
- Checkpoints ensure incremental validation at the foundation, post-tools, and final stages.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "2.2", "3.1"] },
    { "id": 2, "tasks": ["3.2", "4.1", "4.2", "5.1"] },
    { "id": 3, "tasks": ["4.3", "4.4", "4.5", "5.2", "6.1"] },
    { "id": 4, "tasks": ["5.3", "6.2", "7.1"] },
    { "id": 5, "tasks": ["6.3", "7.2", "8.1"] },
    { "id": 6, "tasks": ["8.2", "10.1", "10.3", "10.5"] },
    { "id": 7, "tasks": ["10.2", "10.4", "10.6", "10.7"] },
    { "id": 8, "tasks": ["11.1", "12.1", "13.1", "14.1", "15.1", "16.1", "17.1", "18.1", "19.1", "22.1"] },
    { "id": 9, "tasks": ["11.2", "11.3", "12.2", "13.2", "14.2", "15.2", "15.3", "16.2", "17.2", "18.2", "19.2", "22.2"] },
    { "id": 10, "tasks": ["11.4", "11.7", "12.3", "12.5", "13.3", "13.4", "14.3", "15.4", "16.3", "17.3", "18.3", "19.3", "20.1", "21.1", "22.3"] },
    { "id": 11, "tasks": ["11.5", "11.6", "11.8", "12.4", "12.6", "13.5", "14.4", "17.4", "19.4", "20.2", "21.2"] },
    { "id": 12, "tasks": ["24.1", "25.1", "25.2", "26.1", "26.2"] },
    { "id": 13, "tasks": ["24.2", "25.3", "26.3"] },
    { "id": 14, "tasks": ["26.4", "27.1"] }
  ]
}
```
