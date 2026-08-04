/**
 * Helpers that check Response status before consuming the body.
 * Satisfies react-doctor `no-fetch-response-used-without-status-check`
 * (`fetch` resolves on HTTP 4xx/5xx).
 */

/** Parse an OK response body; 204 / empty bodies yield `undefined`. */
async function readJsonBody<T>(res: Response): Promise<T | undefined> {
  if (res.status === 204) return undefined;
  // Prefer text() so empty OK bodies are detectable. Fall back to json() for
  // Response-like test doubles that only implement json().
  if (typeof res.text === "function") {
    const text = await res.text();
    if (!text.trim()) return undefined;
    return JSON.parse(text) as T;
  }
  return await res.json() as T;
}

function errorMessageFromBody(errBody: { error?: unknown; message?: unknown }, fallback: string): string {
  if (typeof errBody.error === "string" && errBody.error) return errBody.error;
  // Some management routes (e.g. Grok apply orphan repair) put the actionable
  // copy in `message` rather than `error`.
  if (typeof errBody.message === "string" && errBody.message) return errBody.message;
  return fallback;
}

export async function readJsonOrThrow<T>(
  res: Response,
  fallbackMessage = `HTTP ${res.status}`,
): Promise<T | undefined> {
  if (!res.ok) {
    let message = fallbackMessage;
    try {
      const errBody = await res.json() as { error?: unknown; message?: unknown };
      message = errorMessageFromBody(errBody, fallbackMessage);
    } catch {
      // non-JSON error bodies keep the fallback message
    }
    throw new Error(message);
  }
  return readJsonBody<T>(res);
}

export async function readJsonIfOk<T>(res: Response): Promise<T | null | undefined> {
  if (!res.ok) return null;
  try {
    return await readJsonBody<T>(res);
  } catch {
    // Malformed / non-JSON OK bodies must not throw — callers treat null as "no usable payload".
    return null;
  }
}
