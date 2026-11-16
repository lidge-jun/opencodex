/**
 * Prefer a structured local-management API error while keeping a translated fallback.
 *
 * A 409 `target_changed` is a dashboard condition, not server prose: when the caller
 * supplies the localized message, show that instead of the raw wire token.
 */
export async function apiErrorMessage(
  response: Response,
  fallback: string,
  targetChangedMessage?: string,
): Promise<string> {
  try {
    const data = await response.json() as { error?: unknown };
    return errorMessageFrom(data, fallback, targetChangedMessage);
  } catch {
    // The fallback is the stable UI contract for empty/non-JSON failures.
  }
  return fallback;
}

/** A parsed local-management error body that means "the dashboard target moved". */
export function isTargetChangedError(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { error?: unknown }).error === "target_changed";
}

/**
 * The message for an already-parsed error body.
 *
 * A 409 target_changed is a dashboard condition, not server prose: the caller's localized
 * copy replaces the wire token. Every other string error is the server's own message and
 * passes through, so a caller that has already read the body does not have to re-implement
 * the mapping.
 */
export function errorMessageFrom(data: unknown, fallback: string, targetChangedMessage?: string): string {
  if (isTargetChangedError(data)) return targetChangedMessage ?? fallback;
  const error = typeof data === "object" && data !== null ? (data as { error?: unknown }).error : undefined;
  return typeof error === "string" && error.trim() ? error.trim() : fallback;
}
