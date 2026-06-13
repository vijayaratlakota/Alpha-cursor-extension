// Tool modules barrel: the twelve Alpha Cursor tools (notepad, tabs, screenshot,
// image save, cookie removal, search, media, color picker, OCR, voice, tab
// shifter, horizontal scroll). Implemented across tasks 11-22.

// Tool 7 — Search Selected Text (Req 12), task 16.1.
export {
  buildSearchUrl,
  DEFAULT_SEARCH_SITES,
  QUERY_PLACEHOLDER,
} from "./search/searchUrl";

// Tool 9 — Color Picker (Req 14) pure helpers, task 18.1.
export { rgbToHex, hexToRgb, formatColor } from "./color/color";
export type { Rgb } from "./color/color";
// Tool 10 — OCR Text Extraction (Req 15) drag-selection geometry, task 19.1.
export { normalizeSelectionRect } from "./ocr/selectionRect";
export type { Point, SelectionRect } from "./ocr/selectionRect";
// Tool 10 — OCR Text Extraction (Req 15) tool wiring, task 19.3.
export { registerOcrTool, isOcrOverlayOpen } from "./ocr/ocrTool";
export {
  DEFAULT_OCR_LANG,
  localWorkerOptions,
  workerScriptUrl,
  coreDirUrl,
  langDirUrl,
} from "./ocr/tesseractAssets";

// Tool 8 (Media Downloader) pure helpers — task 17.1.
export {
  MediaInfeasibilityCode,
  MAX_DATA_URL_LENGTH,
  isDirectlyDownloadable,
  classifyMediaTarget,
} from "./media/classify";
export type { MediaFeasibility, MediaTarget, PageMeta } from "./media/classify";
