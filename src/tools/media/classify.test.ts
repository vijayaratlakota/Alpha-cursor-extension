// Feature: alpha-cursor-extension, Property 15: Media classifier never marks protected media feasible
//
// Property-based tests (fast-check + Vitest) for the Media Downloader pure
// helpers backing Tool 8 (Req 13 — honestly scoped, best-effort).
//
// Validates Requirements 13.1, 13.3, 13.4, 13.5, 22.4.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  classifyMediaTarget,
  isDirectlyDownloadable,
  MAX_DATA_URL_LENGTH,
  type MediaTarget,
  type PageMeta,
} from "./classify";

// ---------------------------------------------------------------------------
// Host pools
// ---------------------------------------------------------------------------

// Login-gated social platforms (and YouTube) — must never be feasible.
const SOCIAL_OR_GATED_HOSTS = [
  "youtube.com",
  "www.youtube.com",
  "youtu.be",
  "googlevideo.com",
  "instagram.com",
  "www.instagram.com",
  "facebook.com",
  "www.facebook.com",
  "fb.watch",
  "x.com",
  "twitter.com",
  "www.twitter.com",
  "t.co",
  "tiktok.com",
] as const;

// Neutral hosts that are not login-gated.
const NEUTRAL_HOSTS = [
  "example.com",
  "cdn.example.com",
  "media.example.org",
  "files.test",
] as const;

const socialHostArb = fc.constantFrom(...SOCIAL_OR_GATED_HOSTS);
const neutralHostArb = fc.constantFrom(...NEUTRAL_HOSTS);
const anyHostArb = fc.oneof(socialHostArb, neutralHostArb);

// ---------------------------------------------------------------------------
// URL pools
// ---------------------------------------------------------------------------

// Plain, directly-downloadable https media.
const plainMediaArb = fc.constantFrom(
  "https://cdn.example.com/video.mp4",
  "https://media.example.org/clip.webm",
  "https://files.test/audio.mp3",
  "https://example.com/image.png",
  "http://cdn.example.com/movie.mov",
);

// Signed / expiring URLs (must never be directly downloadable / feasible).
const signedUrlArb = fc.constantFrom(
  "https://cdn.example.com/video.mp4?Expires=1700000000",
  "https://cdn.example.com/video.mp4?foo=1&Signature=abc123",
  "https://cdn.example.com/video.mp4?X-Amz-Signature=deadbeef",
  "https://cdn.example.com/video.mp4?token=secrettoken",
  "https://cdn.example.com/video.mp4?X-Amz-Credential=AKIA&X-Amz-Signature=z",
  "https://cdn.example.com/video.mp4?sig=xyz",
);

// blob: URLs — never directly downloadable.
const blobUrlArb = fc.constantFrom(
  "blob:https://example.com/550e8400-e29b-41d4-a716-446655440000",
  "blob:https://cdn.example.com/abcd-1234",
);

// Adaptive manifests — never directly downloadable.
const manifestUrlArb = fc.constantFrom(
  "https://cdn.example.com/stream.m3u8",
  "https://cdn.example.com/manifest.mpd",
  "https://cdn.example.com/stream.m3u8?Expires=1700000000",
);

// DRM indicators in the URL.
const drmUrlArb = fc.constantFrom(
  "https://cdn.example.com/widevine/license",
  "https://cdn.example.com/drm/video.mp4",
  "https://license.example.com/license?id=1",
);

// Non-http(s) schemes.
const nonHttpUrlArb = fc.constantFrom(
  "ftp://example.com/video.mp4",
  "file:///tmp/video.mp4",
  "magnet:?xt=urn:btih:abc",
);

// data: URLs — small (downloadable) and oversized (not downloadable).
const smallDataUrlArb = fc.constant("data:image/png;base64,iVBORw0KGgo=");
const largeDataUrlArb = fc.constant(
  `data:image/png;base64,${"A".repeat(MAX_DATA_URL_LENGTH + 100)}`,
);

const anyUrlArb = fc.oneof(
  plainMediaArb,
  signedUrlArb,
  blobUrlArb,
  manifestUrlArb,
  drmUrlArb,
  nonHttpUrlArb,
  smallDataUrlArb,
  largeDataUrlArb,
  fc.constant(""),
);

// ---------------------------------------------------------------------------
// Target / page generators
// ---------------------------------------------------------------------------

const targetArb: fc.Arbitrary<MediaTarget> = fc.record(
  {
    tagName: fc.constantFrom("VIDEO", "AUDIO", "IMG"),
    isDRM: fc.boolean(),
    scope: fc.constantFrom("single" as const, "all" as const),
    host: anyHostArb,
    // Use either src or currentSrc (currentSrc preferred by the impl).
    src: anyUrlArb,
    currentSrc: anyUrlArb,
    kind: fc.constantFrom("post" as const, "video" as const, "image" as const),
  },
  // Optional keys are sometimes omitted entirely (never present-as-undefined,
  // to satisfy exactOptionalPropertyTypes).
  { requiredKeys: ["tagName", "isDRM", "scope", "kind"] },
);

const pageMetaArb: fc.Arbitrary<PageMeta> = fc.record(
  {
    host: anyHostArb,
    loggedIn: fc.boolean(),
  },
  { requiredKeys: ["loggedIn"] },
);

const SOCIAL_NEEDLES = [
  "instagram.com",
  "facebook.com",
  "fb.watch",
  "fbcdn.net",
  "twitter.com",
  "x.com",
  "t.co",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "googlevideo.com",
];

function hostIsGated(host: string | undefined): boolean {
  if (!host) return false;
  const lower = host.toLowerCase();
  return SOCIAL_NEEDLES.some((n) => lower.includes(n));
}

// ---------------------------------------------------------------------------
// Property 15
// ---------------------------------------------------------------------------

describe("classifyMediaTarget (Property 15 — never marks protected media feasible)", () => {
  // Validates: Requirements 13.1, 13.3, 13.4, 13.5, 22.4
  it("never returns feasible:true for DRM, bulk scope, gated hosts, or signed URLs", () => {
    fc.assert(
      fc.property(targetArb, pageMetaArb, (target, pageMeta) => {
        const result = classifyMediaTarget(target, pageMeta);
        const effectiveHost = target.host ?? pageMeta.host;
        const url = (target.currentSrc ?? target.src ?? "").trim();

        if (result.feasible) {
          // None of the protected conditions may hold for a feasible result.
          expect(target.isDRM).not.toBe(true);
          expect(target.scope).not.toBe("all");
          expect(hostIsGated(effectiveHost)).toBe(false);
          // A feasible result must carry a directly-downloadable url.
          expect(result.url).toBe(url);
          expect(isDirectlyDownloadable(result.url)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 13.1
  it("is never feasible whenever DRM is set, regardless of everything else", () => {
    fc.assert(
      fc.property(
        targetArb.map((t) => ({ ...t, isDRM: true })),
        pageMetaArb,
        (target, pageMeta) => {
          expect(classifyMediaTarget(target, pageMeta).feasible).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 13.4
  it("is never feasible for bulk ('all') scope", () => {
    fc.assert(
      fc.property(
        targetArb.map((t) => ({ ...t, isDRM: false, scope: "all" as const })),
        pageMetaArb,
        (target, pageMeta) => {
          expect(classifyMediaTarget(target, pageMeta).feasible).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 13.3, 13.5
  it("is never feasible for login-gated social / YouTube hosts", () => {
    fc.assert(
      fc.property(
        fc.record({
          tagName: fc.constant("VIDEO"),
          isDRM: fc.constant(false),
          scope: fc.constant("single" as const),
          host: socialHostArb,
          src: plainMediaArb,
        }),
        (target) => {
          expect(classifyMediaTarget(target as MediaTarget).feasible).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 13.1, 22.4
  it("is never feasible for signed/expiring source URLs", () => {
    fc.assert(
      fc.property(signedUrlArb, neutralHostArb, (url, host) => {
        const result = classifyMediaTarget({
          tagName: "VIDEO",
          isDRM: false,
          scope: "single",
          host,
          currentSrc: url,
        });
        expect(result.feasible).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe("isDirectlyDownloadable (Property 15 support)", () => {
  // Validates: Requirements 13.1
  it("rejects blob:, signed/expiring, manifests, DRM, non-http(s), and oversized data: URLs", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          blobUrlArb,
          signedUrlArb,
          manifestUrlArb,
          drmUrlArb,
          nonHttpUrlArb,
          largeDataUrlArb,
          fc.constant(""),
        ),
        (url) => {
          expect(isDirectlyDownloadable(url)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 13.1
  it("accepts plain http(s) media and small data: URLs", () => {
    fc.assert(
      fc.property(fc.oneof(plainMediaArb, smallDataUrlArb), (url) => {
        expect(isDirectlyDownloadable(url)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
