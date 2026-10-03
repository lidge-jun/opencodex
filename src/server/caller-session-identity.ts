/**
 * Third-party clients of the public endpoints usually speak the OpenAI/Anthropic wire formats
 * without any Codex session identity. The ChatGPT Codex backend only reuses a warmed prompt
 * prefix for requests that carry `session_id` (#6481), and opencodex reads the same header for
 * thread affinity and request-log conversation identity — so such callers pay full price on
 * every turn even with byte-identical prefixes (#6520: a 25-turn agent task with stable
 * prefixes reported cache_write_tokens: 0 throughout, while Codex clients on the same account
 * and model reused 97%+ of their input).
 *
 * Many non-Codex agents already send a stable `x-session-id` per conversation (ZCode does; the
 * proxy's own adapters treat the same header as a session marker). Promote it to `session_id`
 * exactly the way the managed Grok surface promotes `x-grok-conv-id` (#6482): an explicit caller
 * session header always wins, and values that do not look like an opaque id are left alone.
 */
const SESSION_HEADERS = ["session_id", "session-id", "thread-id"] as const;
const CALLER_SESSION_HEADER = "x-session-id";
// Codex accepts UUIDs and similar opaque ids; anything else is not promoted.
const SAFE_CALLER_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function callerSessionId(headers: Headers): string | undefined {
  if (SESSION_HEADERS.some(name => headers.has(name))) return undefined;
  const value = headers.get(CALLER_SESSION_HEADER)?.trim();
  if (!value || !SAFE_CALLER_SESSION_ID.test(value)) return undefined;
  return value;
}

/** Returns `req` unchanged unless the caller's `x-session-id` can stand in for the missing `session_id`. */
export function withCallerSessionIdentity(req: Request): Request {
  const sessionId = callerSessionId(req.headers);
  if (!sessionId) return req;
  const headers = new Headers(req.headers);
  headers.set("session_id", sessionId);
  // The clone keeps the unread body stream and the caller's abort signal.
  return new Request(req, { headers });
}
