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
import type { OcxAssistantContentPart, OcxMessage, OcxParsedRequest, OcxReasoningReplayScopeRef } from "../types";
import { peekBridgeSearchReplay, rememberBridgeSearchReplay } from "../responses/bridge-search-replay-cache";
import { WEB_SEARCH_TOOL_NAME } from "./synthetic-tool";

export function sidecarSearchReplayScope(scope: OcxReasoningReplayScopeRef | undefined): string | undefined {
  if (!scope?.clientPrincipalId || !scope.clientThreadId) return undefined;
  return JSON.stringify(["web-search-sidecar", scope.clientPrincipalId, scope.clientThreadId]);
}

/** Muse's local Codex-bearer principal is scoped to its own authenticated thread. */
function replayScope(parsed: Pick<OcxParsedRequest,"_reasoningReplayScope"|"_museNativeRoute"|"_museCodexPrincipal"|"_codexOwnThreadId">): string | undefined {
  const scope=parsed._reasoningReplayScope;
  if(scope?.clientPrincipalId) return sidecarSearchReplayScope(scope);
  if(!parsed._museNativeRoute || !parsed._museCodexPrincipal) return undefined;
  const thread=parsed._codexOwnThreadId ?? scope?.clientThreadId;
  return thread ? JSON.stringify(["web-search-sidecar",parsed._museCodexPrincipal,thread]) : undefined;
}

/** A fresh client-visible cell id the loop hands the bridge, so it can key the recorded result. */
export function newSidecarSearchCellId(): string {
  return `ws_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function rememberSidecarSearch(
  parsed: Pick<OcxParsedRequest, "_reasoningReplayScope"|"_museNativeRoute"|"_museCodexPrincipal"|"_codexOwnThreadId">,
  cellItemId: string,
  call: { id: string; arguments: Record<string, unknown> },
  output: string,
  museHiddenText?: string,
): void {
  rememberBridgeSearchReplay(replayScope(parsed), cellItemId, {
    callId: call.id,
    name: WEB_SEARCH_TOOL_NAME,
    argumentsText: JSON.stringify(call.arguments),
    output,
    ...(museHiddenText ? { museHiddenText } : {}),
  });
}

/**
 * Swap the recorded result into every replayed search pair the parser rebuilt. A miss keeps the
 * parser's fallback result; neither rerunning the search nor inventing a result is a recovery.
 */
export function restoreSidecarSearchResults(parsed: OcxParsedRequest): void {
  const cells = parsed._replayedWebSearchCells;
  if (!cells?.length) return;
  const scope = replayScope(parsed);
  const restoredMuseCalls = new Set<string>();
  for (const cell of cells) {
    const entry = cell.cellId ? peekBridgeSearchReplay(scope, cell.cellId) : undefined;
    const callId = cell.callId;
    for (const message of parsed.context.messages) {
      if (message.role === "toolResult" && message.toolCallId === callId && message.toolName === WEB_SEARCH_TOOL_NAME) {
        if (entry) message.content = entry.output;
        if (entry && parsed._museNativeRoute) message.toolCallId = entry.callId;
        if (cell.failed) message.isError = true;
      } else if (entry && message.role === "assistant") {
        const searchIndex = message.content.findIndex(part => part.type === "toolCall" && part.id === callId && part.name === WEB_SEARCH_TOOL_NAME);
        const prior = message.content[searchIndex - 1];
        if (parsed._museNativeRoute && entry.museHiddenText && searchIndex >= 0 &&
            !(prior?.type === "text" && prior.text === entry.museHiddenText)) {
          message.content.splice(searchIndex, 0, { type: "text", text: entry.museHiddenText });
        }
        for (const part of message.content) {
          if (part.type !== "toolCall" || part.id !== callId || part.name !== WEB_SEARCH_TOOL_NAME) continue;
          if (parsed._museNativeRoute) part.id = entry.callId;
          try {
            const args: unknown = JSON.parse(entry.argumentsText);
            if (args && typeof args === "object" && !Array.isArray(args)) part.arguments = args as Record<string, unknown>;
          } catch { /* keep the replayed arguments */ }
        }
      }
    }
    if (entry && parsed._museNativeRoute) { cell.callId = entry.callId; restoredMuseCalls.add(entry.callId); }
  }
  if (parsed._museNativeRoute) splitMuseSearchTurns(parsed.context.messages, restoredMuseCalls);
}

/** The runTurn sidecar executed each search serially; the parser can batch adjacent cells. */
function splitMuseSearchTurns(messages: OcxMessage[], ids: ReadonlySet<string>): void {
  for (let i = 0; i < messages.length; i++) {
    const assistant = messages[i];
    if (assistant?.role !== "assistant") continue;
    const calls = assistant.content.filter((part): part is Extract<OcxAssistantContentPart, { type: "toolCall" }> =>
      part.type === "toolCall" && part.name === WEB_SEARCH_TOOL_NAME && ids.has(part.id));
    if (!calls.length) continue;
    // Hosted cells are replayed before the later client call, but the parser can
    // group both calls and put the client's output before the search outputs.
    const firstClient = assistant.content.findIndex(part => part.type === "toolCall" && !calls.includes(part));
    if (firstClient >= 0 && assistant.content.slice(firstClient).some(part => part.type === "toolCall" && calls.includes(part))) continue;
    let end = i + 1;
    while (messages[end]?.role === "toolResult") end++;
    const results = messages.slice(i + 1, end);
    if (calls.some(call => results.filter(result => result.role === "toolResult" && result.toolCallId === call.id).length !== 1)) continue;
    const chunks: OcxMessage[] = [];
    let content: typeof assistant.content = [];
    for (const part of assistant.content) {
      content.push(part);
      if (part.type !== "toolCall" || !calls.includes(part)) continue;
      const result = results.find(item => item.role === "toolResult" && item.toolCallId === part.id);
      if (!result) { chunks.length = 0; break; }
      chunks.push({ ...assistant, content }, result);
      content = [];
    }
    if (!chunks.length) continue;
    if (content.length) chunks.push({ ...assistant, content });
    const remaining = results.filter(item => item.role !== "toolResult" || !calls.some(call => call.id === item.toolCallId));
    if (remaining.length && !content.length) continue;
    chunks.push(...remaining);
    messages.splice(i, end - i, ...chunks);
    i += chunks.length - 1;
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
