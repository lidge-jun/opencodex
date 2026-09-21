import { withNativeMainSharedClaim } from "../native-main-claim";
import { resolveNativeProfileContext } from "../native-profile-store";
import { NativeProfileError } from "../native-profile-types";

export function isNativeMainClaimUnavailable(error: unknown): error is NativeProfileError {
  return error instanceof NativeProfileError
    && (error.code === "NATIVE_MAIN_CLAIM_BUSY" || error.code === "NATIVE_MAIN_CLAIM_UNAVAILABLE");
}

export function withNativeMainCredentialClaim<T>(operation: () => Promise<T>): Promise<T> {
  return withNativeMainSharedClaim(resolveNativeProfileContext(), operation);
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function nativeMainProfileBusyResponse(): Response {
  const response = jsonResponse({ error: "server_busy", code: "server_busy" }, 503);
  response.headers.set("Retry-After", "1");
  return response;
}

export function manualImportDisabledResponse(): Response {
  return jsonResponse({
    error: "Manual Codex account import is disabled. Use OAuth login to add a pool account.",
    code: "manual_import_disabled",
  }, 403);
}
