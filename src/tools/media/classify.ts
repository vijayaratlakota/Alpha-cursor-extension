// Pure helpers for Tool 8 (Media Downloader, Req 13 — honestly scoped,
// best-effort). This module is intentionally PURE — no `chrome.*`, network,
// storage, or DOM dependencies — so the content/background download wiring
// (task 17.3) can compose it and the property test (task 17.2, Property 15)
// can exercise it deterministically.
//
// Design references:
// - "Tool 8 — Media Downloader (Req 13 — honestly scoped, best-effort)":
//   "Pure helpers (property-tested): `classifyMediaTarget(element, pageMeta)`
//   → feasible/infeasible + reason; `isDirectlyDownloadable(url)`."
// - "Property 15: Media classifier never marks protected media feasible"
//   (Req 13.1, 13.3, 13.4, 13.5, 22.4).
//
// HONEST-FEASIBILITY CONTRACT (the whole point of this module):
// Under the 100% client-side, no-server, MV3 (no remote code) constraint, the
// extension can only download media it can directly `fetch` + hand to
// `chrome.downloads`. Anything requiring muxing (adaptive DASH/HLS), DRM
// decryption (Widevine), a signed/expiring URL it cannot legitimately re-sign,
// authenticated/login-gated social media, or bulk scraping of "all posts/all
// videos" (a platform-ToS violation) is NEVER classified as feasible. The
// download UI disables those options with an explanatory notification (task
// 17.3, Req 22.4) rather than silently failing.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Machine-readable reason explaining a feasibility decision. Carried on every
 * {@link MediaFeasibility} so the download UI (task 17.3) can pick the right
 * explanatory notification and so the property test can assert *why* a target
 * was rejected, not just that it was.
 */
export const MediaInfeasibilityCode = {
  /** DRM/Widevine-protected stream — cannot be decrypted client-side. */
  DRM_PROTECTED: "DRM_PROTECTED",
  /** Signed/expiring URL (expiry/signature/token query params present). */
  SIGNED_OR_EXPIRING: "SIGNED_OR_EXPIRING",
  /** Login-gated social media requiring authentication. */
  LOGIN_GATED: "LOGIN_GATED",
  /** Bulk scrape request ("all posts"/"all videos") — ToS violation. */
  BULK_SCRAPE: "BULK_SCRAPE",
  /** Adaptive manifest (.m3u8/.mpd) needing muxing — needs server/ffmpeg. */
  ADAPTIVE_STREAM: "ADAPTIVE_STREAM",
  /** YouTube adaptive stream / MP3 transcoding — needs server/ffmpeg. */
  TRANSCODE_REQUIRED: "TRANSCODE_REQUIRED",
  /** Source URL is missing, malformed, or otherwise not directly fetchable. */
  NOT_DIRECTLY_DOWNLOADABLE: "NOT_DIRECTLY_DOWNLOADABLE",
} as const;

/** Union of media infeasibility reason codes. */
export type MediaInfeasibilityCode =
  (typeof MediaInfeasibilityCode)[keyof typeof MediaInfeasibilityCode];

/**
 * Result of {@link classifyMediaTarget}. A discriminated union on `feasible`:
 *  - `feasible: true` carries the directly-downloadable `url` the caller hands
 *    to `chrome.downloads`, plus a human-readable `reason`.
 *  - `feasible: false` carries a machine-readable `code` and a human-readable
 *    `reason` for the disabled-option notification (Req 22.4).
 */
export type MediaFeasibility =
  | { feasible: true; reason: string; url: string }
  | { feasible: false; reason: string; code: MediaInfeasibilityCode };

/**
 * Minimal descriptor of a media download target. Deliberately loose (all fields
 * optional) so the content-script resolver can pass whatever it managed to read
 * off the DOM/page without the pure layer demanding a fully-populated object.
 */
export interface MediaTarget {
  /** Element tag (e.g. `"VIDEO"`, `"IMG"`, `"AUDIO"`); case-insensitive. */
  tagName?: string;
  /** The element's `src` attribute, if any. */
  src?: string;
  /** The element's resolved `currentSrc`, if any (preferred over `src`). */
  currentSrc?: string;
  /** True when the media is known to be DRM/EME/Widevine-protected. */
  isDRM?: boolean;
  /** Host the target belongs to (defaults to `pageMeta.host`). */
  host?: string;
  /** Coarse kind of the target. */
  kind?: "post" | "video" | "image";
  /** Whether the user asked for a single item or "all" (bulk). */
  scope?: "single" | "all";
}

/** Page-level context for the classification decision. */
export interface PageMeta {
  /** Host of the current page (e.g. `"www.youtube.com"`). */
  host?: string;
  /** Whether the current page session is logged in / authenticated. */
  loggedIn?: boolean;
}

// ---------------------------------------------------------------------------
// `isDirectlyDownloadable` (Req 13.1 — feasibility heuristic)
// ---------------------------------------------------------------------------

/**
 * Query-parameter keys that strongly indicate a signed or expiring URL. Such
 * URLs are time-limited credentials the extension cannot legitimately reuse or
 * re-sign, so they are never directly downloadable. Matched case-insensitively.
 */
const SIGNED_URL_PARAM_KEYS: readonly string[] = [
  "expires",
  "signature",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "x-goog-signature",
  "token",
  "sig",
  "hmac",
  "policy",
  "key-pair-id",
  "se", // Azure SAS expiry
];

/** Adaptive streaming manifest extensions that require muxing (no server). */
const MANIFEST_EXTENSIONS: readonly string[] = [".m3u8", ".mpd"];

/** Substrings in a URL that indicate DRM / encrypted-stream machinery. */
const DRM_URL_INDICATORS: readonly string[] = [
  "widevine",
  "playready",
  "fairplay",
  "clearkey",
  "/license",
  "licenseserver",
  "drm",
  ".mpd", // dash manifests are commonly DRM-wrapped; also covered below
];

/**
 * Maximum size, in characters, of a `data:` URL we treat as directly
 * downloadable. Larger data URLs balloon memory and are usually not what the
 * user means by "download this media", so they are rejected.
 */
export const MAX_DATA_URL_LENGTH = 2048;

/** True when `host` (or any suffix segment) appears in `set`. */
function lowerIncludesAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

/**
 * Decide whether `url` points at media the extension can fetch directly and
 * hand to `chrome.downloads` under the no-server/MV3 constraint.
 *
 * Returns `true` ONLY for plain, directly-fetchable `http`/`https` media URLs.
 * Returns `false` for every non-directly-downloadable case, specifically:
 *  - empty / non-string / unparseable URLs;
 *  - `blob:` URLs (not fetchable cross-origin / outside their creating context);
 *  - `data:` URLs longer than {@link MAX_DATA_URL_LENGTH};
 *  - DRM/Widevine indicators in the URL;
 *  - signed/expiring URLs (presence of any {@link SIGNED_URL_PARAM_KEYS});
 *  - adaptive manifest formats (`.m3u8`, `.mpd`) that require muxing;
 *  - any non-`http(s)`, non-small-`data:` scheme.
 *
 * Pure and total: never throws (parse failures are reported as not-downloadable).
 */
export function isDirectlyDownloadable(url: string): boolean {
  if (typeof url !== "string") {
    return false;
  }
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return false;
  }

  // Small inline data: URLs are directly usable; large ones are rejected.
  if (/^data:/i.test(trimmed)) {
    return trimmed.length <= MAX_DATA_URL_LENGTH;
  }

  // blob: URLs are bound to their creating document/context and are not
  // reliably fetchable here — never directly downloadable.
  if (/^blob:/i.test(trimmed)) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  // Only web schemes can be fetched and downloaded.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  // DRM indicators anywhere in the URL → not downloadable.
  if (lowerIncludesAny(parsed.href, DRM_URL_INDICATORS)) {
    return false;
  }

  // Adaptive manifest extensions require muxing — not downloadable.
  const path = parsed.pathname.toLowerCase();
  if (MANIFEST_EXTENSIONS.some((ext) => path.endsWith(ext))) {
    return false;
  }

  // Signed/expiring URL heuristic: any known signature/expiry/token param.
  const signedKeys = new Set(SIGNED_URL_PARAM_KEYS);
  for (const key of parsed.searchParams.keys()) {
    if (signedKeys.has(key.toLowerCase())) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// `classifyMediaTarget` (Req 13.1, 13.3, 13.4, 13.5, 22.4 — Property 15)
// ---------------------------------------------------------------------------

/**
 * Hosts whose media is login-gated / ToS-restricted for downloading. Matched
 * against the target/page host as a suffix-aware substring (so `instagram.com`
 * matches `www.instagram.com`). These are the platforms the requirements call
 * out (IG/FB/X) plus the canonical YouTube hosts.
 */
const SOCIAL_HOSTS: readonly string[] = [
  "instagram.com",
  "facebook.com",
  "fb.watch",
  "fbcdn.net",
  "twitter.com",
  "x.com",
  "t.co",
  "tiktok.com",
];

/** Canonical YouTube hosts (adaptive streams / transcoding → infeasible). */
const YOUTUBE_HOSTS: readonly string[] = [
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "googlevideo.com",
];

/** True when `host` equals or is a subdomain of any entry in `hosts`. */
function hostMatches(host: string | undefined, hosts: readonly string[]): boolean {
  if (!host) {
    return false;
  }
  const lower = host.toLowerCase();
  return hosts.some((h) => lower === h || lower.endsWith(`.${h}`) || lower.includes(h));
}

/**
 * Classify a media download target as client-side feasible or not, with a
 * reason (Req 13.1, 13.3, 13.4, 13.5, 22.4; Property 15).
 *
 * The decision is PURE and deterministic. Infeasible cases are checked FIRST,
 * in priority order, so a target that trips several protections reports the
 * most fundamental one:
 *
 *  1. **DRM-protected** (`isDRM`) → infeasible (`DRM_PROTECTED`).
 *  2. **Bulk scrape** (`scope === "all"`, i.e. "all posts"/"all videos") →
 *     infeasible (`BULK_SCRAPE`) — a platform-ToS violation.
 *  3. **YouTube** target → infeasible (`TRANSCODE_REQUIRED`): adaptive
 *     DASH/HLS muxing and MP3 transcoding need a server/ffmpeg, forbidden by
 *     MV3's no-remote-code rule.
 *  4. **Login-gated social media** (host is IG/FB/X/etc. and the session is
 *     logged in, or the host is social generally) → infeasible (`LOGIN_GATED`).
 *  5. **Missing/blob/data-too-large/manifest/non-web source** →
 *     infeasible (`ADAPTIVE_STREAM` for manifests, else
 *     `NOT_DIRECTLY_DOWNLOADABLE`).
 *  6. **Signed/expiring URL** → infeasible (`SIGNED_OR_EXPIRING`).
 *
 * ONLY a directly-downloadable, non-DRM, non-signed, non-login-gated,
 * single-item media URL is classified as feasible.
 *
 * @param target Descriptor of the media element/target.
 * @param pageMeta Optional page-level context (host, login state).
 * @returns A {@link MediaFeasibility} decision.
 */
export function classifyMediaTarget(
  target: MediaTarget,
  pageMeta?: PageMeta,
): MediaFeasibility {
  const host = target.host ?? pageMeta?.host;
  const url = (target.currentSrc ?? target.src ?? "").trim();

  // 1. DRM is the hardest stop — never feasible.
  if (target.isDRM === true) {
    return {
      feasible: false,
      code: MediaInfeasibilityCode.DRM_PROTECTED,
      reason:
        "This media is DRM-protected and cannot be downloaded client-side.",
    };
  }

  // 2. Bulk scrape ("all posts"/"all videos") — never feasible (ToS).
  if (target.scope === "all") {
    return {
      feasible: false,
      code: MediaInfeasibilityCode.BULK_SCRAPE,
      reason:
        'Bulk "all posts/all videos" downloads are not supported and may violate the platform\'s Terms of Service.',
    };
  }

  // 3. YouTube — adaptive streams / MP3 transcoding need a server/ffmpeg.
  if (hostMatches(host, YOUTUBE_HOSTS)) {
    return {
      feasible: false,
      code: MediaInfeasibilityCode.TRANSCODE_REQUIRED,
      reason:
        "YouTube downloads require muxing/transcoding (a server), which is not available client-side.",
    };
  }

  // 4. Login-gated social media — never feasible.
  if (hostMatches(host, SOCIAL_HOSTS)) {
    return {
      feasible: false,
      code: MediaInfeasibilityCode.LOGIN_GATED,
      reason:
        "Login-gated social media downloads are not supported client-side and may violate the platform's Terms of Service.",
    };
  }

  // 5/6. The source must be directly downloadable. Distinguish manifests and
  // signed/expiring URLs for a precise reason code.
  if (url.length === 0) {
    return {
      feasible: false,
      code: MediaInfeasibilityCode.NOT_DIRECTLY_DOWNLOADABLE,
      reason: "No directly downloadable media source was found for this target.",
    };
  }

  const lowerUrl = url.toLowerCase();
  if (MANIFEST_EXTENSIONS.some((ext) => stripQuery(lowerUrl).endsWith(ext))) {
    return {
      feasible: false,
      code: MediaInfeasibilityCode.ADAPTIVE_STREAM,
      reason:
        "This is an adaptive streaming manifest that requires muxing, which is not available client-side.",
    };
  }

  if (!isDirectlyDownloadable(url)) {
    // Differentiate a signed/expiring URL (a real http(s) URL with sig/expiry
    // params) from other not-downloadable cases for a clearer notification.
    if (isSignedOrExpiring(url)) {
      return {
        feasible: false,
        code: MediaInfeasibilityCode.SIGNED_OR_EXPIRING,
        reason:
          "This media URL is signed or time-limited and cannot be reliably downloaded.",
      };
    }
    return {
      feasible: false,
      code: MediaInfeasibilityCode.NOT_DIRECTLY_DOWNLOADABLE,
      reason: "This media source cannot be downloaded directly client-side.",
    };
  }

  // Feasible: a directly-downloadable, non-DRM, non-signed, single item.
  return {
    feasible: true,
    url,
    reason: "Directly downloadable media; the file will be saved as-is.",
  };
}

/** Strip a query string / fragment so extension checks see only the path. */
function stripQuery(url: string): string {
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  let end = url.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  return url.slice(0, end);
}

/**
 * True when `url` parses as http(s) and carries a known signature/expiry/token
 * query parameter. Used to choose a precise infeasibility reason; the actual
 * feasibility gate is {@link isDirectlyDownloadable}.
 */
function isSignedOrExpiring(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const signedKeys = new Set(SIGNED_URL_PARAM_KEYS);
  for (const key of parsed.searchParams.keys()) {
    if (signedKeys.has(key.toLowerCase())) {
      return true;
    }
  }
  return false;
}
