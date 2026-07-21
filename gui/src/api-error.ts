/** Prefer a structured local-management API error while keeping a translated fallback. */
export async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { error?: unknown };
    if (typeof data.error === "string" && data.error.trim()) return data.error.trim();
  } catch {
    // The fallback is the stable UI contract for empty/non-JSON failures.
  }
  return fallback;
}
