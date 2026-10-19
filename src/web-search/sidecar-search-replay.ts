/**
 * Replay memo for searches the web-search sidecar executed (#7269).
 *
 * The sidecar hands the model its search result inside the turn, but the caller only sees a hosted
 * `web_search_call` cell without the result text. When the turn ends on a client tool call, the
 * next request replays that cell, which the parser rebuilds as a `web_search` call/result pair
 * with a fallback result (src/responses/web-search-replay.ts). This module records the real result
 * under the cell id and puts it back into that pair, or removes the pairs when no sidecar runs:
 * the synthetic `web_search` tool is then undeclared, and a call to it is an invalid history.
 *
 * Storage reuses the bounded, in-memory, never-logged store of the passthrough bridge
 * (src/responses/bridge-search-replay-cache.ts) under a separate scope. Unlike a bridged
 * destination call, the sidecar result does not belong to the serving model: the proxy ran it with
 * its own backend. So the scope is the caller principal and conversation, which lets a model switch
 * inside the same conversation keep the result, and fails closed without either.
 */
import type { OcxMessage, OcxParsedRequest, OcxReasoningReplayScopeRef } from "../types";
import { peekBridgeSearchReplay, rememberBridgeSearchReplay } from "../responses/bridge-search-replay-cache";
import { WEB_SEARCH_TOOL_NAME } from "./synthetic-tool";

export function sidecarSearchReplayScope(scope: OcxReasoningReplayScopeRef | undefined): string | undefined {
  if (!scope?.clientPrincipalId || !scope.clientThreadId) return undefined;
  return JSON.stringify(["web-search-sidecar", scope.clientPrincipalId, scope.clientThreadId]);
}

/** A fresh client-visible cell id the loop hands the bridge, so it can key the recorded result. */
export function newSidecarSearchCellId(): string {
  return `ws_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function rememberSidecarSearch(
  parsed: Pick<OcxParsedRequest, "_reasoningReplayScope">,
  cellItemId: string,
  call: { id: string; arguments: Record<string, unknown> },
  output: string,
): void {
  rememberBridgeSearchReplay(sidecarSearchReplayScope(parsed._reasoningReplayScope), cellItemId, {
    callId: call.id,
    name: WEB_SEARCH_TOOL_NAME,
    argumentsText: JSON.stringify(call.arguments),
    output,
  });
}

/**
 * Swap the recorded result into every replayed search pair the parser rebuilt. A miss keeps the
 * parser's fallback result; neither rerunning the search nor inventing a result is a recovery.
 */
export function restoreSidecarSearchResults(parsed: OcxParsedRequest): void {
  const cells = parsed._replayedWebSearchCells;
  if (!cells?.length) return;
  const scope = sidecarSearchReplayScope(parsed._reasoningReplayScope);
  for (const cell of cells) {
    const entry = cell.cellId ? peekBridgeSearchReplay(scope, cell.cellId) : undefined;
    for (const message of parsed.context.messages) {
      if (message.role === "toolResult" && message.toolCallId === cell.callId && message.toolName === WEB_SEARCH_TOOL_NAME) {
        if (entry) message.content = entry.output;
        if (cell.failed) message.isError = true;
      } else if (entry && message.role === "assistant") {
        for (const part of message.content) {
          if (part.type !== "toolCall" || part.id !== cell.callId || part.name !== WEB_SEARCH_TOOL_NAME) continue;
          try {
            const args: unknown = JSON.parse(entry.argumentsText);
            if (args && typeof args === "object" && !Array.isArray(args)) part.arguments = args as Record<string, unknown>;
          } catch { /* keep the replayed arguments */ }
        }
      }
    }
  }
}

/**
 * Remove the rebuilt pairs when no sidecar plan resolved, restoring the history the routed
 * provider saw before #7269. An assistant turn left holding only reasoning goes too, as the parser
 * dropped reasoning that led straight to a hosted cell.
 */
export function stripReplayedSearchPairs(parsed: OcxParsedRequest): void {
  const cells = parsed._replayedWebSearchCells;
  if (!cells?.length) return;
  const ids = new Set(cells.map(cell => cell.callId));
  const isPair = (part: { type: string; id?: string; name?: string }) =>
    part.type === "toolCall" && part.name === WEB_SEARCH_TOOL_NAME && part.id !== undefined && ids.has(part.id);
  const kept: OcxMessage[] = [];
  for (const message of parsed.context.messages) {
    if (message.role === "toolResult" && message.toolName === WEB_SEARCH_TOOL_NAME && ids.has(message.toolCallId)) continue;
    if (message.role === "assistant" && message.content.some(isPair)) {
      const content = message.content.filter(part => !isPair(part));
      if (!content.some(part => part.type !== "thinking")) continue;
      kept.push({ ...message, content });
      continue;
    }
    kept.push(message);
  }
  parsed.context.messages = kept;
  delete parsed._replayedWebSearchCells;
}
