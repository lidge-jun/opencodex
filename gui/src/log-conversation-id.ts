/**
 * Client-side conversation filter matching for Logs (#330).
 * Mirrors src/server/request-log-conversation.matchesLogConversationId without Node crypto.
 */

const LOG_CONVERSATION_ID_LEN = 32;

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Unwrap a pasted `codex://threads/<id>` deep link to the bare thread id.
 * Mirrors src/server/request-log-conversation.unwrapLogConversationQuery.
 */
export function unwrapLogConversationQuery(query: string): string {
  const unwrapped = /^codex:\/\/threads\/(.*?)\/*$/i.exec(query.trim())?.[1]?.trim();
  return unwrapped || query.trim();
}

/** SHA-256 hex prefix used as the persisted conversation id. */
export async function hashLogConversationQuery(raw: string): Promise<string | undefined> {
  const trimmed = unwrapLogConversationQuery(raw);
  if (!trimmed) return undefined;
  if (hasControlChars(trimmed)) return undefined;
  if (trimmed.length > 4096) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(trimmed));
  return toHex(digest).slice(0, LOG_CONVERSATION_ID_LEN);
}

export function matchesLogConversationId(
  stored: string | undefined,
  query: string,
  queryHash?: string,
): boolean {
  if (!stored) return false;
  const trimmed = unwrapLogConversationQuery(query);
  if (!trimmed) return false;
  if (stored === trimmed) return true;
  return queryHash !== undefined && stored === queryHash;
}
