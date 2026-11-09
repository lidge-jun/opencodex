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
    if (data.error === "target_changed" && targetChangedMessage) return targetChangedMessage;
    if (typeof data.error === "string" && data.error.trim()) return data.error.trim();
  } catch {
    // The fallback is the stable UI contract for empty/non-JSON failures.
  }
  return fallback;
}
