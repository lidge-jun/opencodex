import { openAIChatTransport, stripBracketedModelSuffix } from "./wire";
import type { AdapterRequest } from "../base";
import { frameAgentRouterMessages } from "../agentrouter";
import { openRouterProviderPayload, resolveOpenRouterRouting } from "../../providers/openrouter-routing";
import { resolveVercelGatewayRouting, vercelGatewayProviderPayload } from "../../providers/vercel-gateway-routing";
import { fastPolicyForModel } from "../../providers/service-tier";
import { canonicalFastTierMarker, decideTier, type ResolvedFastPolicy } from "../../providers/fastwire";
import { debugProviderDiagnostic } from "../../lib/debug";
import { isDebugEnabled } from "../../lib/debug-settings";
import { modelRecordValue } from "../../reasoning-effort";
import { modelInList, type OcxProviderConfig } from "../../types";

const CHAT_PASSTHROUGH_FIELDS = [
  "audio",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "max_completion_tokens",
  "max_tokens",
  "metadata",
  "modalities",
  "n",
  "prediction",
  "presence_penalty",
  "reasoning_effort",
  "response_format",
  "seed",
  "stop",
  "store",
  "temperature",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p",
  "user",
  "web_search_options",
] as const;

/**
 * Build a provider request from an inbound Chat Completions body without translating it
 * through the Responses contract. This is deliberately a whitelist: Chat-only caller
 * fields retain their exact wire representation, while provider capability gates remain
 * centralized beside the ordinary openai-chat adapter.
 */
export function buildOpenAIChatPassthroughRequest(
  provider: OcxProviderConfig,
  rawBody: Record<string, unknown>,
  modelId: string,
  stream: boolean,
  fastPolicy: ResolvedFastPolicy = fastPolicyForModel(provider, modelId, undefined, "chat"),
  fastMode?: boolean,
): AdapterRequest {
  const { url, headers, hasCredential } = openAIChatTransport(provider);

  const body: Record<string, unknown> = {
    model: provider.modelSuffixBracketStrip ? stripBracketedModelSuffix(modelId) : modelId,
    messages: frameAgentRouterMessages(provider.baseUrl, rawBody.messages),
    stream,
  };
  for (const field of CHAT_PASSTHROUGH_FIELDS) {
    if (rawBody[field] !== undefined) body[field] = rawBody[field];
  }
  const rawEfforts = modelRecordValue(provider.modelReasoningEfforts, modelId) ?? provider.reasoningEfforts;
  if (modelInList(provider.noReasoningModels, modelId) || rawEfforts?.length === 0) {
    delete body.reasoning_effort;
  }

  const openRouterRouting = resolveOpenRouterRouting(provider, modelId);
  if (openRouterRouting) body.provider = openRouterProviderPayload(openRouterRouting);
  const vercelRouting = resolveVercelGatewayRouting(provider, modelId);
  if (vercelRouting) body.provider = vercelGatewayProviderPayload(vercelRouting);

  if (modelInList(provider.noTemperatureModels, modelId)) delete body.temperature;
  if (modelInList(provider.noTopPModels, modelId)) delete body.top_p;
  if (modelInList(provider.noPenaltyModels, modelId)) {
    delete body.presence_penalty;
    delete body.frequency_penalty;
  }
  // Exact match, unlike the gates above: `noStructuredOutputModels` is documented as
  // "only an exact requested-model match omits the field" (#1424), and the Responses
  // ingress enforces exactly that. A prefix match here would strip response_format from
  // `<listed>:<tag>` siblings the operator never opted out, silently returning prose.
  if (provider.noStructuredOutputModels?.includes(modelId)) delete body.response_format;
  // Narrower neighbour: the model takes `json_object` but rejects `json_schema`. Downgrade
  // rather than drop, so a caller that asked for JSON still gets JSON. The type check also
  // makes the kill switch above win without an else — after its `delete` there is no type
  // left to match.
  const passthroughFormat = body.response_format;
  if (provider.noJsonSchemaModels?.includes(modelId)
      && typeof passthroughFormat === "object" && passthroughFormat !== null
      && (passthroughFormat as { type?: unknown }).type === "json_schema") {
    body.response_format = { type: "json_object" };
  }

  // Run the same complete Fast policy as the translated Chat path, including explicit
  // fastMode and foreign-tier handling. On inherited canonical Fast, the passthrough still
  // retains the caller's exact spelling; forced Fast uses the policy-owned wire value.
  const callerTier = typeof rawBody.service_tier === "string" ? rawBody.service_tier : undefined;
  const tierDecision = decideTier(fastPolicy, fastMode, callerTier);
  if (tierDecision.kind === "set") {
    body.service_tier = fastMode === undefined && canonicalFastTierMarker(callerTier) !== undefined
      ? callerTier
      : tierDecision.value;
  } else if (tierDecision.kind === "forward-caller" && rawBody.service_tier !== undefined) {
    body.service_tier = rawBody.service_tier;
  }
  if (provider.promptCacheKey && rawBody.prompt_cache_key !== undefined) {
    body.prompt_cache_key = rawBody.prompt_cache_key;
  }
  if (Array.isArray(rawBody.tools) && rawBody.tools.length > 0) {
    if (provider.parallelToolCalls === true) {
      body.parallel_tool_calls = rawBody.parallel_tool_calls !== false;
    } else if (provider.parallelToolCalls === false
        && (provider.baseUrl === "https://integrate.api.nvidia.com/v1" || provider.pinParallelToolCallsFalse === true)) {
      body.parallel_tool_calls = false;
    }
  }
  if (stream) {
    const callerOptions = rawBody.stream_options !== null
        && typeof rawBody.stream_options === "object"
        && !Array.isArray(rawBody.stream_options)
      ? rawBody.stream_options as Record<string, unknown>
      : {};
    body.stream_options = { ...callerOptions, include_usage: true };
  } else if (rawBody.stream_options !== undefined) {
    body.stream_options = rawBody.stream_options;
  }

  const bodyJson = JSON.stringify(body);

  if (isDebugEnabled()) {
    let host = "upstream";
    try { host = new URL(url).host; } catch { /* keep fallback */ }
    debugProviderDiagnostic("openai-chat", "passthrough-request", {
      host,
      model: body.model,
      stream,
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      hasCredential,
      bodyBytes: Buffer.byteLength(bodyJson, "utf8"),
    });
  }

  return { url, method: "POST", headers, body: bodyJson };
}
