/**
 * Shared provider connection probe — used by both the single-provider
 * Overview panel and the batch "Test All" action in the Providers page.
 *
 * Centralises: URL construction, POST method, HTTP status check, JSON
 * parsing (via readJsonOrThrow), AbortSignal, and safe error mapping.
 */
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
 * Probe a single provider through the management API.
 *
 * @param apiBase  proxy base URL (e.g. `http://localhost:10100`)
 * @param name     provider name key (e.g. `"openai"`)
 * @param signal   optional AbortSignal — cancelled requests resolve to an
 *                 `{ ok: false, error: "Aborted" }` result instead of throwing.
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
