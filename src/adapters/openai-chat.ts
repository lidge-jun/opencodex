import { hasShrinkableOpenAIChatImages, normalizeOpenAIChatImages } from "./openai-chat-images";
import { chatParallelToolCallsWireValue } from "./openai-chat/parallel-tool-calls";
import { applyExplicitChatReasoningWirePolicy } from "./openai-chat/reasoning-wire";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../types";
import { modelInList } from "../types";
import { createInlineThinkContentSplitter, splitInlineThinkContent } from "./inline-think-tags";
import { mapReasoningEffort, modelRecordValue } from "../reasoning-effort";
import { debugProviderDiagnostic } from "../lib/debug";
import { sseFieldValue } from "../lib/sse-decoder";
import { isDebugEnabled } from "../lib/debug-settings";
import { openRouterProviderPayload, resolveOpenRouterRouting } from "../providers/openrouter-routing";
import { resolveVercelGatewayRouting, vercelGatewayProviderPayload } from "../providers/vercel-gateway-routing";
import { fastPolicyForModel } from "../providers/service-tier";
import { createAdapterTierMetadata, decideTier, type AdapterTierMetadata } from "../providers/fastwire";
import {
  isTranslatorBudgetExceededError,
  retainTranslatedEventBatch,
  TRANSLATOR_MAX_SSE_EVENT_BYTES,
  type TranslatorBudget,
} from "../lib/translator-budget";
import {
  isInvalidStreamStringField,
  isRecord,
  logInvalidToolCalls,
  type InvalidToolCallDiagnostic,
} from "./openai-chat/tool-call-validation";
import {
  createReasoningDetailSnapshotTracker,
  invalidChoicesEvent,
  invalidToolCallsEvent,
  reasoningDetailSegmentsFrom,
  reasoningTextFrom,
  stopReasonFor,
  unnamedToolCallEvent,
  usageFromOpenAIChat,
} from "./openai-chat/response-events";
import {
  formatOpenAIChatErrorBody,
  OpenAIChatError,
  unwrapChatCompletionPayload,
  upstreamErrorEvent,
} from "./openai-chat/errors";
import { messagesToChatFormat } from "./openai-chat/messages";
import { withOpenAIChatToolNames } from "./openai-chat/tool-name-registry";
import { openAIChatTransport, stripBracketedModelSuffix } from "./openai-chat/wire";
import { toolChoiceToChatFormat, toolsToChatFormatForProvider } from "./openai-chat/tool-schema";
import { reconcileSerializedToolCallEvents, reconcileStructuredToolCall, reconcileStructuredToolCalls, SerializedToolCallContentBuffer } from "./openai-chat/serialized-tool-call-content";

export { stripBracketedModelSuffix } from "./openai-chat/wire";
export { buildOpenAIChatPassthroughRequest } from "./openai-chat/passthrough";
export { formatOpenAIChatErrorBody } from "./openai-chat/errors";

function resolveMaxTokens(provider: OcxProviderConfig, parsed: OcxParsedRequest): number | undefined {
  return parsed.options.maxOutputTokens
    ?? modelRecordValue(provider.modelMaxOutputTokens, parsed.modelId)
    ?? provider.defaultMaxOutputTokens;
}

function thinkingBudgetForEffort(parsed: OcxParsedRequest, reasoningEffort: string, maxOutputTokens?: number): number | undefined {
  if (parsed.options.reasoning === "minimal") return 0;
  const maxBudget = maxOutputTokens ?? 32768;
  const fractions: Record<string, number> = {
    low: 0.20,
    medium: 0.50,
    high: 0.75,
    xhigh: 0.90,
    max: 1.0,
  };
  const fraction = fractions[reasoningEffort];
  return fraction === undefined ? undefined : Math.max(1, Math.floor(maxBudget * fraction));
}

function canSerializeOpenAIChatServiceTier(
  provider: OcxProviderConfig,
  modelId: string,
  serviceTier: unknown,
  tierDecision?: OcxParsedRequest["options"]["tierDecision"],
): boolean {
  if (serviceTier === undefined) return false;
  if (tierDecision !== undefined) {
    return tierDecision.kind === "set" || tierDecision.kind === "forward-caller";
  }
  // No decision from the router means this call did not go through the tier state machine, so
  // ask that machine rather than re-deriving a looser answer beside it. The previous fallback
  // returned true whenever foreign forwarding was allowed at all, which let a caller tier
  // reach the wire in cases `decideTier` would have dropped — the two paths disagreeing is
  // precisely the bug, so there is now only one authority.
  const callerTier = typeof serviceTier === "string" ? serviceTier : undefined;
  const decision = decideTier(fastPolicyForModel(provider, modelId, undefined, "chat"), undefined, callerTier);
  return decision.kind === "set" || decision.kind === "forward-caller";
}

export function createOpenAIChatAdapter(provider: OcxProviderConfig): ProviderAdapter {
  let lastRequestedModelId: string | undefined;
  let freeformToolsByWireName = new Map<string, { name: string; namespace?: string }>();
  return withOpenAIChatToolNames(toolNames => ({
    name: "openai-chat",

    formatErrorBody: formatOpenAIChatErrorBody,

    buildRequest(parsed: OcxParsedRequest, incoming?: IncomingMeta) {
      lastRequestedModelId = parsed.modelId;
      const { url, headers, hasCredential } = openAIChatTransport(provider);
      const messages = toolNames.messages(parsed, provider.baseUrl, messagesToChatFormat(parsed, provider));
      freeformToolsByWireName = new Map(parsed.context.tools?.filter(tool => tool.freeform)
        .map(tool => [toolNames.registry().alias(tool), { name: tool.name, namespace: tool.namespace }] as const) ?? []);
      const finish = (): AdapterRequest => {
        const tools = toolsToChatFormatForProvider(parsed, provider, toolNames.registry());
        const toolChoice = toolChoiceToChatFormat(parsed.options.toolChoice, parsed.context.tools, provider, toolNames.registry());

        const body: Record<string, unknown> = {
          model: provider.modelSuffixBracketStrip ? stripBracketedModelSuffix(parsed.modelId) : parsed.modelId,
          messages,
          stream: parsed.stream,
        };
        // A policy-produced canonical decision has already passed capability validation. Without
        // that decision, a canonical caller value still requires an explicit true capability;
        // unclassified Chat routes remain behind the caller-forwarding opt-in.
        const serviceTier = parsed.options.serviceTier;
        const tierDecision = parsed.options.tierDecision;
        const canSerializeServiceTier = canSerializeOpenAIChatServiceTier(
          provider,
          parsed.modelId,
          serviceTier,
          tierDecision,
        );
        if (canSerializeServiceTier && serviceTier !== undefined) {
          body.service_tier = serviceTier;
        }
        if (modelInList(provider.reasoningSplitModels, parsed.modelId)) body.reasoning_split = true;
        const maxTokens = resolveMaxTokens(provider, parsed);
        const openRouterRouting = resolveOpenRouterRouting(provider, parsed.modelId);
        if (openRouterRouting) body.provider = openRouterProviderPayload(openRouterRouting);
        const vercelRouting = resolveVercelGatewayRouting(provider, parsed.modelId);
        if (vercelRouting) body.provider = vercelGatewayProviderPayload(vercelRouting);
        if (tools) body.tools = tools;
        if (tools && toolChoice !== undefined) {
          body.tool_choice = modelInList(provider.autoToolChoiceOnlyModels, parsed.modelId)
            ? (toolChoice === "none" ? "none" : "auto")
            : toolChoice;
        }
        if (maxTokens !== undefined) body.max_tokens = maxTokens;
        if (parsed.options.temperature !== undefined && !modelInList(provider.noTemperatureModels, parsed.modelId)) {
          body.temperature = parsed.options.temperature;
        }
        if (parsed.options.topP !== undefined && !modelInList(provider.noTopPModels, parsed.modelId)) {
          body.top_p = parsed.options.topP;
        }
        if (parsed.options.stopSequences !== undefined && !modelInList(provider.noStopModels, parsed.modelId)) {
          body.stop = parsed.options.stopSequences;
        }
        const reasoningDisabled = modelInList(provider.noReasoningModels, parsed.modelId);
        const reasoningEffort = mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning);
        const explicitReasoning = applyExplicitChatReasoningWirePolicy({
          provider,
          modelId: parsed.modelId,
          hasTools: !!tools,
          requestedEffort: parsed.options.reasoning,
          wireEffort: reasoningEffort,
          reasoningDisabled,
          body,
        });
        let reasoningLog: AdapterRequest["reasoningLog"];
        if (explicitReasoning.handled) {
          reasoningLog = explicitReasoning.reasoningLog;
        } else if (reasoningEffort !== undefined) {
          if (modelInList(provider.thinkingBudgetModels, parsed.modelId)) {
            const budget = thinkingBudgetForEffort(parsed, reasoningEffort, maxTokens);
            if (budget !== undefined) {
              body.thinking_budget = budget;
              reasoningLog = {
                effectiveEffort: parsed.options.reasoning === "minimal" ? "minimal" : reasoningEffort,
                wireField: "thinking_budget",
                wireValue: budget,
              };
            }
          } else if (modelInList(provider.thinkingToggleModels, parsed.modelId)) {
            if (reasoningEffort === "enabled" || reasoningEffort === "disabled" || reasoningEffort === "adaptive") {
              body.thinking = { type: reasoningEffort };
              reasoningLog = {
                effectiveEffort: reasoningEffort,
                wireField: "thinking.type",
                wireValue: reasoningEffort,
              };
            }
          } else {
            body.reasoning_effort = reasoningEffort;
            reasoningLog = {
              effectiveEffort: reasoningEffort,
              wireField: "reasoning_effort",
              wireValue: reasoningEffort,
            };
          }
        }
        if (parsed.options.presencePenalty !== undefined && !modelInList(provider.noPenaltyModels, parsed.modelId)) {
          body.presence_penalty = parsed.options.presencePenalty;
        }
        if (parsed.options.frequencyPenalty !== undefined && !modelInList(provider.noPenaltyModels, parsed.modelId)) {
          body.frequency_penalty = parsed.options.frequencyPenalty;
        }
        if (provider.promptCacheKey && parsed.options.promptCacheKey !== undefined) {
          body.prompt_cache_key = parsed.options.promptCacheKey;
        }
        // Structured-output support varies by the physical upstream model even when one
        // gateway exposes a uniform OpenAI-compatible endpoint. Keep the #1137 translation
        // as the default, but let an exact model opt out instead of forcing a provider-wide
        // rollback that would silently return prose for siblings that support JSON Schema.
        if (!provider.noStructuredOutputModels?.includes(parsed.modelId)) {
          const textFormat = parsed.options.textFormat;
          if (textFormat?.type === "json_object") {
            body.response_format = { type: "json_object" };
          } else if (textFormat?.type === "json_schema") {
            // Same downgrade as the passthrough path: the schema is dropped because the
            // upstream rejects it, but the JSON-mode request itself survives.
            body.response_format = provider.noJsonSchemaModels?.includes(parsed.modelId)
              ? { type: "json_object" }
              : {
                type: "json_schema",
                json_schema: {
                  name: textFormat.name ?? "response",
                  ...(textFormat.description !== undefined ? { description: textFormat.description } : {}),
                  ...(textFormat.schema !== undefined ? { schema: textFormat.schema } : {}),
                  ...(textFormat.strict !== undefined ? { strict: textFormat.strict } : {}),
                },
              };
          }
        }

        if (tools) {
          const parallelToolCalls = chatParallelToolCallsWireValue(provider, parsed.options.parallelToolCalls);
          if (parallelToolCalls !== undefined) body.parallel_tool_calls = parallelToolCalls;
        }
        if (parsed.stream) body.stream_options = { include_usage: true };

        const bodyJson = JSON.stringify(body);
        const actualServiceTier = typeof body.service_tier === "string" ? body.service_tier : null;
        const tierLog = createAdapterTierMetadata(
          parsed.options.tierObservation,
          parsed.options.tierDecision,
          actualServiceTier === null ? null : "service-tier",
          actualServiceTier,
        );
        if (isDebugEnabled()) {
          let host = "upstream";
          try { host = new URL(url).host; } catch { /* keep fallback */ }
          debugProviderDiagnostic("openai-chat", "request", {
            host,
            model: body.model,
            stream: parsed.stream,
            messageCount: Array.isArray(messages) ? messages.length : 0,
            toolCount: Array.isArray(tools) ? tools.length : 0,
            hasCredential,
            bodyBytes: Buffer.byteLength(bodyJson, "utf8"),
          });
        }

        return {
          url,
          method: "POST",
          headers,
          body: bodyJson,
          ...(reasoningLog ? { reasoningLog } : {}),
          ...(tierLog ? { tierLog } : {}),
        };
      };
      if (hasShrinkableOpenAIChatImages(messages)) {
        const imageOptions = { tierBias: incoming?.imageTierBias, abortSignal: incoming?.abortSignal };
        return normalizeOpenAIChatImages(messages, imageOptions).then(finish, error => {
          if (incoming?.abortSignal?.aborted) throw error;
          return finish();
        });
      }
      return finish();
    },

    async *parseStream(
      response: Response,
      budget: TranslatorBudget,
      tierMetadata?: AdapterTierMetadata,
    ): AsyncGenerator<AdapterEvent> {
      if (!response.body) {
        yield { type: "error", message: "No response body" };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const budgetEncoder = new TextEncoder();
      let buffer = "";
      let bufferBytes = 0;
      interface PendingToolCall {
        key: string;
        indexKey?: string;
        id: string;
        name: string;
        args: string;
        argsBytes: number;
        /**
         * Whether this call has ever received `arguments` as an actual string, empty included.
         * An empty string still counts: it proves the upstream sent the field with the right
         * wire type, which is what a later malformed repeat of that field would be padding for.
         * A canonical NAME is not evidence about the ARGUMENTS field and must not stand in.
         */
        sawArgumentsString: boolean;
      }
      const pendingToolCalls: PendingToolCall[] = [];
      const toolCallContent = new SerializedToolCallContentBuffer(budget);
      const heldText = (): AdapterEvent[] => toolCallContent.drain([]);
      let toolCallSeq = 0;
      const closeToolCalls = (): PendingToolCall[] => {
        const calls = [...pendingToolCalls];
        for (const call of calls) budget.closeCall(call.key);
        pendingToolCalls.length = 0;
        return calls;
      };
      const pendingToolCallsAreCompleteJsonObjects = (): boolean =>
        pendingToolCalls.length > 0 && pendingToolCalls.every(call => {
          if (call.name.trim().length === 0 || !call.sawArgumentsString || call.args.length === 0) return false;
          try {
            const parsed = JSON.parse(reconcileStructuredToolCall(call.name, toolNames.restore(call.name), call.args, toolCallContent.current()).argumentsText) as unknown;
            return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
          } catch {
            return false;
          }
        });
      // Returns "terminate" when a pending call cannot be dispatched, so every flush site
      // stops the turn instead of emitting an unusable call. `closeToolCalls()` runs first,
      // so budget reservations are released for every pending call even on the early return.
      const flushToolCalls = function* (): Generator<AdapterEvent, "continue" | "terminate"> {
        const calls = closeToolCalls();
        for (const call of calls) {
          // Ingest already proved `name` is a string; the typeof guard keeps this branch
          // total so a future ingest change cannot turn a malformed name into a throw.
          if (typeof call.name !== "string" || call.name.trim().length === 0) {
            debugProviderDiagnostic("openai-chat", "tool-call-unnamed", {
              hadId: call.id.length > 0,
              argsBytes: call.argsBytes,
            });
            return yield* terminateWithError(unnamedToolCallEvent(pendingUsage));
          }
        }
        // Held markup is released only now, as one batch per response: the doubled-input repair needs every call.
        const references = reconcileStructuredToolCalls(calls.map(call => ({ wireName: call.name, restoredName: toolNames.restore(call.name), argumentsText: call.args, freeformTool: freeformToolsByWireName.get(call.name) })), toolCallContent.current());
        calls.forEach((call, index) => { call.args = references[index]!.argumentsText; });
        yield* toolCallContent.drain(references);
        for (const call of calls) {
          if (!call.id) call.id = `call_${++toolCallSeq}`;
          yield { type: "tool_call_start", id: call.id, name: toolNames.restore(call.name) };
          if (call.args.length > 0) yield { type: "tool_call_delta", arguments: call.args };
          yield { type: "tool_call_end" };
        }
        return "continue";
      };
      const terminateWithError = function* (
        event: Extract<AdapterEvent, { type: "error" }>,
      ): Generator<AdapterEvent, "terminate"> {
        closeToolCalls();
        yield* heldText(); // Pending tools are not dispatched, so held text stays visible.
        yield event;
        return "terminate";
      };
      let pendingUsage: OcxUsage | undefined;
      let finishReason: string | undefined;
      let sawUserFacingOutput = false;
      // MiniMax-style structured reasoning: each stream chunk repeats a detail's
      // full text-so-far, so deltas are derived by prefix-diffing per segment key.
      // A piece that does not extend the previous snapshot is appended whole, which
      // keeps incremental senders parseable on the same path.
      const reasoningDetailTracker = createReasoningDetailSnapshotTracker(budget);
      // Gate on the routed model, not list length: a mixed openai-chat provider
      // can list MiniMax ids without putting every sibling on MiniMax semantics.
      const reasoningDetailsOptIn = modelInList(provider.reasoningDetailsModels, lastRequestedModelId ?? "");
      // A gateway with no server-side reasoning parser leaves thinking inline in `content` as
      // <think> blocks, which would otherwise render as the answer. Passthrough unless opted in.
      const inlineThink = createInlineThinkContentSplitter(provider.inlineThinkTagModels, lastRequestedModelId, budget);
      const emitContent = function* (events: AdapterEvent[]): Generator<AdapterEvent> {
        for (const event of events) {
          // Any other event keeps its place behind held text instead of overtaking it.
          if (event.type !== "text_delta") { yield* toolCallContent.hold(event); continue; }
          sawUserFacingOutput = true;
          const released = toolCallContent.ingestStreaming(event.text);
          yield* released.length > 0 ? released : [{ type: "heartbeat" } as AdapterEvent];
        }
      };

      const handleDataLine = function* (line: string): Generator<AdapterEvent, "continue" | "terminate"> {
        const rawPayload = sseFieldValue(line, "data");
        if (rawPayload === null) return "continue";
        const payload = rawPayload.trim();
        if (payload.length === 0) return "continue";
        if (payload === "[DONE]") {
          yield* emitContent(inlineThink.flush());
          if ((yield* flushToolCalls()) === "terminate") return "terminate";
          const stopReason = stopReasonFor(finishReason);
          yield { type: "done", usage: pendingUsage, ...(stopReason ? { stopReason } : {}) };
          return "terminate";
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          tierMetadata?.markResponseUnparseable();
          return yield* terminateWithError({ type: "error", message: "malformed upstream SSE data frame" });
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "continue";
        const chunk = parsed as Record<string, unknown>;
        if (Object.hasOwn(chunk, "service_tier")) {
          tierMetadata?.observeResponseServiceTier(chunk.service_tier);
        }

        if (chunk.error !== undefined && chunk.error !== null) {
          const event = upstreamErrorEvent(chunk.error, pendingUsage);
          debugProviderDiagnostic("openai-chat", "stream-error", { message: event.message });
          return yield* terminateWithError(event);
        }

        if (chunk.usage) pendingUsage = usageFromOpenAIChat(chunk.usage as Record<string, unknown>);

        const choices = chunk.choices;
        if (choices === undefined) return "continue";
        if (!Array.isArray(choices)) return yield* terminateWithError(invalidChoicesEvent(pendingUsage));
        if (choices.length === 0) return "continue";
        const rawChoice = choices[0];
        if (rawChoice === null || typeof rawChoice !== "object" || Array.isArray(rawChoice)) {
          return yield* terminateWithError(invalidChoicesEvent(pendingUsage));
        }
        const choice = rawChoice as {
          delta?: Record<string, unknown>;
          finish_reason?: string;
          error?: unknown;
        };
        if (choice.finish_reason === "error") {
          const event = upstreamErrorEvent(choice.error, pendingUsage);
          debugProviderDiagnostic("openai-chat", "stream-error", { message: event.message });
          return yield* terminateWithError(event);
        }
        if (typeof choice.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (delta) {
          const detailSegments = reasoningDetailsOptIn ? reasoningDetailSegmentsFrom(delta) : [];
          if (detailSegments.length > 0) {
            for (const segment of detailSegments) {
              const reasoningDelta = reasoningDetailTracker.ingest(segment);
              if (reasoningDelta !== null) yield* toolCallContent.hold({ type: "reasoning_raw_delta", text: reasoningDelta });
            }
          } else {
            const reasoningText = reasoningTextFrom(delta);
            if (reasoningText !== undefined) yield* toolCallContent.hold({ type: "reasoning_raw_delta", text: reasoningText });
          }
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield* emitContent(inlineThink.feed(delta.content));
          }

          const rawToolCalls = delta.tool_calls;
          if (rawToolCalls !== undefined && rawToolCalls !== null) {
            // A non-null claimed tool-call payload is not benign padding. Dropping it can leave the
            // matching result permanently orphaned, so malformed nested shapes fail closed
            // through the adapter error channel instead of escaping as TypeError (#1325). Null is
            // tolerated as absent because OpenAI-compatible providers may emit it as stream padding.
            if (!Array.isArray(rawToolCalls)) {
              logInvalidToolCalls("stream", rawToolCalls);
              return yield* terminateWithError(invalidToolCallsEvent(rawToolCalls, "stream", pendingUsage));
            }
            for (let callIndex = 0; callIndex < rawToolCalls.length; callIndex++) {
              const rawToolCall: unknown = rawToolCalls[callIndex];
              if (!isRecord(rawToolCall)) {
                const diagnostic: InvalidToolCallDiagnostic = {
                  reason: "tool_call_not_object",
                  callIndex,
                  valueType: rawToolCall === null ? "null" : Array.isArray(rawToolCall) ? "array" : typeof rawToolCall,
                };
                logInvalidToolCalls("stream", rawToolCalls, diagnostic);
                return yield* terminateWithError(invalidToolCallsEvent(rawToolCalls, "stream", pendingUsage, diagnostic));
              }
              // This is upstream JSON, so every field is validated before it is stored: a
              // malformed value must fail closed through the #1325 channel here rather than
              // escaping later as a TypeError from string handling at flush time.
              const rawFunction = rawToolCall.function;
              if (rawFunction !== undefined && rawFunction !== null && !isRecord(rawFunction)) {
                const diagnostic: InvalidToolCallDiagnostic = {
                  reason: "tool_call_function_not_object",
                  callIndex,
                  valueType: Array.isArray(rawFunction) ? "array" : typeof rawFunction,
                };
                logInvalidToolCalls("stream", rawToolCalls, diagnostic);
                return yield* terminateWithError(invalidToolCallsEvent(rawToolCalls, "stream", pendingUsage, diagnostic));
              }
              const fnRecord = isRecord(rawFunction) ? rawFunction : undefined;
              const rawName = fnRecord?.name;
              const rawArguments = fnRecord?.arguments;
              const rawId = rawToolCall.id;
              const idDelta = typeof rawId === "string" ? rawId : "";
              const rawIndex = rawToolCall.index;
              // Only missing/null indexes are absent; every claimed index must be valid.
              // Unsafe integers can collapse distinct wire indexes onto the same JS number.
              // Reject before an alias can bind or any pending call can consume the fragment.
              if (rawIndex !== undefined && rawIndex !== null
                  && (typeof rawIndex !== "number"
                    || !Number.isSafeInteger(rawIndex)
                    || rawIndex < 0)) {
                return yield* terminateWithError({
                  ...invalidToolCallsEvent(rawToolCalls, "stream", pendingUsage),
                  message: "upstream response contained invalid tool calls (invalid index)",
                });
              }

              // Resolve the pending call BEFORE judging repeated string fields. Some OpenAI-compatible
              // streamers repeat an already-sent field as a non-string placeholder on a
              // continuation delta; judging first meant the whole stream died with a 502 even
              // though the value being repeated was already held in canonical form.
              const indexKey = typeof rawIndex === "number" ? `i:${rawIndex}` : undefined;
              const key = indexKey ?? (idDelta
                ? `id:${idDelta}`
                : pendingToolCalls[pendingToolCalls.length - 1]?.key);
              let call = key !== undefined ? pendingToolCalls.find(c => c.key === key) : undefined;
              if (!call && indexKey !== undefined) call = pendingToolCalls.find(c => c.indexKey === indexKey);
              if (!call && idDelta) call = pendingToolCalls.find(c => c.id === idDelta);
              if (!call) {
                call = {
                  key: key ?? `seq:${pendingToolCalls.length}`,
                  id: "",
                  name: "",
                  args: "",
                  argsBytes: 0,
                  sawArgumentsString: false,
                };
                pendingToolCalls.push(call);
                budget.openCall(call.key);
              }
              // An ID-only call may learn its index from a later ID+index fragment. Retain that
              // alias without changing the key that owns its argument budget. Only the first
              // observed index binds: a repeated ID on a different index must not alias both.
              if (indexKey !== undefined && call.indexKey === undefined) call.indexKey = indexKey;

              // Tolerance is per FIELD, keyed on that field's own provenance. A canonical name
              // says nothing about whether `arguments` was ever sent as a string, so it cannot
              // authorize a malformed arguments value — that would silently drop a real
              // argument payload the model intended to send.
              const rejection: InvalidToolCallDiagnostic | undefined =
                isInvalidStreamStringField(rawName) && call.name.trim() === ""
                  ? { reason: "tool_call_function_name_invalid", callIndex, valueType: typeof rawName }
                  : isInvalidStreamStringField(rawArguments) && !call.sawArgumentsString
                    ? { reason: "tool_call_function_arguments_invalid", callIndex, valueType: typeof rawArguments }
                    : isInvalidStreamStringField(rawId) && call.id === ""
                      ? { reason: "tool_call_id_invalid", callIndex, valueType: typeof rawId }
                      : undefined;
              if (rejection) {
                logInvalidToolCalls("stream", rawToolCalls, rejection);
                return yield* terminateWithError(invalidToolCallsEvent(rawToolCalls, "stream", pendingUsage, rejection));
              }

              if (idDelta && !call.id) call.id = idDelta;
              if (typeof rawName === "string" && rawName && !call.name) call.name = rawName;
              if (typeof rawArguments === "string") call.sawArgumentsString = true;
              // Tool-call deltas are BUFFERED until a terminal signal, so this adapter can
              // consume upstream frames for a long time while yielding nothing. The Responses
              // bridge reads adapter activity, not socket activity, so a model that streams a
              // large argument payload looks identical to a hung upstream and the stall
              // watchdog can abort a turn that was progressing normally.
              //
              // Found while investigating #2156, but it is NOT that bug: a stall abort emits
              // `response.incomplete` with `upstream_stall_timeout` from the bridge, whereas
              // that report shows the adapter's own end-of-stream error after `reader.read()`
              // returned EOF with tool calls still pending. Different path, different frame.
              //
              // A heartbeat is invisible downstream — the bridge consumes it to re-arm the
              // watchdog and emits nothing — which is the same remedy the Cursor, Anthropic,
              // Google, and Kiro adapters already use for their own silent phases.
              yield { type: "heartbeat" };
              if (typeof rawArguments === "string" && rawArguments) {
                const previousBytes = call.argsBytes;
                const nextBytes = previousBytes + budgetEncoder.encode(rawArguments).byteLength;
                const scope = { kind: "tool_args" as const, callId: call.key };
                const reservation = budget.reserveTransient(nextBytes, scope);
                try {
                  call.args += rawArguments;
                  reservation.commitRetained();
                  budget.releaseRetained(previousBytes, scope);
                  call.argsBytes = nextBytes;
                } catch (error) {
                  reservation.release();
                  throw error;
                }
              }
            }
          }
        }

        if (typeof choice.finish_reason === "string" && choice.finish_reason) {
          yield* emitContent(inlineThink.flush());
          if ((yield* flushToolCalls()) === "terminate") return "terminate";
        }
        return "continue";
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const decoded = decoder.decode(value, { stream: true });
          const nextBufferBytes = bufferBytes + budgetEncoder.encode(decoded).byteLength;
          if (nextBufferBytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) {
            throw new Error(`translation SSE event exceeded ${TRANSLATOR_MAX_SSE_EVENT_BYTES} bytes`, {
              cause: { code: "translation_buffer_limit" },
            });
          }
          const appendReservation = budget.reserveTransient(nextBufferBytes, { kind: "live_transient" });
          try {
            buffer += decoded;
            appendReservation.commitRetained();
            budget.releaseRetained(bufferBytes, { kind: "live_transient" });
          } catch (error) {
            appendReservation.release();
            throw error;
          }
          bufferBytes = nextBufferBytes;

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          const residualBytes = budgetEncoder.encode(buffer).byteLength;
          const residualReservation = budget.reserveTransient(residualBytes, { kind: "live_transient" });
          residualReservation.commitRetained();
          budget.releaseRetained(bufferBytes, { kind: "live_transient" });
          bufferBytes = residualBytes;

          for (const line of lines) {
            if ((yield* handleDataLine(line)) === "terminate") return;
          }
        }

        if (buffer.length > 0) {
          if ((yield* handleDataLine(buffer)) === "terminate") return;
        }
        yield* emitContent(inlineThink.flush());
        const sawFinish = finishReason !== undefined;
        if (!sawFinish && pendingToolCalls.length > 0) {
          // Some OpenAI-compatible gateways close immediately after a complete function-call
          // delta and omit both terminal conventions. Keep the default fail-closed policy, and
          // let an opted-in provider recover only calls whose assembled argument payload is a
          // complete JSON object. A partial JSON prefix still takes the truncation path below.
          if (provider.openaiChatEofTolerance === true && pendingToolCallsAreCompleteJsonObjects()) {
            if ((yield* flushToolCalls()) === "terminate") return;
            yield { type: "done", usage: pendingUsage };
            return;
          }
          debugProviderDiagnostic("openai-chat", "stream-truncated", {
            finishReason: null,
            hadUsage: pendingUsage !== undefined,
            pendingToolCalls: pendingToolCalls.length,
          });
          yield* terminateWithError({ type: "error", message: "upstream stream ended mid tool call without a terminal signal — possible truncation" });
          return;
        }
        if (!sawFinish && !sawUserFacingOutput) {
          debugProviderDiagnostic("openai-chat", "stream-truncated", {
            finishReason: finishReason ?? null,
            hadUsage: pendingUsage !== undefined,
          });
          yield* terminateWithError({ type: "error", message: "upstream stream ended without a terminal signal ([DONE] or finish_reason) — possible truncation" });
          return;
        }
        if ((yield* flushToolCalls()) === "terminate") return;
        const stopReason = stopReasonFor(finishReason);
        yield { type: "done", usage: pendingUsage, ...(stopReason ? { stopReason } : {}) };
      } catch (error) {
        closeToolCalls();
        yield* heldText();
        if (isTranslatorBudgetExceededError(error)
          || (error instanceof Error && (error.cause as { code?: unknown } | undefined)?.code === "translation_buffer_limit")) {
          yield {
            type: "error",
            status: 502,
            errorType: "upstream_error",
            code: "translation_buffer_limit",
            message: "upstream translation buffer exceeded the safe limit",
          };
          try { await reader.cancel(error); } catch { /* already closed */ }
          return;
        }
        throw error;
      } finally {
        budget.releaseRetained(bufferBytes, { kind: "live_transient" });
        reasoningDetailTracker.release();
        inlineThink.dispose();
        toolCallContent.dispose();
        closeToolCalls();
        reader.releaseLock();
      }
    },

    async parseResponse(
      response: Response,
      budget: TranslatorBudget,
      tierMetadata?: AdapterTierMetadata,
    ): Promise<AdapterEvent[]> {
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (error) {
        tierMetadata?.markResponseUnparseable();
        throw error;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        tierMetadata?.markResponseUnparseable();
        throw new Error("upstream response was not a JSON object");
      }
      const json = parsed as Record<string, unknown>;
      if (Object.hasOwn(json, "service_tier")) {
        tierMetadata?.observeResponseServiceTier(json.service_tier);
      }
      const responseBytes = Buffer.byteLength(JSON.stringify(json), "utf8");
      budget.chargeRetained(responseBytes, { kind: "retained_collectors" });
      try {
        const payload = unwrapChatCompletionPayload(json);
        const usage = usageFromOpenAIChat(payload.usage as Record<string, unknown> | undefined);
        if (json.success === false && payload.error === undefined) {
          return [{
            type: "error",
            message: "upstream reported failure without an error payload",
            ...(usage ? { usage } : {}),
          }];
        }
        if (payload.error !== undefined && payload.error !== null) return [upstreamErrorEvent(payload.error, usage)];

        const events: AdapterEvent[] = [];
        const choices = payload.choices as {
          message?: Record<string, unknown>;
          finish_reason?: unknown;
          error?: OpenAIChatError;
        }[] | undefined;
        if (!Array.isArray(choices) || choices.length === 0) {
          return [{ type: "error", message: "upstream response contained no choices", ...(usage ? { usage } : {}) }];
        }
        const rawChoice = choices[0];
        if (rawChoice === null || typeof rawChoice !== "object" || Array.isArray(rawChoice)) {
          return [invalidChoicesEvent(usage)];
        }
        const choice = rawChoice;
        if (choice.finish_reason === "error") return [upstreamErrorEvent(choice.error, usage)];
        if (!choice.message) return [{ type: "error", message: "upstream response contained no choices", ...(usage ? { usage } : {}) }];
        // `!choice.message` splits this input class on TRUTHINESS, not on shape: `null` and `0` fail
        // closed here, while `"text"`, `true` and `[{...}]` pass and every property read below yields
        // `undefined` — so a choice claiming an assistant message completed as a SUCCESSFUL EMPTY
        // turn, stranding any tool call it claimed. The one line above already validates the choice
        // container this way; its message was left on a truthiness test.
        //
        // Every non-record is rejected, arrays included. The google adapter does carve out `[]` for
        // `content`, but that carve-out is specific to a protobuf-derived wire where a repeated
        // field can spell an empty message — and `content` is genuinely an ARRAY of blocks there.
        // `message` is a record on a plain-JSON wire that already has `{}`, so importing the
        // exception would be an analogy rather than evidence. `[{"content":"…"}]` is the case that
        // matters: it discards a complete answer, #2232's `content: [{ parts: [...] }]` one adapter over.
        //
        // Read through `unknown` rather than the declared type: `choices` is a cast over wire data,
        // so its `message?: Record<string, unknown>` is an assertion the upstream never made, and
        // narrowing against it is what let the missing check look type-safe.
        const rawMessage: unknown = choice.message;
        if (!isRecord(rawMessage)) {
          return [invalidChoicesEvent(usage)];
        }

        const msg = rawMessage as Record<string, unknown>;
        let reasoningText = reasoningTextFrom(msg);
        if (reasoningText === undefined && modelInList(provider.reasoningDetailsModels, lastRequestedModelId ?? "")) {
          // MiniMax split-reasoning responses carry the same thinking in both
          // reasoning_content and reasoning_details; the array is the fallback
          // when only the structured form arrives.
          const segments = reasoningDetailSegmentsFrom(msg);
          if (segments.length > 0) reasoningText = segments.map(s => s.text).join("");
        }
        if (reasoningText !== undefined) events.push({ type: "reasoning_raw_delta", text: reasoningText });
        const contentStart = events.length;
        if (typeof msg.content === "string") events.push(...splitInlineThinkContent(provider.inlineThinkTagModels, lastRequestedModelId, budget, msg.content));
        const contentEnd = events.length;
        const answerText = events.slice(contentStart).map(event => (event.type === "text_delta" ? event.text : "")).join("");
        // Each call holds the delta event it emitted, so the batch repair sets its arguments later.
        const structuredCalls: { wireName: string; restoredName: string; argumentsText: string; freeformTool?: { name: string; namespace?: string }; delta: Extract<AdapterEvent, { type: "tool_call_delta" }> }[] = [];
        const rawToolCalls = msg.tool_calls;
        if (rawToolCalls !== undefined && rawToolCalls !== null) {
          if (!Array.isArray(rawToolCalls)) {
            logInvalidToolCalls("response", rawToolCalls);
            return [invalidToolCallsEvent(rawToolCalls, "response", usage)];
          }
          for (const rawToolCall of rawToolCalls) {
            if (!isRecord(rawToolCall) || !isRecord(rawToolCall.function)) {
              logInvalidToolCalls("response", rawToolCalls);
              return [invalidToolCallsEvent(rawToolCalls, "response", usage)];
            }
            const id = rawToolCall.id;
            const name = rawToolCall.function.name;
            const args = rawToolCall.function.arguments;
            // A blank name is as undispatchable as a missing one, so it fails closed here
            // for the same reason the streamed path refuses it. Trimmed length, not `!name`:
            // a whitespace-only function name is not a legitimate tool-call shape either.
            if (typeof id !== "string" || typeof name !== "string" || typeof args !== "string"
              || name.trim().length === 0) {
              logInvalidToolCalls("response", rawToolCalls);
              return [invalidToolCallsEvent(rawToolCalls, "response", usage)];
            }
            const delta: Extract<AdapterEvent, { type: "tool_call_delta" }> = { type: "tool_call_delta", arguments: args };
            structuredCalls.push({ wireName: name, restoredName: toolNames.restore(name), argumentsText: args, freeformTool: freeformToolsByWireName.get(name), delta });
            events.push({ type: "tool_call_start", id, name: toolNames.restore(name) }, delta, { type: "tool_call_end" });
          }
        }
        const references = reconcileStructuredToolCalls(structuredCalls, answerText);
        structuredCalls.forEach((call, index) => { call.delta.arguments = references[index]!.argumentsText; });
        reconcileSerializedToolCallEvents(events, contentStart, contentEnd, references, budget);
        const stopReason = stopReasonFor(choice.finish_reason);
        events.push({
          type: "done",
          usage,
          ...(stopReason ? { stopReason } : {}),
        });
        retainTranslatedEventBatch(events, budget);
        return events;
      } finally {
        budget.releaseRetained(responseBytes, { kind: "retained_collectors" });
      }
    },
  }));
}
