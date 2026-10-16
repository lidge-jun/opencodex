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

const CODEX_THREAD_LINK_PREFIX = "codex://threads/";
const LOG_CONVERSATION_LINK_MAX = 512;

/**
 * Unwrap a pasted `codex://threads/<id>` deep link to the bare thread id; query/fragment
 * metadata (e.g. `?hostId=…`) is dropped. Bounded linear scan — no ambiguous regex.
 * Mirrors src/server/request-log-conversation.unwrapLogConversationQuery.
 */
export function unwrapLogConversationQuery(query: string): string {
  const trimmed = query.trim();
  if (
    trimmed.length > LOG_CONVERSATION_LINK_MAX ||
    trimmed.length <= CODEX_THREAD_LINK_PREFIX.length ||
    !trimmed.toLowerCase().startsWith(CODEX_THREAD_LINK_PREFIX)
  ) {
    return trimmed;
  }
  const rest = trimmed.slice(CODEX_THREAD_LINK_PREFIX.length);
  const metaIndex = rest.search(/[?#]/);
  const segment = (metaIndex === -1 ? rest : rest.slice(0, metaIndex)).replace(/\/+$/, "");
  return segment !== "" && !/[/\s]/.test(segment) ? segment : trimmed;
}

/**
 * The candidate ids a conversation query may legitimately match: the unwrapped link id
 * and the untouched paste — a client may literally send a `codex://threads/…` session
 * id, hashed whole for storage. Mirrors the server matcher's candidate set.
 */
function logConversationQueryCandidates(query: string): string[] {
  const trimmed = query.trim();
  const unwrapped = unwrapLogConversationQuery(trimmed);
  return unwrapped === trimmed ? [unwrapped] : [unwrapped, trimmed];
}

/** SHA-256 hex prefixes used as persisted conversation ids, one per query candidate. */
export async function hashLogConversationQuery(raw: string): Promise<string[]> {
  const candidates = logConversationQueryCandidates(raw).filter(
    candidate => candidate !== "" && !hasControlChars(candidate) && candidate.length <= 4096,
  );
  const digests = await Promise.all(
    candidates.map(candidate =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(candidate)),
    ),
  );
  return digests.map(digest => toHex(digest).slice(0, LOG_CONVERSATION_ID_LEN));
}

export function matchesLogConversationId(
  stored: string | undefined,
  query: string,
  queryHash?: readonly string[],
): boolean {
  if (!stored) return false;
  const candidates = logConversationQueryCandidates(query);
  if (!candidates.some(Boolean)) return false;
  if (candidates.includes(stored)) return true;
  return queryHash !== undefined && queryHash.includes(stored);
}
