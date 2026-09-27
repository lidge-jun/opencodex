// LOCAL PATCH (runturn-websearch): web-search sidecar loop for runTurn adapters.
//
// Upstream's runWithWebSearch (loop.ts) only drives the buildRequest/fetch/
// parseStream transport, so adapters that own their turn loop (devin, cursor,
// qoder, codebuddy) silently dropped the hosted `web_search` declaration. This
// module replays the same interception contract over the runTurn event stream:
// the synthetic `web_search` function tool is injected into each iteration's
// tool list, calls to it are intercepted and executed through the configured
// sidecar backend, and the assistant call + toolResult are appended to the
// OcxMessage history before the next runTurn dispatch. Everything else passes
// through untouched.
//
// The file is deliberately self-contained (small helpers duplicated from
// loop.ts instead of exported) so the patch stays a pure addition plus a few
// small call-site edits — easier to re-apply after `ocx update`.

import type {
  AdapterEvent,
  OcxAssistantContentPart,
  OcxMessage,
  OcxParsedRequest,
  OcxProviderConfig,
} from "../types";
import type { SidecarPlan } from "./index";
import { WEB_SEARCH_TOOL_NAME, buildWebSearchTool } from "./synthetic-tool";
import { hasVisibleAssistantText, scanEventsForWebSearch } from "./loop";
import { isTruncatedStopReason } from "../responses/truncated-stop-reason";
import {
  runWebSearch,
  type SidecarOutcome,
  type SidecarOutcomeRecorder,
} from "./executor";
import { runAnthropicWebSearch } from "./anthropic-executor";
import { runXaiWebSearch } from "./xai-executor";
import { runGeminiWebSearch } from "./gemini-executor";
import { runExaWebSearch } from "./exa-executor";
import { formatWebSearchResults } from "./format-result";
import { cloneProviderOpaqueToolCallMetadata } from "../responses/provider-opaque-metadata";
import { redactSecretString } from "../lib/redact";
import { guardEmptyCompletionEventStream } from "../server/responses/empty-completion-guard";
import {
  isTranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../lib/translator-budget";
import { jsonUtf8Bytes } from "../lib/json-byte-size";

export interface RunTurnWebSearchDeps {
  parsed: OcxParsedRequest;
  plan: SidecarPlan;
  /** Required for the openai backend (ChatGPT forward path). */
  forwardProvider?: OcxProviderConfig;
  forwardHeaders?: Headers;
  /** Operator key for the exa backend; read from config by the caller. */
  exaApiKey?: string;
  abortSignal?: AbortSignal;
  recordSidecarOutcome?: SidecarOutcomeRecorder;
  /** Preserve the request's opt-in empty-completion retry before the search cap. */
  emptyCompletionRetry?: boolean;
  /**
   * Optional request translator budget. When present the loop charges what it
   * retains — each iteration's buffered event batch and the replay history it
   * appends to messages — with its own local byte counters, and releases
   * exactly those totals when the retention ends. It deliberately does NOT use
   * the shared event-ownership WeakMap helpers: other owners (queue, bridge,
   * output collector) may hold independent leases on the same event objects.
   */
  translatorBudget?: TranslatorBudget;
  /**
   * Dispatch one more routed-model iteration. Iterations 2+ get a fresh event
   * stream from the runTurn transport with the grown message history.
   */
  dispatch: (iterParsed: OcxParsedRequest) => AsyncIterable<AdapterEvent>;
}

/**
 * Parsed request for the FIRST iteration when the runTurn web-search loop is
 * active: same request plus the synthetic tool so the model can ask to search.
 */
export function runTurnWebSearchInitialParsed(parsed: OcxParsedRequest): OcxParsedRequest {
  return {
    ...parsed,
    context: {
      ...parsed.context,
      tools: [...(parsed.context.tools ?? []), buildWebSearchTool()],
    },
  };
}

// --- helpers duplicated from loop.ts (kept private there; see header note) ---

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Rebuild the assistant content parts that preceded a web_search call in this
 * iteration: visible text AND thinking, in event order, so the replayed
 * assistant message preserves everything the model emitted before the call.
 * Thinking extraction mirrors loop.ts's rules (signed blocks keep their own
 * signature, raw reasoning stays a separate unsigned part); text_delta parts
 * are folded in as OcxTextContent — upstream's thinking-only version silently
 * dropped visible text that preceded a tool call.
 */
function extractIterationContent(events: AdapterEvent[]): OcxAssistantContentPart[] {
  const parts: OcxAssistantContentPart[] = [];
  let text = "";
  let thinking = "";
  let signature: string | undefined;
  let rawReasoning = "";
  const flushText = () => {
    if (!text) return;
    parts.push({ type: "text", text });
    text = "";
  };
  const flushVisible = () => {
    if (!thinking && !signature) return;
    parts.push({ type: "thinking", thinking, ...(signature ? { signature } : {}) });
    thinking = "";
    signature = undefined;
  };
  const flushRaw = () => {
    if (!rawReasoning) return;
    parts.push({ type: "thinking", thinking: rawReasoning });
    rawReasoning = "";
  };
  for (const e of events) {
    if (e.type === "thinking_delta") {
      flushText();
      flushRaw();
      thinking += e.thinking;
    } else if (e.type === "reasoning_raw_delta") {
      flushText();
      flushVisible();
      rawReasoning += e.text;
    } else if (e.type === "thinking_signature") {
      signature = e.signature;
      flushVisible();
    } else if (e.type === "redacted_thinking") {
      flushText();
      flushVisible();
      flushRaw();
      parts.push({ type: "thinking", thinking: "", redacted: [e.data] });
    } else if (e.type === "text_delta") {
      flushVisible();
      flushRaw();
      text += e.text;
    }
  }
  flushText();
  flushVisible();
  flushRaw();
  return parts;
}

function forcedAnswerNudge(): OcxMessage {
  return {
    role: "developer",
    content:
      "Answer the user's question now using the web search results already gathered above. " +
      "Ground your answer in what those results actually say, and reference the relevant sources " +
      "when they are available. Do not claim you lack information that the results contain, and do " +
      "not invent sources that were not returned.",
    timestamp: Date.now(),
  };
}

/**
 * Transient developer-role nudge for the ONE recovery pass after a forced
 * answer came back empty. The recovery also removes every tool (toolChoice:
 * "none"), so the model has nothing to call and can only return text.
 */
function forcedAnswerRetryNudge(): OcxMessage {
  return {
    role: "developer",
    content:
      "Your previous response contained no usable answer. Web search has finished for this turn and " +
      "no tools are available for this response. Answer the user's question now in assistant text, " +
      "using the web search results already gathered above. If those results are insufficient, say " +
      "what is missing instead of returning an empty response.",
    timestamp: Date.now(),
  };
}

/**
 * Drive a runTurn adapter through the web-search loop. `first` is iteration
 * 0's already-dispatched event stream (built from
 * runTurnWebSearchInitialParsed); later iterations go through deps.dispatch.
 * Intermediate iterations emit only heartbeats and the search cell begin/end
 * pair — their text/thinking is folded back into the replayed history instead
 * of reaching the client mid-turn, matching the fetch-path loop's ordering.
 */
export async function* runTurnWebSearchLoop(
  first: AsyncIterable<AdapterEvent>,
  deps: RunTurnWebSearchDeps,
): AsyncGenerator<AdapterEvent> {
  const { parsed, plan, abortSignal } = deps;
  const messages: OcxMessage[] = [...parsed.context.messages];
  const allTools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
  const toolsNoWebSearch = (parsed.context.tools ?? []).filter(t => !t.webSearch);
  const failedQueries = new Set<string>();
  let searchesExecuted = 0;
  let executedSearchCount = 0;
  const HARD_CAP = plan.maxSearches + 3;
  let source = first;
  const loopT0 = Date.now();

  // Translator-budget ownership (deps.translatorBudget): the loop charges only
  // what it retains, tracks both totals locally, and releases exactly those
  // amounts — never a shared stage total another owner may also be releasing
  // from. Iteration event buffers release when the iteration's events are
  // consumed; the replay history appended to messages stays charged until the
  // loop exits because every later dispatch rebuilds its request from it.
  // Event objects are NOT leased through the shared ownership WeakMap: the
  // queue, the bridge, and the buffered-path output collector may each hold
  // their own independent accounting on the same objects.
  let bufferedBytes = 0;
  let historyBytes = 0;
  const chargeBuffered = (event: AdapterEvent): void => {
    if (!deps.translatorBudget) return;
    // Same per-event convention as retainTranslatedEvent: the first event owns
    // the array brackets, later events own their separator.
    const bytes = jsonUtf8Bytes(event) + (bufferedBytes === 0 ? 2 : 1);
    deps.translatorBudget.chargeRetained(bytes, { kind: "retained_collectors" });
    bufferedBytes += bytes;
  };
  const releaseBuffered = (): void => {
    if (!deps.translatorBudget || bufferedBytes === 0) return;
    deps.translatorBudget.releaseRetained(bufferedBytes, { kind: "retained_collectors" });
    bufferedBytes = 0;
  };
  const chargeHistory = (message: OcxMessage): void => {
    if (!deps.translatorBudget) return;
    const bytes = jsonUtf8Bytes(message) + 1;
    deps.translatorBudget.chargeRetained(bytes, { kind: "request_copies" });
    historyBytes += bytes;
  };
  const releaseHistory = (): void => {
    if (!deps.translatorBudget || historyBytes === 0) return;
    deps.translatorBudget.releaseRetained(historyBytes, { kind: "request_copies" });
    historyBytes = 0;
  };
  // Shared budget-failure convention (loop.ts): a 502 upstream_error carrying
  // the translation_buffer_limit code.
  const budgetErrorEvent = (): AdapterEvent => ({
    type: "error",
    status: 502,
    errorType: "upstream_error",
    code: "translation_buffer_limit",
    message: "upstream translation buffer exceeded the safe limit",
  });
  const appendMessage = (message: OcxMessage): void => {
    chargeHistory(message);
    messages.push(message);
  };
  const liveTypes = new Set<AdapterEvent["type"]>([
    "text_delta", "thinking_delta", "reasoning_raw_delta", "thinking_signature",
    "redacted_thinking", "kiro_redacted_reasoning",
  ]);

  const executeQuery = async (query: string, signal: AbortSignal | undefined): Promise<SidecarOutcome> => {
    try {
      switch (plan.backend) {
        case "anthropic":
          return plan.anthropicSidecar
            ? await runAnthropicWebSearch(query, plan.anthropicSidecar.providerName, plan.anthropicSidecar.provider, plan.settings, signal)
            : { text: "", sources: [], error: "anthropic backend selected without a resolved sidecar provider" };
        case "xai":
          return plan.xaiSidecar
            ? await runXaiWebSearch(query, plan.xaiSidecar.providerName, plan.xaiSidecar.provider, plan.settings, plan.xaiSearchOptions ?? {}, signal)
            : { text: "", sources: [], error: "xai backend selected without a resolved Grok OAuth provider" };
        case "gemini":
          return plan.geminiSidecar
            ? await runGeminiWebSearch(query, plan.geminiSidecar.providerName, plan.geminiSidecar.provider, plan.settings, signal)
            : { text: "", sources: [], error: "gemini backend selected without a resolved Antigravity provider" };
        case "exa":
          return deps.exaApiKey
            ? await runExaWebSearch(query, deps.exaApiKey, plan.settings, signal)
            : { text: "", sources: [], error: "exa backend selected without an exaApiKey" };
        default:
          return deps.forwardProvider
            ? await runWebSearch(query, plan.hostedTool, deps.forwardProvider, deps.forwardHeaders ?? new Headers(), plan.settings, signal, deps.recordSidecarOutcome)
            : { text: "", sources: [], error: "openai backend selected without a resolved forward sidecar" };
      }
    } catch (e) {
      return { text: "", sources: [], error: `sidecar failed: ${redactSecretString(e instanceof Error ? e.message : String(e))}` };
    }
  };

  async function* runSearchCall(
    call: { id: string; queries: string[]; providerMetadata?: Parameters<typeof cloneProviderOpaqueToolCallMetadata>[0] },
    precedingContent: OcxAssistantContentPart[],
  ): AsyncGenerator<AdapterEvent> {
    const results: { query: string; outcome: SidecarOutcome }[] = [];
    let beganCell = false;
    if (call.queries.length === 0) {
      searchesExecuted++;
      results.push({ query: "", outcome: { text: "", sources: [], error: "the model called web_search with an empty query" } });
    }
    for (const query of call.queries) {
      if (abortSignal?.aborted) {
        if (beganCell) yield { type: "web_search_call_end", id: call.id, queries: call.queries, status: "failed" };
        return;
      }
      yield { type: "heartbeat" };
      if (abortSignal?.aborted) {
        if (beganCell) yield { type: "web_search_call_end", id: call.id, queries: call.queries, status: "failed" };
        return;
      }
      let outcome: SidecarOutcome;
      if (failedQueries.has(normalizeQuery(query))) {
        outcome = { text: "", sources: [], error: "this query already failed earlier in the turn — do not call web_search again for it; answer from existing context" };
      } else if (searchesExecuted >= plan.maxSearches) {
        outcome = { text: "", sources: [], error: "web search limit reached for this turn — answer from results already gathered" };
      } else {
        if (!beganCell) {
          beganCell = true;
          yield { type: "web_search_call_begin", id: call.id };
        }
        if (abortSignal?.aborted) {
          yield { type: "web_search_call_end", id: call.id, queries: call.queries, status: "failed" };
          return;
        }
        outcome = await executeQuery(query, abortSignal);
        if (abortSignal?.aborted) {
          // The client already saw this cell's begin — close it so the UI never
          // shows a "Searching the web" spinner that never resolves.
          yield { type: "web_search_call_end", id: call.id, queries: call.queries, status: "failed" };
          return;
        }
        searchesExecuted++;
        executedSearchCount++;
        if (outcome.error) failedQueries.add(normalizeQuery(query));
      }
      results.push({ query, outcome });
    }
    const now = Date.now();
    const callArgs: Record<string, unknown> = call.queries.length > 1
      ? { queries: call.queries }
      : { query: call.queries[0] ?? "" };
    appendMessage({
      role: "assistant",
      content: [
        ...precedingContent,
        {
          type: "toolCall" as const,
          id: call.id,
          name: WEB_SEARCH_TOOL_NAME,
          arguments: callArgs,
          ...(cloneProviderOpaqueToolCallMetadata(call.providerMetadata)
            ? { providerMetadata: cloneProviderOpaqueToolCallMetadata(call.providerMetadata) }
            : {}),
        },
      ],
      timestamp: now,
    });
    const allFailed = results.every(r => !!r.outcome.error);
    appendMessage({
      role: "toolResult", toolCallId: call.id, toolName: WEB_SEARCH_TOOL_NAME,
      content: formatWebSearchResults(results, !!parsed._structuredOutput),
      isError: allFailed, timestamp: now,
    });
    if (beganCell) {
      const anySuccess = results.some(r => !r.outcome.error);
      const sources: { url: string; title?: string }[] = [];
      const seenSrc = new Set<string>();
      for (const r of results) {
        for (const s of r.outcome.sources) {
          if (seenSrc.has(s.url)) continue;
          seenSrc.add(s.url);
          sources.push(s.title ? { url: s.url, title: s.title } : { url: s.url });
        }
      }
      yield {
        type: "web_search_call_end", id: call.id,
        queries: call.queries,
        status: anySuccess ? "completed" : "failed",
        ...(sources.length > 0 ? { sources } : {}),
      };
    }
  }

  const abortEvent = (): AdapterEvent => ({
    type: "error",
    message: "client closed request during web-search",
  });
  const logDone = (iterations: number): void => {
    if (executedSearchCount === 0) return;
    const failedCount = failedQueries.size;
    console.warn(
      `[web-search-runturn] done — ${executedSearchCount} search${executedSearchCount > 1 ? "es" : ""}`
      + (failedCount > 0 ? ` (${failedCount} failed)` : "")
      + `, ${iterations + 1} iteration${iterations > 0 ? "s" : ""}, ${Date.now() - loopT0}ms`,
    );
  };
  let emptyAnswerRetries = 0;
  let ordinaryEmptyRetries = 0;
  let currentParsed = runTurnWebSearchInitialParsed(parsed);

  try {
    for (let i = 0; i < HARD_CAP; i++) {
      releaseBuffered();
      if (abortSignal?.aborted) {
        yield abortEvent();
        return;
      }
      const events: AdapterEvent[] = [];
      let liveWindowOpen = plan.streamRoutedModelOutput;
      let streamedCount = 0;
      // One identical-turn retry per request: once it is spent the guard is
      // not re-applied, so a later empty terminal reaches the loop itself —
      // at the search cap the forced-answer recovery below handles it, the
      // same contract loop.ts keeps by running no inner guard at all. A
      // maxRetries:0 wrap would instead convert that empty done into
      // empty_completion_retry_failed and end the turn before recovery.
      if (deps.emptyCompletionRetry && searchesExecuted < plan.maxSearches
        && ordinaryEmptyRetries === 0) {
        source = guardEmptyCompletionEventStream({
          firstEvents: source,
          continuation: () => {
            ordinaryEmptyRetries++;
            return deps.dispatch(currentParsed);
          },
        });
      }
      try {
        for await (const e of source) {
          if (abortSignal?.aborted) {
            yield abortEvent();
            return;
          }
          if (e.type === "error") {
            yield e;
            return;
          }
          if (e.type === "heartbeat") {
            yield e;
            continue;
          }
          chargeBuffered(e);
          events.push(e);
          if (liveWindowOpen && liveTypes.has(e.type)) {
            streamedCount++;
            yield e;
            continue;
          }
          liveWindowOpen = false;
          // Buffered text/reasoning/tool deltas are upstream activity too. Keep
          // the bridge alive without exposing the synthetic call to the client.
          if (e.type !== "done" && e.type !== "incomplete") yield { type: "heartbeat" };
        }
      } catch (e) {
        if (isTranslatorBudgetExceededError(e)) throw e;
        yield { type: "error", message: e instanceof Error ? e.message : String(e) };
        return;
      }

      const terminals = events.filter(e => e.type === "done" || e.type === "incomplete");
      if (terminals.length !== 1 || terminals[0] !== events.at(-1)) {
        yield { type: "error", status: 502, errorType: "upstream_error",
          message: "web-search runTurn stream must end with exactly one terminal event" };
        return;
      }
      const split = scanEventsForWebSearch(events);
      const terminal = terminals[0];
      const replayEvents = split.passthrough.slice(streamedCount);
      if (terminal.type === "incomplete") {
        for (const e of replayEvents) yield e;
        return;
      }
      const forceAnswer = searchesExecuted >= plan.maxSearches;
      // Loop only when the model's actionable output is purely web_search calls:
      // a real tool call belongs to Codex, and a budget-exhausted turn must
      // answer from what it already gathered.
      const shouldLoop = split.calls.length > 0 && !split.hasRealToolCall && !forceAnswer;
      if (!shouldLoop) {
        // A forced-answer pass that ends `done` must have produced usable output —
        // never a malformed tool call, and never silence. A truncated/refusal
        // stop is authoritative and replays as-is; an empty one gets exactly one
        // recovery pass with all tools removed (same contract as loop.ts #1001).
        if (forceAnswer) {
          const terminalEvent = split.passthrough.find(event => event.type === "done");
          if (terminalEvent?.type === "done" && !split.hasMalformedToolCall
            && isTruncatedStopReason(terminalEvent.stopReason)) {
            logDone(i);
            for (const e of replayEvents) yield e;
            return;
          }
          if (terminalEvent?.type === "done"
            && (split.hasMalformedToolCall
              || (!split.hasRealToolCall && !hasVisibleAssistantText(split.passthrough)))) {
            console.warn("[web-search-runturn] unusable forced answer", JSON.stringify({
              model: parsed.modelId,
              recoveryAttempt: emptyAnswerRetries,
              searchCalls: split.calls.length,
              malformed: split.hasMalformedToolCall,
              stopReason: terminalEvent.stopReason,
              eventTypes: [...new Set(split.passthrough.map(event => event.type))],
            }));
            if (!split.hasMalformedToolCall && !split.hasRealToolCall && emptyAnswerRetries === 0) {
              emptyAnswerRetries++;
              console.warn("[web-search-runturn] empty forced answer — retrying once without tools");
              yield { type: "heartbeat" };
              if (abortSignal?.aborted) { yield abortEvent(); return; }
              source = deps.dispatch({
                ...parsed,
                options: { ...parsed.options, toolChoice: "none" as const },
                context: {
                  ...parsed.context,
                  messages: [
                    ...messages,
                    ...(executedSearchCount > 0 ? [forcedAnswerNudge()] : []),
                    forcedAnswerRetryNudge(),
                  ],
                  tools: [],
                },
              });
              continue;
            }
            yield {
              type: "error",
              status: 502,
              errorType: "upstream_error",
              message: "forced-answer pass produced no usable assistant output",
            };
            return;
          }
        }
        logDone(i);
        for (const e of replayEvents) yield e;
        return;
      }

      const iterationContent = extractIterationContent(split.passthrough);
      for (const [callIndex, call] of split.calls.entries()) {
        if (abortSignal?.aborted) { yield abortEvent(); return; }
        yield* runSearchCall(call, callIndex === 0 ? iterationContent : []);
      }
      if (abortSignal?.aborted) {
        yield abortEvent();
        return;
      }

      const nextForceAnswer = searchesExecuted >= plan.maxSearches;
      const iterParsed: OcxParsedRequest = {
        ...parsed,
        context: {
          ...parsed.context,
          messages: nextForceAnswer && executedSearchCount > 0
            ? [...messages, forcedAnswerNudge()]
            : messages,
          tools: nextForceAnswer ? toolsNoWebSearch : allTools,
        },
      };
      currentParsed = iterParsed;
      source = deps.dispatch(iterParsed);
    }

    // Safety net: the hard cap should be unreachable (forceAnswer ends the loop
    // first), but never hang a client stream if an adapter misbehaves.
    yield { type: "error", message: "web-search runTurn loop exceeded its iteration cap" };
  } catch (error) {
    if (!isTranslatorBudgetExceededError(error)) throw error;
    yield budgetErrorEvent();
  } finally {
    releaseBuffered();
    releaseHistory();
  }
}
