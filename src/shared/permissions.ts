// Point-of-use host/device permission requests with graceful denial
// (Req 21.2, 21.3), task 26.1.
//
// ## Why this module exists
// The finalized manifest (task 26.3) declares the minimal permission set the
// implemented features actually use (`storage`, `tabs`, `downloads`, and the
// `<all_urls>` host permission). Those are granted at install time, so the
// twelve tools do not need to ask for anything extra at runtime.
//
// There is exactly ONE true point-of-use grant in the product: the microphone
// used by Voice to Text (Tool 11, Req 16). That grant is NOT a `chrome.*`
// manifest permission — it is a browser-managed device permission prompted
// implicitly when the Web Speech API / `getUserMedia` starts, and its denial is
// already handled gracefully inside `src/tools/voice/voiceTool.ts`
// (`MIC_DENIED` notification, no capture, other features keep working).
//
// This module provides the generic primitive the requirement describes
// (Req 21.2): request a permission at the moment a feature is invoked, and on
// denial (Req 21.3) notify the user which feature is unavailable while leaving
// every other feature usable. It is intentionally small — a single
// `ensurePermission` helper plus a thin `ensureFeaturePermission` wrapper that
// folds in the graceful-denial notification — so that any future feature
// needing an *optional* (manifest `optional_permissions`) host or API
// permission can adopt it without re-implementing the request/deny dance.
//
// Design reference: "Permissions & Privacy (Req 21 — reinterpreted
// client-side)" — declare minimal permissions; request host/device permissions
// at point of use; on denial notify and keep other features usable.

import { notify } from "../ui/notify";
import { ErrorCode } from "./messaging";

/**
 * A permission request descriptor mirroring `chrome.permissions.Permissions`.
 * At least one of `permissions` (API permissions) or `origins` (host
 * permissions) should be provided.
 */
export interface PermissionRequest {
  /** Optional API permissions to request (e.g. `["downloads"]`). */
  permissions?: string[];
  /** Optional host permission match patterns to request (e.g. all-https origins). */
  origins?: string[];
}

/**
 * Resolve the `chrome.permissions` API if present. Returns `undefined` in
 * contexts/builds where it is unavailable (e.g. some test environments), so
 * callers can degrade rather than throw.
 */
function getPermissionsApi(): typeof chrome.permissions | undefined {
  const api = (chrome as { permissions?: typeof chrome.permissions })
    .permissions;
  if (
    !api ||
    typeof api.contains !== "function" ||
    typeof api.request !== "function"
  ) {
    return undefined;
  }
  return api;
}

/**
 * Ensure an optional host/API permission is granted, requesting it at the point
 * of use when it is not already held (Req 21.2).
 *
 * Resolves `true` when the permission is already granted or the user grants it
 * in response to the request, and `false` when the user denies it or the
 * request cannot be made. This NEVER throws and NEVER notifies — callers decide
 * how to surface a denial (use {@link ensureFeaturePermission} for the standard
 * graceful-denial notification).
 *
 * When `chrome.permissions` is unavailable, this returns `true` for permissions
 * that are part of the static manifest grant: such permissions are present from
 * install and do not require a runtime request. The optimistic default keeps
 * the helper usable in contexts where the optional-permissions API is not
 * surfaced while still letting the underlying API call fail-and-notify on its
 * own if the permission is genuinely missing.
 */
export async function ensurePermission(
  request: PermissionRequest,
): Promise<boolean> {
  const api = getPermissionsApi();
  if (!api) {
    return true;
  }

  const query: chrome.permissions.Permissions = {};
  if (request.permissions && request.permissions.length > 0) {
    query.permissions = request.permissions;
  }
  if (request.origins && request.origins.length > 0) {
    query.origins = request.origins;
  }

  try {
    const alreadyGranted = await api.contains(query);
    if (alreadyGranted) {
      return true;
    }
  } catch {
    // `contains` can reject for malformed patterns; fall through to request.
  }

  try {
    const granted = await api.request(query);
    return granted === true;
  } catch {
    // A rejected request (e.g. not user-gesture-initiated, invalid pattern) is
    // treated as a denial so the caller degrades gracefully.
    return false;
  }
}

/**
 * Ensure a permission for a named feature, applying the standard graceful-denial
 * behavior (Req 21.3): on denial, show a Notification explaining which feature
 * is unavailable and return `false` so the caller can abort just that feature
 * while every other feature keeps working.
 *
 * @param featureName Human-readable feature name used in the denial message
 *   (e.g. `"Save image"`).
 * @param request The permission(s)/origin(s) the feature needs.
 * @returns `true` when granted (caller proceeds), `false` when denied (caller
 *   should stop this feature only).
 *
 * @example
 * if (!(await ensureFeaturePermission("Save image", { permissions: ["downloads"] }))) {
 *   return; // notification already shown; other tools remain usable
 * }
 */
export async function ensureFeaturePermission(
  featureName: string,
  request: PermissionRequest,
): Promise<boolean> {
  const granted = await ensurePermission(request);
  if (!granted) {
    notify({
      kind: "error",
      text: `${featureName} is unavailable without the required permission`,
      code: ErrorCode.PERMISSION_DENIED,
    });
  }
  return granted;
}
