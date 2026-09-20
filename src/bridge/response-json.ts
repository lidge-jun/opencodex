import type {
  AdapterEvent,
  OcxMessagePhase,
  OcxProviderContinuationState,
  OcxProviderOpaqueToolCallMetadata,
  OcxReasoningReplayScopeRef,
  OcxUsage,
} from "../types";
import { coerceIntegerToolArguments } from "../lib/tool-argument-integers";
import { attemptDeliveryRecorder } from "../usage/attempt-delivery";
import {
  adapterFailureFromMessage,
  classifyError,
  cyberPolicyErrorType,
  CYBER_POLICY_ERROR_CODE,
  isCyberPolicyCode,
  type OcxErrorPayload,
} from "../lib/errors";
import { mayBecomePatchEnvelope, repairFreeformToolInput } from "../responses/apply-patch-envelope";
import { encodeCompactionSummary } from "../responses/compaction";
import { compileCodeModeHelperInput, resolveCodeModeHelperName } from "../responses/code-mode-helper-compat";
import { isTruncatedStopReason, truncationReasonFor } from "../responses/truncated-stop-reason";
import { encodeReasoningEnvelope, type ReasoningEnvelope } from "../responses/reasoning-envelope";
import { rememberReasoningForCall } from "../responses/reasoning-replay-cache";
import {
  rememberAndSerializeExtraContent,
  rememberExtraContentForReplay,
  awaitThoughtSignatureDurability,
} from "../responses/thought-signature-replay";
import {
  createCitationMarkerFilter,
  stripCitationMarkers,
  type CitationMarkerFilter,
} from "../responses/citation-markers";
import { declaresCodeModeExec, normalizeDeclaredToolName } from "../types";
import { appendSafeWebSearchSource, safeWebSearchSources } from "../web-search/sources";
import {
  isTranslatorBudgetExceededError,
  releaseTranslatedEvent,
  createTranslatorBudget,
  type TranslatorBudget,
  type TranslatorBufferKind,
} from "../lib/translator-budget";
import { adapterFailureFromEvent, emptyChunks, joinChunks, responsesUsage, toolCallArgumentsUsable, uuid, webSearchAction } from "./internal";
import type { OutputItem, StringChunks } from "./internal";
import { bridgeToResponsesSSE } from "./sse";

export function buildResponseJSON(
  events: AdapterEvent[],
  modelId: string,
  options?: Parameters<typeof buildResponseJSONWithBudget>[2],
): Record<string, unknown> {
  // Default-budget safety net: a caller that omits the budget gets a bounded
  // default (disposed with the call), never the unbounded append path.
  if (options?.translatorBudget) {
    const body = buildResponseJSONWithBudget(events, modelId, options);
    // A buffered turn delivers its whole answer as one body, so nothing calls the per-frame
    // recorder on the SSE bridge. Without this the attempt would persist adapter events with
    // zero relayed ones, which is the loss signal -- raised on every non-streaming request.
    attemptDeliveryRecorder(options.translatorBudget)?.noteBufferedDelivery(body);
    return body;
  }
  const budget = createTranslatorBudget();
  try {
    return buildResponseJSONWithBudget(events, modelId, { ...options, translatorBudget: budget });
  } finally {
    budget.dispose();
  }
}

function buildResponseJSONWithBudget(
  events: AdapterEvent[],
  modelId: string,
  options?: {
    hideThinkingSummary?: boolean;
    toolNsMap?: Map<string, { namespace: string; name: string; freeform?: true }>;
    /** Request-visible tool names. When present, an upstream call outside this set fails closed. */
    declaredToolNames?: ReadonlySet<string>;
    /** See `bridgeToResponsesSSE`: enforcement is separate from normalization (#4735). */
    enforceDeclaredToolNames?: boolean;
    /** Declared parameter schema per tool name; repairs integral-float integer args (#1611). */
    toolParameterSchemas?: ReadonlyMap<string, Record<string, unknown>>;
    freeformToolNames?: Set<string>;
    toolSearchToolNames?: Set<string>;
    /** Remote compaction v2 turn — append one synthetic compaction output item (see bridgeToResponsesSSE). */
    compaction?: boolean;
    onProviderState?: (state: OcxProviderContinuationState) => void;
    /** Raw adapter-reported usage before wire normalization (see bridgeToResponsesSSE onUsage). */
    onUsage?: (usage: OcxUsage | undefined) => void;
    translatorBudget?: TranslatorBudget;
    /** Conversation identity for the reasoning replay cache (issue #950). */
    replayCacheScope?: OcxReasoningReplayScopeRef;
  },
): Record<string, unknown> {
  const responseId = `resp_${uuid()}`;
  const replayCacheScope = options?.replayCacheScope;
  const output: OutputItem[] = [];
  const budget = options?.translatorBudget;
  const encoder = new TextEncoder();
  const bytesOf = (value: string): number => Buffer.byteLength(value);
  const appendBatchString = (
    previous: StringChunks,
    fragment: string,
    kind: TranslatorBufferKind,
    callId?: string,
  ): StringChunks => {
    const fragmentBytes = bytesOf(fragment);
    if (fragmentBytes === 0) return previous;
    const nextBytes = previous.bytes + fragmentBytes;
    if (!budget) {
      previous.chunks.push(fragment);
      return { chunks: previous.chunks, bytes: nextBytes };
    }
    const scope = { kind, ...(callId ? { callId } : {}) };
    const reservation = budget.reserveTransient(nextBytes, scope);
    try {
      previous.chunks.push(fragment);
      const result: StringChunks = { chunks: previous.chunks, bytes: nextBytes };
      reservation.commitRetained();
      budget.releaseRetained(previous.bytes, scope);
      return result;
    } catch (error) {
      reservation.release();
      throw error;
    }
  };
  // Batch counterpart: tool-call arguments require direct string representation for immediate
  // JSON serialization compatibility.
  const appendBatchStringDirect = (
    previous: string,
    previousBytes: number,
    fragment: string,
    kind: TranslatorBufferKind,
    callId?: string,
  ): { value: string; bytes: number } => {
    const nextBytes = previousBytes + bytesOf(fragment);
    if (!budget) return { value: previous + fragment, bytes: nextBytes };
    const scope = { kind, ...(callId ? { callId } : {}) };
    const reservation = budget.reserveTransient(nextBytes, scope);
    try {
      const value = previous + fragment;
      reservation.commitRetained();
      budget.releaseRetained(previousBytes, scope);
      return { value, bytes: nextBytes };
    } catch (error) {
      reservation.release();
      throw error;
    }
  };
  const replaceBatchRetainedString = (previousBytes: number, next: string, kind: TranslatorBufferKind): number => {
    const nextBytes = bytesOf(next);
    if (!budget) return nextBytes;
    const reservation = budget.reserveTransient(nextBytes, { kind });
    reservation.commitRetained();
    budget.releaseRetained(previousBytes, { kind });
    return nextBytes;
  };
  const pushOutput = (item: OutputItem, replacedBytes = 0, kind: TranslatorBufferKind = "retained_collectors") => {
    const reservation = budget?.reserveTransient(bytesOf(JSON.stringify(item)), { kind });
    output.push(item);
    reservation?.commitRetained();
    if (replacedBytes > 0) budget?.releaseRetained(replacedBytes, { kind });
  };
  let usage: OcxUsage | undefined;
  let errorEvent: Extract<AdapterEvent, { type: "error" }> | undefined;
  let incompleteEvent: Extract<AdapterEvent, { type: "incomplete" }> | undefined;
  let endTurn: boolean | undefined;
  let stopReason: string | undefined;
  // The adapter's stop reason exactly as it arrived. `stopReason` above is deliberately narrowed
  // to the two reasons that map onto a Responses `incomplete_details`; the raw value is what the
  // truncation guard needs, because adapters disagree on vocabulary (`length`, `refusal`, ...).
  let rawStopReason: string | undefined;
  let cleanDone = false;
  // Whether the adapter emitted ANY terminal (done/error/incomplete). Distinct from `cleanDone`,
  // which is only true for a `done` without a stop reason. A buffered turn whose adapter simply
  // stopped emitting has no terminal at all, and must not be reported as a success.
  let sawTerminal = false;
  let batchCompaction = emptyChunks();
  let compactionEncryptedContent: string | undefined;

  let currentText = emptyChunks();
  let currentTextPhase: OcxMessagePhase | undefined;
  let currentSummaryReasoning = emptyChunks();
  let currentRawReasoning = emptyChunks();
  // Same replay-cache handoff as the streaming path (issue #950): the most
  // recently flushed raw reasoning waits for the tool call it preceded.
  let rawReasoningForNextToolCall = "";
  // Anthropic extended-thinking round-trip (batch): see bridgeToResponsesSSE counterpart.
  let batchSignature: string | undefined;
  let batchSignatureBytes = 0;
  let batchRedacted: string[] = [];
  let batchRedactedBytes = 0;
  // Kiro reasoning blob, held until after the trailing flushes so it lands AFTER the assistant
  // message (see the streaming path). Retained because it outlives releaseTranslatedEvent.
  let batchKiroRedacted: string | undefined;
  let batchKiroRedactedBytes = 0;
  let currentToolCallId = "";
  let currentToolCallName = "";
  let currentToolCallCodeModeHelperName: string | undefined;
  let currentToolCallArgs = "";
  let currentToolCallProviderMetadata: OcxProviderOpaqueToolCallMetadata | undefined;
  let currentToolCallArgsBytes = 0;
  // Web-search citations awaiting the next assistant message (attached as url_citation annotations).
  let pendingWebSources: { url: string; title?: string }[] = [];

  const freeformInput = (
    args: string,
    toolName: string,
    namespace?: string,
    codeModeHelperName?: string,
  ): string => {
    const helper = resolveCodeModeHelperName(codeModeHelperName, toolName, args, namespace, options?.declaredToolNames);
    return helper
      ? compileCodeModeHelperInput(args, helper, codeModeHelperName ?? toolName)
      : repairFreeformToolInput(args, toolName, namespace);
  };
  const parseArgsObj = (args: string): Record<string, unknown> => {
    try { const o = JSON.parse(args); return o && typeof o === "object" ? o : {}; } catch { return {}; }
  };

  const flushText = (inferredPhase?: OcxMessagePhase) => {
    const currentTextStr = joinChunks(currentText);
    if (!currentTextStr) return;
    const phase = currentTextPhase ?? inferredPhase;
    // ChatGPT-backend citation markers arrive as literal private-use characters that the
    // Codex TUI prints verbatim (#3150). Strip them here rather than at the accumulator so
    // the retained byte accounting above still describes what the upstream actually sent.
    const text = stripCitationMarkers(currentTextStr);
    const sourceBytes = pendingWebSources.reduce((sum, source) => sum + bytesOf(JSON.stringify(source)), 0);
    const annotations = pendingWebSources.map(s => ({
      type: "url_citation", url: s.url, ...(s.title ? { title: s.title } : {}), start_index: 0, end_index: 0,
    }));
    pendingWebSources = [];
    const item = {
      type: "message", id: `msg_${uuid()}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations }],
      ...(phase ? { phase } : {}),
    } as OutputItem;
    pushOutput(item, currentText.bytes);
    budget?.releaseRetained(sourceBytes, { kind: "tool_search_sources" });
    currentText = emptyChunks();
    currentTextPhase = undefined;
  };
  const flushSummaryReasoning = () => {
    const summaryText = joinChunks(currentSummaryReasoning);
    if (!summaryText && !batchSignature && batchRedacted.length === 0) return;
    const envelope: ReasoningEnvelope = {};
    if (batchSignature) envelope.sig = batchSignature;
    if (batchRedacted.length > 0) envelope.red = batchRedacted;
    const hidden = options?.hideThinkingSummary === true;
    if (hidden && summaryText && (envelope.sig || envelope.red)) envelope.txt = summaryText;
    const encrypted = envelope.sig || envelope.red || envelope.txt ? encodeReasoningEnvelope(envelope, budget) : undefined;
    const sourceBytes = currentSummaryReasoning.bytes + batchSignatureBytes + batchRedactedBytes;
    batchSignature = undefined;
    batchSignatureBytes = 0;
    batchRedacted = [];
    batchRedactedBytes = 0;
    if (hidden && !encrypted) {
      budget?.releaseRetained(sourceBytes, { kind: "reasoning" });
      currentSummaryReasoning = emptyChunks();
      return;
    }
    const item = {
      type: "reasoning", id: `rs_${uuid()}`,
      summary: !hidden && summaryText ? [{ type: "summary_text", text: summaryText }] : [],
      ...(encrypted ? { encrypted_content: encrypted } : {}),
    } as OutputItem;
    pushOutput(item, sourceBytes, "reasoning");
    currentSummaryReasoning = emptyChunks();
  };
  const flushRawReasoning = () => {
    const rawText = joinChunks(currentRawReasoning);
    if (!rawText) return;
    rawReasoningForNextToolCall = rawText;
    if (options?.hideThinkingSummary === true) {
      // Same contract as the streaming path: no visible reasoning, txt-only envelope round-trip.
      pushOutput({
        type: "reasoning", id: `rs_${uuid()}`, summary: [],
        encrypted_content: encodeReasoningEnvelope({ txt: rawText }, budget),
      }, currentRawReasoning.bytes, "reasoning");
      currentRawReasoning = emptyChunks();
      return;
    }
    pushOutput({
      type: "reasoning", id: `rs_${uuid()}`,
      summary: [],
      content: [{ type: "reasoning_text", text: rawText }],
    }, currentRawReasoning.bytes, "reasoning");
    currentRawReasoning = emptyChunks();
  };
  const flushToolCall = (status: "completed" | "incomplete" = "completed") => {
    if (!currentToolCallId) return;
    const mapped = options?.toolNsMap?.get(currentToolCallName);
    const realName = mapped?.name ?? currentToolCallName;
    const ns = mapped?.namespace;
    const toolSearch = options?.toolSearchToolNames?.has(realName) ?? false;
    const freeform = !toolSearch && (mapped
      ? mapped.freeform === true
      : (options?.freeformToolNames?.has(realName) ?? false));
    // #1611: same integral-float repair as the streaming path. Keyed by the wire name
    // the request declared, which is the pre-namespace-mapping `currentToolCallName`.
    const coercedArgs = coerceIntegerToolArguments(
      currentToolCallArgs,
      options?.toolParameterSchemas?.get(currentToolCallName),
      ns === undefined ? realName : undefined,
    );
    // Freeform tools serialize as custom_tool_call without extra_content; remember the
    // signature server-side regardless so the replayed call can be re-signed (#1735).
    void rememberExtraContentForReplay(currentToolCallId, currentToolCallProviderMetadata, replayCacheScope);
    if (toolSearch) {
      pushOutput({
        type: "tool_search_call", id: `tsc_${uuid()}`,
        call_id: currentToolCallId, execution: "client",
        arguments: parseArgsObj(coercedArgs), status,
      });
    } else if (freeform) {
      pushOutput({
        type: "custom_tool_call", id: `ctc_${uuid()}`,
        call_id: currentToolCallId, name: realName,
        ...(ns ? { namespace: ns } : {}),
        input: freeformInput(currentToolCallArgs, realName, ns, currentToolCallCodeModeHelperName), status,
      });
    } else {
      pushOutput({
        type: "function_call", id: `fc_${uuid()}`,
        call_id: currentToolCallId, name: realName,
        arguments: coercedArgs || "{}", status,
        ...(ns ? { namespace: ns } : {}),
        ...(rememberAndSerializeExtraContent(currentToolCallId, currentToolCallProviderMetadata, replayCacheScope).extra ?? {}),
      });
    }
    budget?.closeCall(currentToolCallId);
    currentToolCallId = "";
    currentToolCallName = "";
    currentToolCallCodeModeHelperName = undefined;
    currentToolCallProviderMetadata = undefined;
    currentToolCallArgs = "";
    currentToolCallArgsBytes = 0;
  };

  for (const e of events) {
    if (errorEvent) {
      // Match streaming: once the turn fails, later parallel calls must not become executable
      // completed output. Still release every retained event in order and preserve terminal usage.
      if (e.type === "error" || e.type === "incomplete" || e.type === "done") {
        usage = e.usage ?? usage;
      }
      if (budget) releaseTranslatedEvent(e, budget);
      continue;
    }
    if (batchSignature !== undefined && e.type !== "thinking_signature" && e.type !== "heartbeat") {
      flushSummaryReasoning();
    }
    switch (e.type) {
      case "assistant_boundary":
        flushText("commentary");
        flushSummaryReasoning();
        flushRawReasoning();
        rawReasoningForNextToolCall = "";
        flushToolCall();
        break;
      case "text_delta":
        // Only flush on an explicit phase change. A later delta that omits `phase` must keep
        // appending under the previously established phase.
        if (currentText.bytes > 0 && e.phase !== undefined && currentTextPhase !== e.phase) flushText("commentary");
        if (currentSummaryReasoning.bytes > 0) flushSummaryReasoning();
        if (currentRawReasoning.bytes > 0) flushRawReasoning();
        // Empty text deltas (batch chat responses always carry content, often "") must
        // not wipe reasoning that precedes a tool call (#950 non-streaming path).
        if (e.text.length > 0) rawReasoningForNextToolCall = "";
        if (currentToolCallId) flushToolCall();
        // Compaction turns keep the summary out of normal message output (replay dedup — see
        // bridgeToResponsesSSE); it ships only inside the synthetic compaction item below.
        if (options?.compaction) {
          batchCompaction = appendBatchString(
            batchCompaction, e.text, "retained_collectors",
          );
        }
        else {
          if (e.phase !== undefined) currentTextPhase = e.phase;
          currentText = appendBatchString(
            currentText, e.text, "retained_collectors",
          );
        }
        break;
      case "thinking_delta":
        if (currentText.bytes > 0) flushText("commentary");
        if (currentRawReasoning.bytes > 0) flushRawReasoning();
        if (e.thinking.length > 0) rawReasoningForNextToolCall = "";
        if (currentToolCallId) flushToolCall();
        {
          currentSummaryReasoning = appendBatchString(
            currentSummaryReasoning, e.thinking, "reasoning",
          );
        }
        break;
      case "thinking_signature":
        // Like streaming, retain the latest signature update until the next semantic
        // event. Flushing every update would manufacture signature-only siblings.
        batchSignatureBytes = replaceBatchRetainedString(batchSignatureBytes, e.signature, "reasoning");
        batchSignature = e.signature;
        break;
      case "redacted_thinking":
        flushText("commentary");
        flushSummaryReasoning();
        flushRawReasoning();
        flushToolCall();
        {
          const dataBytes = bytesOf(e.data);
          budget?.chargeRetained(dataBytes, { kind: "reasoning" });
          batchRedactedBytes += dataBytes;
        }
        batchRedacted.push(e.data);
        flushSummaryReasoning();
        break;
      case "kiro_redacted_reasoning":
        // Stash only — pushed after the trailing flushes. One blob per turn, so last wins.
        {
          const dataBytes = bytesOf(e.data);
          budget?.chargeRetained(dataBytes, { kind: "reasoning" });
          if (batchKiroRedactedBytes > 0) budget?.releaseRetained(batchKiroRedactedBytes, { kind: "reasoning" });
          batchKiroRedactedBytes = dataBytes;
        }
        batchKiroRedacted = e.data;
        break;
      case "reasoning_raw_delta":
        if (currentText.bytes > 0) flushText("commentary");
        if (currentSummaryReasoning.bytes > 0) flushSummaryReasoning();
        if (currentToolCallId) flushToolCall();
        {
          currentRawReasoning = appendBatchString(
            currentRawReasoning, e.text, "reasoning",
          );
        }
        break;
      case "tool_call_start": {
        if (currentText.bytes > 0) flushText("commentary");
        if (currentSummaryReasoning.bytes > 0) flushSummaryReasoning();
        if (currentRawReasoning.bytes > 0) flushRawReasoning();
        if (rawReasoningForNextToolCall) {
          rememberReasoningForCall(e.id, rawReasoningForNextToolCall, replayCacheScope);
        }
        flushToolCall();
        const effectiveName = normalizeDeclaredToolName(e.name, options?.declaredToolNames);
        if (
          options?.declaredToolNames
          && options.enforceDeclaredToolNames !== false
          && !options.declaredToolNames.has(effectiveName)
        ) {
          errorEvent = {
            type: "error",
            message: `routed provider emitted undeclared client tool "${effectiveName}"; only request-declared tools may be called`,
            status: 502,
            errorType: "upstream_error",
          };
          break;
        }
        currentToolCallId = e.id;
        budget?.openCall(e.id);
        currentToolCallName = effectiveName;
        currentToolCallCodeModeHelperName = effectiveName === "exec" && e.name !== effectiveName
          ? e.name
          : undefined;
        currentToolCallArgs = "";
        currentToolCallArgsBytes = 0;
        currentToolCallProviderMetadata = e.providerMetadata;
        break;
      }
      case "tool_call_delta":
        {
          ({ value: currentToolCallArgs, bytes: currentToolCallArgsBytes } = appendBatchStringDirect(
            currentToolCallArgs, currentToolCallArgsBytes, e.arguments, "tool_args", currentToolCallId,
          ));
        }
        break;
      case "tool_call_end":
        if (!toolCallArgumentsUsable(currentToolCallArgs) && currentToolCallId) {
          // Mirror the streaming path: refuse to complete unusable arguments.
          const mapped = options?.toolNsMap?.get(currentToolCallName);
          const realName = mapped?.name ?? currentToolCallName;
          const toolSearch = options?.toolSearchToolNames?.has(realName) ?? false;
          const freeform = !toolSearch && (mapped
            ? mapped.freeform === true
            : (options?.freeformToolNames?.has(realName) ?? false));
          if (!freeform && !toolSearch) {
            flushToolCall("incomplete");
            errorEvent = {
              type: "error",
              message: "upstream stream produced malformed tool call arguments",
              status: 502,
              errorType: "upstream_error",
            };
            break;
          }
        }
        flushToolCall();
        break;
      case "web_search_call_begin":
        // Batch/non-streaming output has no in_progress phase to animate — the search cell is a
        // single finalized item, emitted on `end`. Begin is a no-op here.
        break;
      case "web_search_call_end": {
        if (currentText.bytes > 0) flushText("commentary");
        if (currentSummaryReasoning.bytes > 0) flushSummaryReasoning();
        if (currentRawReasoning.bytes > 0) flushRawReasoning();
        flushToolCall();
        const safeSources = safeWebSearchSources(e.sources);
        pushOutput({
          type: "web_search_call", id: `ws_${uuid()}`, status: e.status ?? "completed",
          action: webSearchAction(e.queries),
          ...(safeSources.length > 0 ? { sources: safeSources } : {}),
        });
        if (safeSources.length > 0) {
          for (const source of safeSources) {
            if (appendSafeWebSearchSource(pendingWebSources, source)) {
              budget?.chargeRetained(bytesOf(JSON.stringify(source)), { kind: "tool_search_sources" });
            }
          }
        }
        break;
      }
      case "error":
        errorEvent = e;
        sawTerminal = true;
        usage = e.usage ?? usage;
        break;
      case "incomplete":
        incompleteEvent = e;
        sawTerminal = true;
        endTurn = e.endTurn;
        if (e.providerState) options?.onProviderState?.(e.providerState);
        break;
      case "done":
        usage = e.usage;
        compactionEncryptedContent = e.compactionEncryptedContent;
        sawTerminal = true;
        endTurn = e.endTurn;
        cleanDone = !isTruncatedStopReason(e.stopReason);
        rawStopReason = e.stopReason;
        if (e.providerState) options?.onProviderState?.(e.providerState);
        // Match streaming: max_tokens and content_filter both terminate as incomplete.
        // Normalize every adapter's truncation vocabulary to the canonical pair, so a raw
        // `length` or `refusal` reaches the status/incomplete_details logic below instead of
        // silently reading as a clean stop.
        {
          const truncation = truncationReasonFor(e.stopReason);
          if (truncation) stopReason = truncation === "max_output_tokens" ? "max_tokens" : "content_filter";
        }
        break;
    }
    if (budget) releaseTranslatedEvent(e, budget);
  }
  flushText(cleanDone && !errorEvent && !incompleteEvent ? "final_answer" : undefined);
  if (pendingWebSources.length > 0) {
    const sourceBytes = pendingWebSources.reduce((sum, source) => sum + bytesOf(JSON.stringify(source)), 0);
    pendingWebSources = [];
    budget?.releaseRetained(sourceBytes, { kind: "tool_search_sources" });
  }
  flushSummaryReasoning();
  flushRawReasoning();
  // Open tool call on a failed/incomplete turn must not land as status:"completed" — and neither
  // must one left open by a stream that stopped without any terminal at all. That case previously
  // fell through to "completed", handing back a function_call whose arguments were half-written
  // JSON, inside a turn also marked completed.
  if (currentToolCallId) {
    flushToolCall(errorEvent || incompleteEvent || !sawTerminal || isTruncatedStopReason(rawStopReason)
      ? "incomplete" : "completed");
  }
  if (batchKiroRedacted) {
    // pushOutput reserves the item itself and releases the retained raw blob it replaces.
    pushOutput({
      type: "reasoning", id: `rs_${uuid()}`, summary: [],
      encrypted_content: encodeReasoningEnvelope({ krc: batchKiroRedacted }, budget),
    }, batchKiroRedactedBytes, "reasoning");
    batchKiroRedacted = undefined;
    batchKiroRedactedBytes = 0;
  }
  // A truncated turn must never be installed as replacement history: emit the
  // compaction item only when the turn actually completed (#422).
  if (
    options?.compaction
    && !errorEvent
    && !incompleteEvent
    // A stream that stopped without any terminal did not complete either. The original guard
    // could only see explicit failure events, so an adapter EOF slipped past it and installed a
    // truncated summary as replacement history — the exact #422 hazard, reached by a route that
    // did not exist when the guard was written.
    && sawTerminal
    && !isTruncatedStopReason(rawStopReason)
  ) {
   const item = {
      type: "compaction", id: `cmp_${uuid()}`,
      encrypted_content: compactionEncryptedContent ?? encodeCompactionSummary(joinChunks(batchCompaction)),
    };
    pushOutput(item, compactionEncryptedContent ? bytesOf(compactionEncryptedContent) : batchCompaction.bytes);
  }

  const failure = errorEvent ? adapterFailureFromEvent(errorEvent) : undefined;
  const status = errorEvent
    ? "failed"
    : incompleteEvent || stopReason === "max_tokens" || stopReason === "content_filter"
      ? "incomplete"
      : sawTerminal
        ? "completed"
        // The adapter stopped emitting without any terminal, so the turn was cut short. Streaming
        // already reports this as response.incomplete / adapter_eof (see the !terminated branch);
        // defaulting the buffered path to "completed" handed callers a truncated turn — including
        // one carrying a never-closed tool call with half-written JSON arguments — as a success.
        : "incomplete";
  options?.onUsage?.(incompleteEvent?.usage ?? usage);
  return {
    id: responseId, object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: modelId, output,
    ...(endTurn !== undefined ? { end_turn: endTurn } : {}),
    ...(failure ? { error: failure.error, last_error: failure.error } : {}),
    ...(failure && isCyberPolicyCode(failure.error.code)
      ? { retryable: false }
      : errorEvent?.retryable !== undefined ? { retryable: errorEvent.retryable } : {}),
    ...(incompleteEvent ? {
      incomplete_details: {
        reason: incompleteEvent.reason,
        ...(incompleteEvent.message ? { message: incompleteEvent.message } : {}),
        ...(incompleteEvent.retryable !== undefined ? { retryable: incompleteEvent.retryable } : {}),
      },
    } : stopReason === "max_tokens" ? {
      incomplete_details: { reason: "max_output_tokens" },
    } : stopReason === "content_filter" ? {
      incomplete_details: { reason: "content_filter" },
    } : !sawTerminal ? {
      // Same reason string the streaming path uses, so a caller sees one signal for one condition
      // regardless of which surface it asked for.
      incomplete_details: { reason: "adapter_eof" },
    } : {}),
    usage: responsesUsage(incompleteEvent?.usage ?? usage),
  };
}
