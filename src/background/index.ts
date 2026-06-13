// MV3 background service worker entry point. Installs the message router on load
// so the worker registers its `chrome.runtime.onMessage` listener every time it
// boots (the worker is ephemeral under MV3). Each feature's background handlers
// register themselves on the shared router via their `install*()` function;
// they are idempotent so re-running on every worker wake is safe.
import { installRouter } from "./router";
import { installToggle } from "./toggleHandlers";
import { installNotepad } from "./notepadHandlers";
import { installTabs } from "./tabsHandlers";
import { installTabShifter } from "./tabShifterHandlers";
import { installScreenshot } from "./screenshotHandlers";
import { installImage } from "./imageHandlers";
import { installSearch } from "./searchHandlers";
import { installMedia } from "./mediaHandlers";
import { installOcr } from "./ocrHandlers";

// The router must be installed first so the onMessage listener exists before any
// handler registration.
installRouter();

// Global ON/OFF Toggle: TOGGLE_GET / TOGGLE_SET + onInstalled/onStartup (Req 1).
installToggle();

// Tool background handlers. Each registers its own message types on the router.
installNotepad(); // Tool 1 — Notepad (NOTEPAD_APPEND / COPY_ALL / LIST)
installTabs(); // Tools 2 & 3 — Save/Restore tabs (TABS_SAVE / LIST / DELETE / RESTORE)
installTabShifter(); // Tool 12 — Tab Shifter (TABS_LIST_LIGHT / TAB_ACTIVATE)
installScreenshot(); // Tool 4 — Full page screenshot (capture / download / checkpoint)
installImage(); // Tool 5 — Save image (SAVE_IMAGE_DOWNLOAD)
installSearch(); // Tool 7 — Search selected text (SEARCH_OPEN)
installMedia(); // Tool 8 — Media downloader (MEDIA_DOWNLOAD_REQUEST)
installOcr(); // Tool 10 — OCR (OCR_CAPTURE_VISIBLE_TAB)
