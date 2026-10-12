/**
 * Grok Build sends its conversation identity as `x-grok-conv-id` (and the same value as the body
 * `prompt_cache_key`), but never the `session_id` header Codex clients send. The ChatGPT Codex
 * backend only reuses a warmed prompt prefix for requests that carry `session_id`, and opencodex
 * reads the same header for thread affinity and conversation logging. Without it, every Grok turn
 * routed to an OpenAI model was a cold `new_bind` with near-zero cached input.
 *
 * Only the managed Grok surface (`x-opencodex-grok: 1`, written by `ocx` into Grok's config) is
 * promoted, and an explicit caller session header always wins.
 */
const GROK_SURFACE_HEADER = "x-opencodex-grok";
const GROK_CONVERSATION_HEADER = "x-grok-conv-id";
const SESSION_HEADERS = ["session_id", "session-id", "thread-id"] as const;
// Grok emits UUIDs and `turn-summary-<uuid>`; anything else is not promoted.
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function grokConversationSessionId(headers: Headers): string | undefined {
  if (headers.get(GROK_SURFACE_HEADER) !== "1") return undefined;
  if (SESSION_HEADERS.some(name => headers.has(name))) return undefined;
  const conversationId = headers.get(GROK_CONVERSATION_HEADER)?.trim();
  if (!conversationId || !SAFE_CONVERSATION_ID.test(conversationId)) return undefined;
  return conversationId;
}

/** Returns `req` unchanged unless a Grok conversation id can stand in for the missing `session_id`. */
export function withGrokSessionIdentity(req: Request): Request {
  const sessionId = grokConversationSessionId(req.headers);
  if (!sessionId) return req;
  const headers = new Headers(req.headers);
  headers.set("session_id", sessionId);
  // The clone keeps the unread body stream and the caller's abort signal.
  return new Request(req, { headers });
}
