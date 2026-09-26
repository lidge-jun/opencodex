import { normalizeRoutedAgentMessages } from "../routed-agent-messages";
import { nameRoutedIdentity, repairIdentityInResponsesBody, stripRoutedIdentity } from "../identity";
import { stripBracketedModelSuffix } from "../openai-chat";
import { normalizeOpenCodeGoAdditionalTools } from "../opencode-go-additional-tools";
import { isXaiResponsesDestination } from "../../providers/xai-transport";
import { Buffer } from "node:buffer";
import type { IncomingMeta, ProviderAdapter } from "../base";
import { namespacedToolName, type AdapterEvent, type OcxParsedRequest, type OcxProviderConfig, type OcxUsage, type TierDecision } from "../../types";
import { applyCodexRoutingHint, CODEX_RESPONSES_LITE_HEADER, CODEX_ROUTING_HINT_HEADER } from "../../codex/forward-transport-headers";
import { COMPACT_PROMPT, compactionItemToText, decodeCompactionSummary, isCompactionItemType } from "../../responses/compaction";
import { decodeServerSentEvents } from "../../lib/sse-decoder";
import {
  CODEX_FORWARD_BASE_URL,
  destinationDecodesNativeCompactionBlob,
  isCanonicalOpenAiForwardProvider,
  isOpenAiOperatedResponsesDestination,
} from "../../providers/openai-tiers";
import type { TranslatorBudget } from "../../lib/translator-budget";
import { rewriteRoutedCustomToolsForUpstream, validateFinalCustomToolCompatibility } from "../../responses/custom-tool-compat";
import { rewriteRoutedToolSearchForUpstream } from "../../responses/tool-search-compat";
import { rewriteRoutedNamespaceToolsForUpstream } from "../../responses/namespace-tool-compat";
import { repairLegacyDottedToolCallNames } from "../../responses/legacy-dotted-tool-name-repair";
import { preparePlaintextV2AgentMessages } from "../../responses/plaintext-v2-agent-messages";
import { isMetaAiResponsesDestination, rewriteMuseToolNamesForUpstream } from "../../responses/muse-tool-name-alias";
import { openaiResponsesUrl } from "../openai-responses-url";
import { normalizeResponsesCodeMode } from "../responses-code-mode";
import { injectXaiResponsesXSearch, normalizeXaiResponsesWebSearch } from "../xai-web-search";
import {
  isXaiSchemaTarget,
  normalizeXaiToolParameters,
  XaiToolSchemaCompatibilityError,
} from "../xai-tool-schema";
import {
  createAdapterTierMetadata,
} from "../../providers/fastwire";
import { dropResponsesReasoningInputItems, mapRoutedResponsesReasoningEffort, normalizeConfiguredReasoningSummaryDelivery, sanitizeReasoningInputContent, stripDisabledReasoningSummaries, stripDisabledVerbosity, stripUnsupportedReasoningSummaryDelivery } from "./reasoning";
import { scrubOcxCompactionItems, stripCanonicalOnlyToolFields, stripCanonicalOnlyTopLevelFields, stripInternalChatMessageMetadataPassthrough, stripInvalidItemIds, stripItemIdsWhenUnstored, stripRejectedSamplingParams } from "./request-strips";
import { stripCanonicalForwardPromptCacheOptions, stripDeprecatedPromptCacheRetention } from "./prompt-cache";
import { isPlainObject } from "./internal";
import { normalizeToolSchemas, promoteClientLoadedTools, stripUnsupportedHostedTools } from "./tool-schema";
import { annotateEmptyResponsesToolOutputs, backfillWebSearchQueries, normalizeResponsesToolResultAdjacency, repairOrphanedInputItems, repairOversizedReplayCallIds, repairUnidentifiedToolOutputItems, restoreBridgedWebSearchCalls } from "./tool-output-recovery";
import { bridgeSearchReplayScope } from "../../responses/bridge-search-replay-cache";
import { applyTierDecisionToResponsesBody, normalizeCanonicalForwardContinuationEnvelope, normalizeCanonicalForwardPromptEnvelope, stripCanonicalForwardSamplingParams, stripPreviousResponseId, stripStatefulResponsesParams, stripUnsupportedForwardParams } from "./canonical-forward";
import { normalizeImageGenClientTools, preferConfiguredHostedTools } from "./image-gen";
import { stripMuseSparkUnsupportedWebSearchFields, stripOpenAiOnlyWebSearchFields } from "./web-search";
import { applyZenFreeIdentity, isZenFreeEndpoint } from "../opencode-free-session";
import { withZenFreeGateDeclarations, zenFreeGateResponsesTool } from "../opencode-free-tools";
import { observeOutbound } from "../../usage/cache-diagnostic";
import { normalizeMuseToolChoice } from "./muse-tool-choice";

/**
 * Identifies DeepSeek's strict Responses replay contract: tool-bearing continuations need
 * plaintext reasoning and cannot consume opaque reasoning state. The two existing flags are
 * current evidence for that one provider contract, not equivalent capabilities: preservation
 * keeps plaintext reasoning on the wire, while adjacency marks its strict tool-history shape.
 * The moment a second provider needs this behavior, replace this derivation with an explicit
 * registry capability rather than extending the inference.
 */
export function requiresPlaintextReasoningReplay(provider: OcxProviderConfig): boolean {
  return provider.preserveResponsesReasoningContent === true
    && provider.requiresAdjacentResponsesToolResults === true;
}

// Headers relayed verbatim from the caller in OAuth-passthrough ("forward") mode.
// Exported so the web-search sidecar reuses the exact same forwarded-auth set for its ChatGPT call.
export const FORWARD_HEADERS = [
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
  CODEX_RESPONSES_LITE_HEADER,
];

/** Preserve the caller fingerprint unless the provider explicitly owns that header. */
function applyCallerUserAgentFallback(
  headers: Record<string, string>,
  incoming: IncomingMeta,
): void {
  if (Object.keys(headers).some(name => name.toLowerCase() === "user-agent")) return;
  const userAgent = incoming.headers.get("user-agent");
  if (userAgent) headers["User-Agent"] = userAgent;
}

/** Replace every `input_image` part under a routed-compaction body with a short marker. */
function stripInputImagesDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInputImagesDeep);
  if (!isPlainObject(value)) return value;
  if (value.type === "input_image") {
    return { type: "input_text", text: "[image omitted for compaction]" };
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = stripInputImagesDeep(entry);
  return out;
}

/**
 * Rewrite a compaction turn for an upstream that does not speak Codex's private
 * `compaction_trigger` item: drop the trigger and the whole tool surface, and ask
 * for the handoff summary in plain terms instead (#422).
 *
 * The adapter builds from `parsed._rawBody`, so the summarizer prompt that
 * handleResponses() pushed onto `parsed.context` never reaches the wire — it has to
 * be applied here. Images go too: a summary needs no pixels, and a text-only
 * gateway would reject them.
 */
function buildRoutedCompactionBody(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  // `text` goes with the tool fields: the summary must be prose, not schema-constrained JSON.
  const { tools: _tools, tool_choice: _toolChoice, parallel_tool_calls: _parallel, text: _text, ...rest } = body;
  const input = Array.isArray(body.input) ? body.input : [];
  const kept = input.filter(item => !isPlainObject(item)
    // `additional_tools` is how Codex Desktop's responses-lite shape carries tools;
    // leaving it in would break the no-tools invariant even with `tools` removed.
    || (item.type !== "compaction_trigger" && item.type !== "additional_tools"));
  return {
    ...rest,
    input: [
      ...(stripInputImagesDeep(kept) as unknown[]),
      { type: "message", role: "user", content: [{ type: "input_text", text: COMPACT_PROMPT }] },
    ],
  };
}

/** Read the Responses `usage` block, if the gateway sent one. */
function usageFromResponsesPayload(payload: unknown): OcxUsage | undefined {
  if (!isPlainObject(payload) || !isPlainObject(payload.usage)) return undefined;
  const usage = payload.usage;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  // openai/codex#41980: the raw usage object is wire data a rebuilt response.completed must keep —
  // unknown keys (subscription metadata, future counters) ride along even when the token counts
  // themselves are zero or absent (metadata-only usage).
  const knownKeys = new Set(["input_tokens", "output_tokens", "total_tokens", "input_tokens_details", "output_tokens_details"]);
  const hasExtras = Object.keys(usage).some(key => !knownKeys.has(key))
    || (isPlainObject(usage.input_tokens_details)
      && Object.keys(usage.input_tokens_details).some(key => key !== "cached_tokens" && key !== "cache_write_tokens"))
    || (isPlainObject(usage.output_tokens_details)
      && Object.keys(usage.output_tokens_details).some(key => key !== "reasoning_tokens"));
  if (inputTokens === 0 && outputTokens === 0 && !hasExtras) return undefined;
  const inputDetails = isPlainObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const outputDetails = isPlainObject(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  return {
    inputTokens,
    outputTokens,
    ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
    ...(typeof inputDetails?.cached_tokens === "number" ? { cachedInputTokens: inputDetails.cached_tokens } : {}),
    ...(typeof inputDetails?.cache_write_tokens === "number" ? { cacheCreationInputTokens: inputDetails.cache_write_tokens } : {}),
    ...(typeof outputDetails?.reasoning_tokens === "number" ? { reasoningOutputTokens: outputDetails.reasoning_tokens } : {}),
    ...(hasExtras ? { rawUsage: { ...usage } } : {}),
  };
}

function responsesPayloadText(response: unknown): string {
  if (!isPlainObject(response) || !Array.isArray(response.output)) return "";
  return response.output
    .filter(item => isPlainObject(item) && item.type === "message")
    .flatMap(item => (Array.isArray((item as Record<string, unknown>).content)
      ? (item as { content: unknown[] }).content
      : []))
    .filter(part => isPlainObject(part) && part.type === "output_text")
    .map(part => String((part as { text?: unknown }).text ?? ""))
    .join("");
}

function responsesErrorMessage(payload: unknown): string {
  if (!isPlainObject(payload)) return "upstream compaction failed";
  const err = payload.error;
  if (typeof err === "string") return err;
  if (isPlainObject(err) && typeof err.message === "string") return err.message;
  const incomplete = payload.incomplete_details;
  if (isPlainObject(incomplete) && typeof incomplete.reason === "string") return incomplete.reason;
  return "upstream compaction failed";
}

/** Count an append without rescanning accumulated text, including split surrogate pairs. */
function appendedUtf8Bytes(previousBytes: number, lastCodeUnit: number, fragment: string): number {
  const first = fragment.charCodeAt(0);
  // Separate lone surrogates each count as a three-byte replacement character; together
  // they encode as one four-byte scalar. Empty fragments produce NaN and never pair.
  const joinsSurrogatePair = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff && first >= 0xdc00 && first <= 0xdfff;
  return previousBytes + Buffer.byteLength(fragment, "utf8") - (joinsSurrogatePair ? 2 : 0);
}

export function createResponsesPassthroughAdapter(provider: OcxProviderConfig): ProviderAdapter & { passthrough: true } {
  return {
    name: "openai-responses",
    passthrough: true as const,

    buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta) {
      const translatorBudget = incoming.translatorBudget;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let url: string;

      if (provider.authMode === "forward") {
        const mayForwardCallerCredentials = isCanonicalOpenAiForwardProvider(provider);
        // OAuth passthrough: ChatGPT backend path is `${baseUrl}/responses` (no /v1).
        const baseUrl = mayForwardCallerCredentials
          ? CODEX_FORWARD_BASE_URL
          : provider.baseUrl.replace(/\/+$/, "");
        url = `${baseUrl}/responses`;
        if (provider.headers) Object.assign(headers, provider.headers); // static headers first…
        const runtimeProvider = provider as {
          _codexAccountOverride?: { accessToken: string; chatgptAccountId: string };
          _codexAccountRequired?: boolean;
        };
        if (
          mayForwardCallerCredentials
          && runtimeProvider._codexAccountRequired
          && !runtimeProvider._codexAccountOverride
        ) {
          throw new Error("Codex pool account auth is required but unavailable");
        }
        if (mayForwardCallerCredentials) {
          for (const h of FORWARD_HEADERS) {
            const v = incoming?.headers.get(h);
            if (v) {
              if (h === CODEX_RESPONSES_LITE_HEADER) {
                for (const name of Object.keys(headers)) {
                  if (name.toLowerCase() === h) delete headers[name];
                }
              }
              headers[h] = v; // …so genuine forwarded fields win.
            }
          }
        }
        const override = runtimeProvider._codexAccountOverride;
        if (override && mayForwardCallerCredentials) {
          headers["authorization"] = `Bearer ${override.accessToken}`;
          headers["chatgpt-account-id"] = override.chatgptAccountId;
        }
      } else {
        if (provider.responsesPath === undefined) {
          url = openaiResponsesUrl(provider.baseUrl);
        } else {
          const base = provider.baseUrl.replace(/\/$/, "");
          url = `${base}${provider.responsesPath}`;
        }
        if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
        if (provider.headers) Object.assign(headers, provider.headers);
      }
      // Some Responses-compatible gateways select their Codex compatibility path from the real
      // client fingerprint. This is a single non-credential fallback, not broader caller-header
      // forwarding. Static provider headers remain authoritative in either auth mode.
      applyCallerUserAgentFallback(headers, incoming);
      // Keyless Zen tier admission on the Responses wire (Muse Spark ids route
      // here via the registry wire default). Same gate as the Chat transport:
      // canonical endpoint only, operator-configured values win.
      if (isZenFreeEndpoint(provider.baseUrl)) {
        applyZenFreeIdentity(headers, provider, { parsed, incomingHeaders: incoming?.headers });
      }

      const forward = provider.authMode === "forward";
      let convertedRoutedCustomToolNames: Set<string> | undefined;
      let routedCustomToolRepairNames: Set<string> | undefined;
      let convertedRoutedToolSearchNames: Set<string> | undefined;
      let convertedRoutedNamespaceToolAliases: Map<string, { namespace: string; name: string; kind: "function" | "custom" }> | undefined;
      let plaintextV2AgentMessageToolNames: ReadonlySet<string> | undefined;
      let plaintextV2AgentMessageAliasedToolNames: ReadonlySet<string> | undefined;
      let convertedMuseToolNameAliases: Map<string, string> | undefined;
      const unexpandedMiss = !!parsed.previousResponseId && parsed._previousResponseInputExpanded !== true;
      let outBody = stripPreviousResponseId(
        parsed._rawBody,
        forward || parsed._previousResponseInputExpanded === true,
      );
      if (!forward) outBody = normalizeRoutedAgentMessages(outBody, {
        allowStringContent: isXaiResponsesDestination(provider),
      });
      // #5217: a sub-agent inherits the parent session's instruction block, so the identity
      // sentence this proxy generated for the PARENT's model rides along to a worker running a
      // different one. On a routed destination it is renamed to that destination — including the
      // model-neutral catalog sentence, which this adapter never names itself; on a native/forward
      // destination our sentence is dropped, because Codex's own identity wording (sent in the
      // client's model_switch block) is the correct one there. Text the proxy did not generate —
      // user turns, tool output, fenced code, provider-native blocks — is untouched.
      outBody = repairIdentityInResponsesBody(
        outBody,
        forward ? stripRoutedIdentity : (text: string) => nameRoutedIdentity(text, parsed.modelId),
      );
      outBody = mapRoutedResponsesReasoningEffort(outBody, provider, parsed.modelId);
      // stripPreviousResponseId() intentionally returns its input on a no-op. Detach before the
      // tier write so a force-fast/default decision can never mutate parsed._rawBody.
      outBody = applyTierDecisionToResponsesBody(outBody, parsed.options?.tierDecision);
      const stateless = provider.statelessResponses === true;
      const adjacentToolResults = provider.requiresAdjacentResponsesToolResults === true;
      // Adjacency reorders items the upstream would accept in some order. Pairing synthesizes an
      // item the client never sent, which is a larger claim about the conversation, so it is its
      // own capability: Kimi carries the adjacency flag but accepts a dangling call (#4726) and
      // must not start receiving placeholders it never needed.
      const pairedToolResults = provider.requiresPairedResponsesToolResults === true;
      if (stateless) outBody = stripStatefulResponsesParams(outBody);
      // A replay miss can leave a function_call_output whose paired function_call sat
      // in the prefix that was never expanded. A stateless upstream cannot resolve the
      // pair from its own storage either, so it needs the same repair the forward
      // backend gets — dropping previous_response_id is not much use if the body that
      // reaches the wire is unparseable.
      // A parser can also 400 on a function_call with no matching output at all. DeepSeek gets
      // that repair through statelessResponses. xAI cannot be marked stateless: its Responses API
      // stores conversations for 30 days and documents previous_response_id. So it carries the
      // pairing capability instead, which reuses the orphan-call placeholder without touching
      // store or previous_response_id.
      if (provider.annotateEmptyToolOutputs === true) {
        outBody = annotateEmptyResponsesToolOutputs(outBody, true);
      }
      const synthesizeMissingCallOutputs = !forward && (stateless || pairedToolResults);
      if (forward || stateless || pairedToolResults) {
        // A stateful destination can resolve an output-only delta against the call stored behind
        // an unexpanded previous_response_id. All other shapes have no hidden call to preserve.
        const repairOrphanOutputs = forward || stateless || !unexpandedMiss;
        outBody = repairOrphanedInputItems(
          outBody,
          unexpandedMiss,
          synthesizeMissingCallOutputs,
          repairOrphanOutputs,
        );
      }
      if (provider.dropResponsesReasoningItems === true) {
        outBody = dropResponsesReasoningInputItems(outBody);
      }
      if (adjacentToolResults) {
        outBody = normalizeResponsesToolResultAdjacency(outBody);
      }
      if (forward) {
        // `metadata` is stripped on every forward route for compatibility with the canonical backend.
        // `max_output_tokens` is stripped only when this provider is the canonical backend.
        outBody = stripUnsupportedForwardParams(outBody, isCanonicalOpenAiForwardProvider(provider));
        // Only the canonical ChatGPT backend rejects the canonical-only fields below; a self-hosted
        // or third-party forward gateway may accept them, so this guard must not be widened.
        if (isCanonicalOpenAiForwardProvider(provider)) {
          outBody = stripCanonicalForwardSamplingParams(outBody);
          outBody = stripDeprecatedPromptCacheRetention(outBody, parsed.modelId);
          outBody = stripCanonicalForwardPromptCacheOptions(outBody);
          outBody = normalizeCanonicalForwardPromptEnvelope(outBody);
          outBody = normalizeCanonicalForwardContinuationEnvelope(outBody);
        }
      } else {
        outBody = stripRejectedSamplingParams(outBody, provider, parsed.modelId);
        outBody = preferConfiguredHostedTools(
          outBody,
          provider,
          parsed.modelId,
          parsed._openAiVirtualSelectedModelId,
        );
        outBody = normalizeImageGenClientTools(outBody);
      }
      if (forward || parsed._previousResponseInputExpanded === true) {
        outBody = repairOversizedReplayCallIds(outBody);
      }
      outBody = stripUnsupportedReasoningSummaryDelivery(outBody, parsed.modelId);
      // #4587: on a bridged provider, hand the destination back the search call and result the
      // proxy executed on its behalf, in place of the hosted cell the caller replays. Scoped to
      // its exact conversation and serving identity and recorded by the bridge itself, so a
      // provider without the opt-in computes no identity and keeps the body reference it already
      // had. This runs before query backfill because a restored cell is no longer one to repair.
      if (provider.webSearchBridge?.enabled === true) {
        outBody = restoreBridgedWebSearchCalls(outBody, bridgeSearchReplayScope(parsed._reasoningReplayScope));
      }
      // Repair stored history from before the bridge emitted both keys, in either
      // direction: a conversation that already recorded a web_search_call replays it
      // every turn, and a strict parser rejects the whole request over the missing key —
      // `queries` for DeepSeek (#930), `query` for Console Go (#3071).
      outBody = backfillWebSearchQueries(outBody);
      // #5095: a conversation that already contains a `default.`-prefixed call name is refused by
      // the upstream `^[a-zA-Z0-9_-]+$` name pattern on every later turn that replays it, so the
      // task cannot be compacted or continued at all. Repair the replayed item here, before the
      // canonical-destination split below, because the reported failure was a side chat on a plain
      // OpenAI model inheriting history a routed provider had damaged.
      outBody = repairLegacyDottedToolCallNames(outBody);
      if (!isCanonicalOpenAiForwardProvider(provider)) {
        outBody = stripInternalChatMessageMetadataPassthrough(outBody);
        // The same class of private field, one level up, but keyed on the DESTINATION rather than
        // on the canonical surface alone. `src/server/responses/compact.ts` spreads the caller's
        // raw body into the native `/responses/compact` request without passing through this
        // adapter, and that endpoint is offered only to OpenAI-operated destinations
        // (supportsNativeResponsesCompactEndpoint). Stripping on the canonical predicate here
        // would make the two paths disagree for `openai-apikey`; stripping on the destination
        // keeps every OpenAI-operated route byte-identical and removes the field exactly where it
        // is known to break, which is a gateway this proxy does not operate.
        //
        // Placed before the routed compaction body is built and before serialization, so the HTTP,
        // routed-compaction and WebSocket outbounds are all covered by this one call.
        if (!isOpenAiOperatedResponsesDestination(provider)) {
          outBody = stripCanonicalOnlyTopLevelFields(outBody);
        }
        outBody = promoteClientLoadedTools(outBody);
      }
      if (!isCanonicalOpenAiForwardProvider(provider)) {
        const rewritten = rewriteRoutedCustomToolsForUpstream(
          outBody,
          provider.supportsResponsesCustomTools,
        );
        outBody = rewritten.body;
        convertedRoutedCustomToolNames = rewritten.names;
        routedCustomToolRepairNames = rewritten.repairNames;
      }
      if (!isCanonicalOpenAiForwardProvider(provider)) {
        // Run after custom-tool lowering so the search compatibility layer can choose a
        // collision-free public function name against the final routed function catalog.
        const rewritten = rewriteRoutedToolSearchForUpstream(outBody);
        outBody = rewritten.body;
        convertedRoutedToolSearchNames = rewritten.names;
      }
      if (!isCanonicalOpenAiForwardProvider(provider)) {
        // Codex 0.147 emits private namespace tool groups, while public/third-party Responses
        // gateways accept only flat tool variants. Run after custom/tool-search lowering so
        // namespace children already carry their final public kind before they are promoted.
        const rewritten = rewriteRoutedNamespaceToolsForUpstream(outBody, convertedRoutedCustomToolNames);
        outBody = rewritten.body;
        convertedRoutedNamespaceToolAliases = rewritten.aliases;
        // Preserve xAI's cached-only fail-closed semantics and image-search mapping before the
        // generic capability fallback removes the private OpenAI fields. Grok relayed through
        // OpenCode Go speaks the same dialect, which the final model id and URL identify.
        outBody = normalizeXaiResponsesWebSearch(outBody, provider, { modelId: parsed.modelId, responseUrl: url });
        outBody = injectXaiResponsesXSearch(outBody, provider, parsed._replayPrefixLen);
        // xAI and explicitly classified compatible gateways reject these OpenAI web_search
        // extensions. Keep them for OpenAI API-key traffic and unclassified gateways.
        if (provider.supportsOpenAiWebSearchToolFields === false) {
          outBody = stripOpenAiOnlyWebSearchFields(outBody);
        }
        outBody = stripMuseSparkUnsupportedWebSearchFields(outBody, parsed.modelId, url);
        // Host-only: api.meta.ai rejects function names over 64 chars on every Muse model,
        // including default muse-spark-1.3. Do not reuse the contributor/Zen web_search
        // predicates. Namespace flattening has already produced the public wire names.
        if (isMetaAiResponsesDestination(url)) {
          const rewritten = rewriteMuseToolNamesForUpstream(outBody);
          outBody = rewritten.body;
          convertedMuseToolNameAliases = rewritten.aliases;
        }
        // Last, so promoted namespace children are also cleared of Codex-private fields.
        outBody = stripCanonicalOnlyToolFields(outBody, provider.supportsOpenAiWebSearchToolFields === false);
      }
      if (!forward) {
        outBody = normalizeOpenCodeGoAdditionalTools(outBody, url, parsed._replayPrefixLen);
      }
      // Same predicate as the routedCompaction gate in handleResponses(): an authMode check would
      // let a noncanonical custom forward provider skip this rewrite while the server still routes
      // it as a summarizer turn (#422). The compaction body build removes the tool surface and must
      // therefore be the last routed transform that may depend on those declarations. Structural
      // sanitizers below can still run after it.
      outBody = normalizeResponsesCodeMode(outBody, parsed, provider);
      if (parsed._compactionRequest === true && (!isCanonicalOpenAiForwardProvider(provider) || parsed._portableCompaction === true)) {
        outBody = buildRoutedCompactionBody(outBody);
      }
      // Run after routed compaction so nested input_image parts are replaced before a malformed
      // tool output is flattened to text and can no longer be inspected structurally.
      outBody = repairUnidentifiedToolOutputItems(outBody);
      if (parsed._plaintextV2AgentMessages === true && isCanonicalOpenAiForwardProvider(provider)) {
        const prepared = preparePlaintextV2AgentMessages(outBody);
        outBody = prepared.body;
        if (prepared.namespaceAliased) {
          plaintextV2AgentMessageToolNames = prepared.toolNames;
          plaintextV2AgentMessageAliasedToolNames = prepared.aliasedAgentMessageToolNames;
        }
      }
      const threadServingIdentityChanged = parsed._stripReasoningEncryptedContent === true;
      // Providers with the strict plaintext tool-continuation contract cannot consume any
      // encrypted reasoning blob, including one whose provenance is unknown. Combo routing
      // separately refuses a proven cross-route replay when no plaintext exists; this final
      // serializer guard ensures the foreign opaque state is never forwarded regardless.
      const sanitizedBody = normalizeToolSchemas(
        stripItemIdsWhenUnstored(
          stripInvalidItemIds(
            stripUnsupportedHostedTools(
              sanitizeReasoningInputContent(
                scrubOcxCompactionItems(
                  outBody,
                  destinationDecodesNativeCompactionBlob(provider),
                  threadServingIdentityChanged,
                ),
                {
                  preserveRawReasoningContent: provider.preserveResponsesReasoningContent === true,
                  dropNullContentChannel: !isOpenAiOperatedResponsesDestination(provider),
                  stripEncryptedContent: threadServingIdentityChanged || requiresPlaintextReasoningReplay(provider),
                  dropForeignItemId: parsed._dropForeignReasoningItemIds === true,
                  requirePlaintextReasoning: requiresPlaintextReasoningReplay(provider),
                },
              ),
              provider,
            ),
          ),
          isXaiResponsesDestination(provider),
        ),
        isXaiSchemaTarget(provider),
      );
      const unnormalizedBody = stripDisabledVerbosity(
        stripDisabledReasoningSummaries(
          normalizeConfiguredReasoningSummaryDelivery(sanitizedBody, provider, parsed.modelId),
          provider,
          parsed.modelId,
        ),
        provider,
        parsed.modelId,
      );
      // Normalize the wire model before deriving model-dependent transport metadata.
      let finalBody =
        provider.modelSuffixBracketStrip
          && unnormalizedBody !== null
          && typeof unnormalizedBody === "object"
          && !Array.isArray(unnormalizedBody)
          && typeof (unnormalizedBody as { model?: unknown }).model === "string"
          ? { ...(unnormalizedBody as Record<string, unknown>), model: stripBracketedModelSuffix((unnormalizedBody as { model: string }).model) }
          : unnormalizedBody;
      if (isMetaAiResponsesDestination(url)) {
        const originalChoice = isPlainObject(parsed._rawBody) ? parsed._rawBody.tool_choice : undefined;
        finalBody = normalizeMuseToolChoice(finalBody, originalChoice);
      }
      if (isCanonicalOpenAiForwardProvider(provider)) {
        const routingHeaders = new Headers(headers);
        applyCodexRoutingHint(routingHeaders, finalBody);
        // Static headers may use mixed casing. Remove every stale spelling
        // without normalizing unrelated headers returned by this adapter.
        for (const name of Object.keys(headers)) {
          if (name.toLowerCase() === CODEX_ROUTING_HINT_HEADER) delete headers[name];
        }
        const hint = routingHeaders.get(CODEX_ROUTING_HINT_HEADER);
        if (hint !== null) headers[CODEX_ROUTING_HINT_HEADER] = hint;
      }
      const actualServiceTier = isPlainObject(finalBody) && typeof finalBody.service_tier === "string"
        ? finalBody.service_tier
        : null;
      const tierLog = createAdapterTierMetadata(
        parsed.options?.tierObservation,
        parsed.options?.tierDecision,
        actualServiceTier === null ? null : "service-tier",
        actualServiceTier,
      );
      // The Responses adapter is passthrough: it forwards `parsed._rawBody` rather than
      // rebuilding the body from `parsed.modelId`, and the router writes the routed id into
      // that raw body. So a provider whose upstream rejects bracketed ids has to be honoured
      // here, on the serialized body, not on the parsed selector. One place covers both the
      // HTTP and the WebSocket outbound, because the WS path transports this same request
      // instead of rebuilding it.
      observeOutbound(parsed._rawBody, finalBody, headers);
      if (!isCanonicalOpenAiForwardProvider(provider)) {
        validateFinalCustomToolCompatibility(finalBody, provider.supportsResponsesCustomTools);
      }
      // Keyless Zen tier gate declarations; policy lives in the shared
      // helper, this wire only supplies its tool shape.
      if (isPlainObject(finalBody)) {
        const gated = withZenFreeGateDeclarations(
          provider,
          Array.isArray(finalBody.tools) ? finalBody.tools : undefined,
          item => isPlainObject(item) && typeof item.name === "string" ? item.name : undefined,
          zenFreeGateResponsesTool,
        );
        if (gated !== undefined) (finalBody as Record<string, unknown>).tools = gated;
      }
      const body = JSON.stringify(finalBody);
      const releaseBodyObservation = translatorBudget.observeExternallyCapped(
        "passthrough_serialization",
        Buffer.byteLength(body, "utf8"),
      );
      return {
        url,
        method: "POST",
        headers,
        body,
        releaseBodyObservation,
        ...(convertedRoutedCustomToolNames ? { convertedRoutedCustomToolNames } : {}),
        ...(routedCustomToolRepairNames ? { routedCustomToolRepairNames } : {}),
        ...(convertedRoutedToolSearchNames ? { convertedRoutedToolSearchNames } : {}),
        ...(convertedRoutedNamespaceToolAliases ? { convertedRoutedNamespaceToolAliases } : {}),
        ...(plaintextV2AgentMessageToolNames ? { plaintextV2AgentMessageToolNames } : {}),
        ...(plaintextV2AgentMessageAliasedToolNames ? { plaintextV2AgentMessageAliasedToolNames } : {}),
        ...(convertedMuseToolNameAliases ? { convertedMuseToolNameAliases } : {}),
        ...(tierLog ? { tierLog } : {}),
      };
    },

    // The passthrough normally relays the upstream stream verbatim and never parses.
    // The exception is a routed compaction turn: the server drives this adapter like
    // an ordinary one so the bridge can build the single compaction item (#422).
    async *parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<AdapterEvent> {
      if (!response.body) {
        yield { type: "error", message: "passthrough adapter received no response body" };
        return;
      }
      let deltas = "";
      let deltasBytes = 0;
      let deltasLastCodeUnit = 0;
      let doneText = "";
      let doneTextBytes = 0;
      let doneTextLastCodeUnit = 0;
      let snapshot = "";
      let snapshotBytes = 0;
      let usage: OcxUsage | undefined;
      let usageRawBytes = 0;
      let compactionEncryptedContent: string | undefined;
      let compactionEncryptedContentBytes = 0;
      let completedSeen = false;
      for await (const event of decodeServerSentEvents(response.body, { translatorBudget: budget })) {
        let payload: unknown;
        try { payload = JSON.parse(event.data); } catch { continue; }
        if (!isPlainObject(payload)) continue;
        switch (payload.type) {
          case "response.output_text.delta":
            if (typeof payload.delta === "string") {
              const next = deltas + payload.delta;
              const nextBytes = appendedUtf8Bytes(deltasBytes, deltasLastCodeUnit, payload.delta);
              const reservation = budget.reserveTransient(nextBytes, { kind: "retained_collectors" });
              deltas = next;
              reservation.commitRetained();
              budget.releaseRetained(deltasBytes, { kind: "retained_collectors" });
              deltasBytes = nextBytes;
              if (payload.delta.length > 0) deltasLastCodeUnit = payload.delta.charCodeAt(payload.delta.length - 1);
            }
            break;
          case "response.output_text.done":
            if (typeof payload.text === "string") {
              const next = doneText + payload.text;
              const nextBytes = appendedUtf8Bytes(doneTextBytes, doneTextLastCodeUnit, payload.text);
              const reservation = budget.reserveTransient(nextBytes, { kind: "retained_collectors" });
              doneText = next;
              reservation.commitRetained();
              budget.releaseRetained(doneTextBytes, { kind: "retained_collectors" });
              doneTextBytes = nextBytes;
              if (payload.text.length > 0) doneTextLastCodeUnit = payload.text.charCodeAt(payload.text.length - 1);
            }
            break;
          case "response.failed":
          case "error":
            yield { type: "error", message: responsesErrorMessage(payload.response ?? payload) };
            return;
          case "response.incomplete":
            yield { type: "incomplete", reason: responsesErrorMessage(payload.response ?? payload) };
            return;
          case "response.completed":
            {
              completedSeen = true;
              const responsePayload = isPlainObject(payload.response) ? payload.response : undefined;
              const output = Array.isArray(responsePayload?.output) ? responsePayload.output : [];
              const compaction = output.find(item => isPlainObject(item) && item.type === "compaction");
              if (isPlainObject(compaction) && typeof compaction.encrypted_content === "string") {
                const nextEncryptedContent = compaction.encrypted_content;
                const nextEncryptedContentBytes = Buffer.byteLength(nextEncryptedContent, "utf8");
                const reservation = budget.reserveTransient(nextEncryptedContentBytes, { kind: "retained_collectors" });
                compactionEncryptedContent = nextEncryptedContent;
                reservation.commitRetained();
                budget.releaseRetained(compactionEncryptedContentBytes, { kind: "retained_collectors" });
                compactionEncryptedContentBytes = nextEncryptedContentBytes;
              }
              const next = responsesPayloadText(payload.response);
              const nextBytes = Buffer.byteLength(next, "utf8");
              const reservation = budget.reserveTransient(nextBytes, { kind: "retained_collectors" });
              snapshot = next;
              reservation.commitRetained();
              budget.releaseRetained(snapshotBytes, { kind: "retained_collectors" });
              snapshotBytes = nextBytes;
            }
            {
              const nextUsage = usageFromResponsesPayload(payload.response);
              // The attached raw usage object can be event-sized (unknown keys carry arbitrary
              // values); it stays reachable until the terminal yields, so charge it like the
              // adjacent retained collectors or it would defeat the per-request memory cap.
              const nextRawBytes = nextUsage?.rawUsage === undefined ? 0
                : Buffer.byteLength(JSON.stringify(nextUsage.rawUsage), "utf8");
              if (nextRawBytes > 0) {
                const reservation = budget.reserveTransient(nextRawBytes, { kind: "retained_collectors" });
                usage = nextUsage;
                reservation.commitRetained();
              } else {
                usage = nextUsage;
              }
              if (usageRawBytes > 0) {
                budget.releaseRetained(usageRawBytes, { kind: "retained_collectors" });
              }
              usageRawBytes = nextRawBytes;
            }
            break;
        }
        // Buffered text is still upstream progress, but gateway keepalives are not.
        // Yield after accounting, directly to the consumer: no progress queue or content leak.
        if (
          !completedSeen
          && (payload.type === "response.output_text.delta"
            || payload.type === "response.reasoning_summary_text.delta"
            || payload.type === "response.reasoning_text.delta")
          && typeof payload.delta === "string"
          && payload.delta.length > 0
        ) {
          yield { type: "heartbeat" };
        }
      }
      // Gateways differ in which of these they emit; prefer the authoritative
      // completed snapshot so text is never double-counted.
      const text = snapshot || doneText || deltas;
      if (text) yield { type: "text_delta", text };
      budget.releaseRetained(
        deltasBytes + doneTextBytes + snapshotBytes + usageRawBytes,
        { kind: "retained_collectors" },
      );
      yield {
        type: "done",
        ...(usage ? { usage } : {}),
        ...(compactionEncryptedContent ? { compactionEncryptedContent } : {}),
      };
    },

    async parseResponse(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]> {
      let payload: unknown;
      try { payload = await response.json(); } catch {
        return [{ type: "error", message: "malformed upstream compaction response" }];
      }
      budget.chargeRetained(Buffer.byteLength(JSON.stringify(payload), "utf8"), { kind: "retained_collectors" });
      if (!isPlainObject(payload)) {
        return [{ type: "error", message: "malformed upstream compaction response" }];
      }
      if (payload.error || payload.status === "failed") {
        return [{ type: "error", message: responsesErrorMessage(payload) }];
      }
      if (payload.status === "incomplete") {
        return [{ type: "incomplete", reason: responsesErrorMessage(payload) }];
      }
      const usage = usageFromResponsesPayload(payload);
      const output = Array.isArray(payload.output) ? payload.output : [];
      const compaction = output.find(item => isPlainObject(item) && item.type === "compaction");
      const compactionEncryptedContent = isPlainObject(compaction) && typeof compaction.encrypted_content === "string"
        ? compaction.encrypted_content
        : undefined;
      const text = responsesPayloadText(payload);
      if (!text && !compactionEncryptedContent) {
        // A completed turn with neither text nor a native compaction blob cannot become a
        // replacement-history item. A ciphertext-only native completion is valid, though.
        return [{ type: "error", message: "upstream compaction returned no summary text" }];
      }
      return [...(text ? [{ type: "text_delta" as const, text }] : []), {
        type: "done",
        ...(usage ? { usage } : {}),
        ...(compactionEncryptedContent ? { compactionEncryptedContent } : {}),
      }];
    },
  };
}
