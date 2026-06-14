// Background Notepad handlers (tasks 11.4, 11.7).
//
// Registers the Notepad message handlers on the background router so the copy
// capture (content script), Copy All tool (content script), and the popup
// (task 24) can all drive the same profile-scoped storage core:
//
// - `NOTEPAD_APPEND { text, sourceUrl? }` → append an ordered entry with a
//   monotonic `seq`, overflowing large text to IndexedDB; best-effort on a
//   quota limit (Req 4.1–4.5). Returns the entry + a `quotaExceeded` flag the
//   content script uses to raise the "storage limit reached" Notification.
// - `NOTEPAD_COPY_ALL` → join all entries with the configured Separator and
//   return the string; the content/popup side performs the actual clipboard
//   write under a user gesture (MV3 service workers can't reliably write the
//   clipboard) (Req 6.2, 6.4).
// - `NOTEPAD_LIST` → return all entries (for the popup, task 24).
//
// Storage/join logic lives in `src/tools/notepad/notepad.ts`; this file is the
// thin background adapter. `installNotepad()` is called from
// `src/background/index.ts` (orchestrator wires it).

import { registerHandler } from "./router";
import {
  NotepadMessageType,
  appendEntry,
  copyAll,
  listEntries,
  removeEntry,
  clearNotepad,
  type ClearNotepadResult,
  type NotepadAppendPayload,
  type NotepadAppendResult,
  type NotepadCopyAllResult,
  type NotepadEntry,
  type NotepadRemovePayload,
  type NotepadRemoveResult,
} from "@/tools/notepad/notepad";

/**
 * Register the `NOTEPAD_APPEND`, `NOTEPAD_COPY_ALL`, and `NOTEPAD_LIST`
 * handlers. Idempotent: `registerHandler` overwrites prior registrations so
 * re-running on service-worker wake is safe.
 */
export function installNotepad(): void {
  registerHandler<NotepadAppendPayload, NotepadAppendResult>(
    NotepadMessageType.APPEND,
    async (payload) => {
      const text = typeof payload?.text === "string" ? payload.text : "";
      return appendEntry(text, payload?.sourceUrl);
    },
  );

  registerHandler<void, NotepadCopyAllResult>(
    NotepadMessageType.COPY_ALL,
    async () => copyAll(),
  );

  registerHandler<void, NotepadEntry[]>(
    NotepadMessageType.LIST,
    async () => listEntries(),
  );

  registerHandler<NotepadRemovePayload, NotepadRemoveResult>(
    NotepadMessageType.REMOVE,
    async (payload) => {
      const id = typeof payload?.id === "string" ? payload.id : "";
      if (id === "") return { removed: false };
      return removeEntry(id);
    },
  );

  registerHandler<void, ClearNotepadResult>(
    NotepadMessageType.CLEAR,
    async () => clearNotepad(),
  );
}
