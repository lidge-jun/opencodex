import type { OcxParsedRequest } from "../../types";
import type { IncomingMeta } from "../base";

/**
 * Conversation identity and turn ordering.
 *
 * Both live together because they answer one question: which turn may run, and on whose state. A
 * conversation is neither a model id nor a request — it is the thing that owns a StepCode process.
 */

/**
 * Identify the conversation this request belongs to.
 *
 * StepCode keeps a conversation only inside one process, so every request of a Codex thread has to
 * land on the same session. The thread identity is what Codex already sends on EVERY request —
 * `thread-id`, then the session-affinity headers — which is the resolution `devin`, `zed`, `cursor`
 * and `google` use, and it works on the first request of a conversation. `previous_response_id` and
 * the proxy's continuation store are only fallbacks: depending on persisted provider state would mean
 * a conversation silently restarting whenever that store misses an entry.
 */
export function conversationHandle(parsed: OcxParsedRequest, incoming: IncomingMeta): string | undefined {
  const own = incoming.headers.get("thread-id")?.trim() || parsed._codexOwnThreadId?.trim();
  if (own) return `own:${own}`;
  const affinity =
    incoming.headers.get("session_id")?.trim() ||
    incoming.headers.get("session-id")?.trim() ||
    incoming.headers.get("x-session-affinity")?.trim();
  if (affinity) return `session:${affinity}`;
  // A parent thread id belongs to the SUB-agent it spawned, so it must not be read as this turn's own
  // conversation; it is only consulted when no parent is present.
  if (!incoming.headers.has("x-codex-parent-thread-id")) {
    const client = parsed._clientThreadId?.trim();
    if (client) return `client:${client}`;
  }
  if (parsed.previousResponseId) return `response:${parsed.previousResponseId}`;
  // Deliberately undefined rather than a shared "default": Claude Code, Grok Build and generic Chat
  // clients all send requests with no identity, and collapsing them onto one handle would let one
  // client read another's context and deliver its tool result into another's query. The caller mints
  // a private ref instead, so an identity-less request gets its own process and forgets it.
  return undefined;
}

/** How many turns may queue behind one conversation before a caller is told to retry. */
export const MAX_QUEUED_TURNS = 2;

/**
 * Hard ceiling on waiting for a terminal event from the CLI.
 *
 * The turn would otherwise wait for the client's abort, and a client that never aborts (or a CLI that
 * went quiet) would hold the conversation lock for the life of the process. Set well above
 * StepCode's own 120s tool window so a legitimate slow tool is never cut short.
 */

interface ConversationLock {
  /** Settles when every queued turn ahead of this one has finished. */
  readonly chain: Promise<void>;
  /** Turns waiting or running; used to refuse an unbounded pile-up. */
  waiters: number;
}

/**
 * Per-conversation serialisation.
 *
 * StepCode serves ONE query per process, and this proxy's turn state is keyed by that process, so two
 * overlapping turns on one conversation overwrite each other's runtime, interrupt each other's query
 * and close each other's session — which is exactly what two clients sharing a `thread-id` produce,
 * and it was measured as both requests failing with `SESSION_NOT_FOUND` and `step_cli_session_closed`.
 * Turns are therefore queued in arrival order.
 *
 * Sequential traffic is unaffected: a turn that finishes before the next arrives takes an empty chain
 * and completes without yielding.
 */

/**
 * Per-conversation serialisation.
 *
 * StepCode serves ONE query per process, and this proxy's turn state is keyed by that process, so two
 * overlapping turns on one conversation overwrite each other's runtime, interrupt each other's query
 * and close each other's session — which is exactly what two clients sharing a `thread-id` produce,
 * and it was measured as both requests failing with `SESSION_NOT_FOUND` and `step_cli_session_closed`.
 * Turns are therefore queued in arrival order.
 *
 * Sequential traffic is unaffected: a turn that finishes before the next arrives takes an empty chain
 * and completes without yielding.
 */
const conversationLocks = new Map<string, ConversationLock>();

/**
 * Exported for its regression test: the queue cap is the only path in this adapter that refuses
 * rather than degrades, and it has to be observable to be trusted.
 */

/**
 * Exported for its regression test: the queue cap is the only path in this adapter that refuses
 * rather than degrades, and it has to be observable to be trusted.
 */
export async function withConversationLock<T>(handle: string, task: () => Promise<T>): Promise<T> {
  const existing = conversationLocks.get(handle);
  if (existing && existing.waiters >= MAX_QUEUED_TURNS + 1) {
    throw new Error(
      `StepCode serves one turn per conversation at a time and ${existing.waiters} are already queued for this one.`,
    );
  }
  const previous = existing?.chain ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const chain = previous.then(
    () => gate,
    () => gate,
  );
  const entry: ConversationLock = { chain, waiters: (existing?.waiters ?? 0) + 1 };
  conversationLocks.set(handle, entry);
  void chain.finally(() => {
    // Drop the entry once this turn's chain drains, unless a later turn already replaced it — otherwise
    // the map would retain one settled promise per conversation handle for the life of the process.
    if (conversationLocks.get(handle) === entry) conversationLocks.delete(handle);
  });
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    entry.waiters -= 1;
    release();
  }
}

/** One pool per OpenCodex home, so two homes in one process never share a StepCode session. */
