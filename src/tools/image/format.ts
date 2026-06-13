// Pure helpers for Tool 5 — Save Image with Enhancement (task 14.1).
//
// This module is intentionally PURE: no Canvas, no jsPDF, no DOM, no chrome.*
// calls. It encodes the *decisions* the Save-Image tool makes — which encoder a
// format routes through, what MIME type / file extension a format maps to, and
// what output dimensions a conversion (optionally with enhancement scaling) is
// expected to produce. The actual Canvas / `createImageBitmap` / jsPDF
// conversion lives in task 14.3 and consumes these descriptors.
//
// Client-side-only scope (design "Tool 5 — Save Image with Enhancement"):
//   - PNG / JPG are produced via `canvas.toBlob(mime, quality)`.
//   - PDF is produced by drawing the decoded image into a `jsPDF` page.
//   - "Enhanced" variants are a separate flag (high-quality smoothing + a
//     sharpen/contrast pass and optional upscale); the *format* is still one of
//     png/jpg/pdf, so this module models only the three base formats.
//
// Property 11 (task 14.2) asserts, over arbitrary inputs, that:
//   - `formatToMime` maps each format to the correct MIME type, and
//   - the conversion preserves dimensions (scale 1) and scales consistently /
//     preserves aspect ratio under enhancement scaling.
//
// Design references: "Tool 5 — Save Image with Enhancement",
// "Property 11: Image conversion preserves dimensions and maps mime correctly",
// Requirements 10.2, 10.3, 10.4.

/**
 * The set of base output formats the Save-Image tool can produce. Enhancement
 * is an orthogonal flag (enhanced-JPG / enhanced-PNG, Req 10.1) and is NOT a
 * format of its own — an enhanced JPG is still `"jpg"`.
 */
export type ImageFormat = "png" | "jpg" | "pdf";

/** Default JPEG quality used by `canvas.toBlob` for lossy `"jpg"` output. */
export const DEFAULT_JPEG_QUALITY = 0.92;

/**
 * The encoding pipeline a format routes through:
 *   - `"canvas"` — `canvas.toBlob(mime, quality?)` for raster formats (png/jpg).
 *   - `"jspdf"`  — draw the decoded image into a `jsPDF` page for pdf.
 */
export type EncoderVia = "canvas" | "jspdf";

/**
 * A small, serializable descriptor telling the (impure) conversion step how to
 * encode a given format. `quality` is only meaningful for lossy raster formats
 * (jpg); it is omitted for png (lossless — `toBlob` ignores quality) and for
 * pdf (rendered via jsPDF, not `toBlob`).
 */
export interface EncoderDescriptor {
  /** Which pipeline performs the encode. */
  via: EncoderVia;
  /** MIME type of the produced artifact. */
  mime: string;
  /** Encoder quality in [0, 1]; present only for lossy raster formats (jpg). */
  quality?: number;
}

/** Output dimensions (in device pixels) of a conversion. */
export interface OutputDimensions {
  width: number;
  height: number;
}

/**
 * Map an {@link ImageFormat} to its MIME type (Req 10.2, 10.3).
 *   png → `image/png`, jpg → `image/jpeg`, pdf → `application/pdf`.
 *
 * Total over the `ImageFormat` union; throws on an out-of-union value so an
 * unexpected format never silently produces a wrong MIME type.
 */
export function formatToMime(format: ImageFormat): string {
  switch (format) {
    case "png":
      return "image/png";
    case "jpg":
      return "image/jpeg";
    case "pdf":
      return "application/pdf";
    default:
      throw new Error(`Unknown image format: ${String(format as never)}`);
  }
}

/**
 * Map an {@link ImageFormat} to the file extension used for the download name
 * (without a leading dot): png → `"png"`, jpg → `"jpg"`, pdf → `"pdf"`.
 */
export function formatToExtension(format: ImageFormat): string {
  switch (format) {
    case "png":
      return "png";
    case "jpg":
      return "jpg";
    case "pdf":
      return "pdf";
    default:
      throw new Error(`Unknown image format: ${String(format as never)}`);
  }
}

/**
 * Decide how to encode the given format and return a descriptor for the
 * conversion step.
 *   - png  → `{ via: "canvas", mime: "image/png" }` (lossless; no quality).
 *   - jpg  → `{ via: "canvas", mime: "image/jpeg", quality }` (lossy).
 *   - pdf  → `{ via: "jspdf",  mime: "application/pdf" }`.
 *
 * @param format  Target output format.
 * @param quality Optional JPEG quality override in [0, 1]; defaults to
 *                {@link DEFAULT_JPEG_QUALITY}. Ignored for png/pdf.
 */
export function chooseEncoder(
  format: ImageFormat,
  quality: number = DEFAULT_JPEG_QUALITY,
): EncoderDescriptor {
  const mime = formatToMime(format);
  switch (format) {
    case "png":
      // PNG is lossless; canvas.toBlob ignores the quality argument, so we omit
      // it from the descriptor to avoid implying it has any effect.
      return { via: "canvas", mime };
    case "jpg":
      return { via: "canvas", mime, quality: clampQuality(quality) };
    case "pdf":
      return { via: "jspdf", mime };
    default:
      throw new Error(`Unknown image format: ${String(format as never)}`);
  }
}

/**
 * The PURE half of the decode→encode→decode dimension round-trip invariant
 * (Property 11). Given a source image's pixel dimensions and an enhancement
 * scale factor, return the dimensions the converted output is expected to have.
 *
 * At `scale === 1` (non-enhanced conversion, Req 10.2) the output dimensions
 * equal the source dimensions exactly — dimensions are preserved. Under
 * enhancement upscaling (`scale > 1`, Req 10.3) both axes scale by the same
 * factor, preserving aspect ratio. Results are rounded to whole pixels since
 * Canvas dimensions are integral.
 *
 * @param srcW  Source width in pixels (non-negative, finite).
 * @param srcH  Source height in pixels (non-negative, finite).
 * @param scale Uniform scale factor applied to both axes (default 1).
 */
export function preservesDimensions(
  srcW: number,
  srcH: number,
  scale: number = 1,
): OutputDimensions {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW < 0 || srcH < 0) {
    throw new Error(`Invalid source dimensions: ${srcW}x${srcH}`);
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Invalid scale factor: ${scale}`);
  }
  return {
    width: Math.round(srcW * scale),
    height: Math.round(srcH * scale),
  };
}

/** Clamp a quality value into the valid [0, 1] range `canvas.toBlob` accepts. */
function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) {
    return DEFAULT_JPEG_QUALITY;
  }
  return Math.min(1, Math.max(0, quality));
}
