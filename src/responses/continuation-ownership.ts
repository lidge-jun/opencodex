import { effectiveAdapterContract, getAdapterDefinition, type AdapterWire } from "../adapters/registry";

/**
 * Wires whose upstream holds the conversation itself, so a turn may reference history this
 * process no longer has.
 *
 * The set is empty, and that is the finding rather than an oversight. The three wires that look
 * like they belong here do not:
 *
 * - devin sends `mapOcxMessagesToDevin(parsed)` — the whole conversation — on every turn
 *   (`src/adapters/devin.ts`). Its session/thread id buys prompt caching, not remembered context.
 * - cursor continues from `_providerContinuation.cursor.checkpointRef`, which is read out of the
 *   very store that just expired; without it `resolveCursorCheckpoint` returns a reason and the
 *   request falls back to `continuationMode: "full-replay"` over `parsed.context.messages`
 *   (`src/adapters/cursor/request-builder.ts`).
 * - kiro builds `conversationState.history` from the parsed turns it was given
 *   (`src/adapters/kiro/payload.ts`); a conversation id alone reconstructs nothing.
 *
 * So for every translated wire a replay miss means the delta travels alone. Only the native
 * Responses passthrough, which forwards `previous_response_id` untouched to a backend that stored
 * the chain, can answer a turn whose history this process lost.
 */
export const PROVIDER_OWNED_CONTINUATION_WIRES: ReadonlySet<AdapterWire> = new Set<AdapterWire>();

/** The wire an adapter id resolves to through contract inheritance, or undefined if unknown. */
export function resolvedAdapterWire(adapterId: unknown): AdapterWire | undefined {
  if (typeof adapterId !== "string" || !getAdapterDefinition(adapterId)) return undefined;
  return effectiveAdapterContract(adapterId).wire;
}
