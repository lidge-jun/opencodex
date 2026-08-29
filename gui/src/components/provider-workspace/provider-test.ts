import { readJsonOrThrow } from "../../fetch-json";

export type ConnectionTestResult = {
  ok?: boolean;
  latencyMs?: number;
  error?: string;
  message?: string;
  applicable?: boolean;
  reason?: string;
};

/**
 * Probe a single provider through `POST /api/providers/test?name=...`.
 * On abort or network failure returns `{ ok: false, error }` — never throws.
 */
export async function testProviderConnection(
  apiBase: string,
  name: string,
  signal?: AbortSignal,
): Promise<ConnectionTestResult> {
  if (signal?.aborted) return { ok: false, error: "Aborted" };
  try {
    const response = await fetch(
      `${apiBase}/api/providers/test?${new URLSearchParams({ name })}`,
      { method: "POST", signal },
    );
    if (signal?.aborted) return { ok: false, error: "Aborted" };
    const result = await readJsonOrThrow<ConnectionTestResult>(response);
    return result ?? { ok: false, error: "Empty response" };
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: "Aborted" };
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Connection test failed",
    };
  }
}
