/**
 * An exhausted Muse Code subscription window must not park the client until it resets.
 *
 * Meta answers with 429 and `retry-after` set to the seconds left in the five-hour
 * window, often half an hour or more. Codex App honours that header, so it schedules
 * its next sampling attempt at the reset instant — `stream disconnected - retrying
 * sampling request (1/5 in 2248s)` — and the turn looks hung even though the proxy
 * answered at once.
 *
 * The refusal itself is worth keeping: its message names the reset instant and the
 * body carries `resets_at`. Only the long delay is dropped, so the client follows its
 * own short backoff, shows the message, and can retry successfully if the window
 * frees up earlier than Meta predicted.
 */

/** Window resets are far longer than any transient throttle worth waiting out inline. */
export const LONG_RETRY_AFTER_SECONDS = 60;

/** Wording Meta uses for a subscription window that is fully consumed. */
export const MUSE_QUOTA_EXHAUSTED_MESSAGE = "Subscription quota exhausted";

/** Marker for operators reading the wire; the client ignores it. */
export const MUSE_QUOTA_WINDOW_EXHAUSTED_HEADER = "x-opencodex-quota-window-exhausted";

/**
 * Drop a window-length `retry-after` from a Muse quota refusal, leaving the 429 and
 * its message untouched. Returns the input response for every other shape.
 */
export async function rewriteMuseQuotaExhaustedResponse(response: Response): Promise<Response> {
  if (response.status !== 429) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return response;
  const retryAfter = Number(response.headers.get("retry-after"));
  if (!Number.isFinite(retryAfter) || retryAfter <= LONG_RETRY_AFTER_SECONDS) return response;

  let text: string;
  try {
    // A refusal this small is a single JSON document, never a replayable stream.
    text = await response.text();
  } catch {
    return response;
  }
  const headers = new Headers(response.headers);
  if (text.includes(MUSE_QUOTA_EXHAUSTED_MESSAGE)) {
    headers.delete("retry-after");
    headers.set(MUSE_QUOTA_WINDOW_EXHAUSTED_HEADER, "1");
  }
  return new Response(text, { status: response.status, statusText: response.statusText, headers });
}
