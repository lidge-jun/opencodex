/**
 * Claude Code's message-threads beta, which it only enables against first-party Anthropic, sends
 * a `thread` object on subagent turns. A `continue` carries just the messages after
 * `previous_message_id` and may omit `system` and `tools`, because Anthropic replays them from the
 * stored thread. A translated route has no such store, so translating that delta silently drops the
 * task, the instructions and the earlier turns.
 *
 * Claude Code reads this error code as "threads are unsupported for this model": it resends the
 * same turn with the full conversation and keeps that model stateless for the rest of the session.
 */
export const MESSAGE_THREAD_UNSUPPORTED_ERROR_CODE = "thread_unsupported_request";

export function carriesMessageThread(body: unknown): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const thread = (body as Record<string, unknown>).thread;
  return thread !== null && typeof thread === "object" && !Array.isArray(thread);
}

export function messageThreadUnsupportedResponse(): Response {
  return new Response(JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "message threads are not supported on translated routes",
      details: { error_code: MESSAGE_THREAD_UNSUPPORTED_ERROR_CODE },
    },
  }), { status: 400, headers: { "Content-Type": "application/json" } });
}
